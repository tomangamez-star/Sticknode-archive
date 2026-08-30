'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const db = require('./db');
const telegram = require('./telegram');
const scraper = require('./scraper');
const { htmlEscape } = require('./utils');

let remoteJob = null;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function authorized(req) {
  if (!config.ingestApiSecret) return false;
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(auth.slice(7));
  const expected = Buffer.from(config.ingestApiSecret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
async function notifyIngest(text) {
  const chatId = config.ingestNotificationChatId;
  const bot = telegram.getBot();
  if (!chatId || !bot) return;
  try { await bot.sendMessage(chatId, text, { parse_mode:'HTML', disable_web_page_preview:true }); }
  catch (error) { console.warn('[remote-ingest] notification failed:', error.message || error); }
}
function publicJob(job) {
  if (!job) return { status:'idle' };
  return {
    id: job.id, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt || null, options: job.options, result: job.result || null,
    error: job.error || '',
  };
}
function startRemoteIngest(options) {
  const job = {
    id: crypto.randomBytes(8).toString('hex'), status:'running', createdAt:new Date().toISOString(),
    startedAt:new Date().toISOString(), finishedAt:null, options, result:null, error:'',
  };
  remoteJob = job;
  void (async () => {
    try {
      await notifyIngest([
        '<b>📦 Render ingestion started</b>',
        `Mode: <b>${htmlEscape(options.mode)}</b>`,
        options.backfillPages ? `Backfill pages: <b>${options.backfillPages}</b>` : '',
        options.recentPages ? `Recent pages: <b>${options.recentPages}</b>` : '',
      ].filter(Boolean).join('\n'));
      const result = await scraper.runCycle(options);
      job.result = result || {};
      job.status = result && result.alreadyRunning ? 'busy' : 'completed';
      await notifyIngest([
        '<b>✅ Render ingestion finished</b>',
        `Archived: <b>${Number(result?.archived || 0)}</b>`,
        `Skipped: <b>${Number(result?.skipped || 0)}</b>`,
        `Duplicates: <b>${Number(result?.duplicate || 0)}</b>`,
        `Failed: <b>${Number(result?.failed || 0)}</b>`,
        `Next page: <b>${Number(result?.backfillNextPage || 1)}</b>`,
      ].join('\n'));
    } catch (error) {
      job.status = 'failed';
      job.error = String(error.message || error).slice(0, 2000);
      console.error('[remote-ingest] failed:', error);
      await notifyIngest(`❌ <b>Render ingestion failed</b>\n<code>${htmlEscape(job.error)}</code>`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
}

async function main() {
  for (const [name, value] of [['DATABASE_URL', config.databaseUrl], ['TELEGRAM_TOKEN', config.telegramToken], ['ARCHIVE_CHAT_ID', config.archiveChatId]]) {
    if (!value) throw new Error(`${name} is required`);
  }
  await db.init();
  await telegram.start();

  const app = express();
  app.use(express.json({ limit:'32kb' }));
  app.get('/', async (_req, res) => {
    try {
      const stats = await db.stats();
      res.type('text/plain').send(`Stick Nodes Archive Bot\nfiles=${stats.total}\nscraper_running=${scraper.isRunning()}\n`);
    } catch (_) { res.type('text/plain').send('Stick Nodes Archive Bot'); }
  });
  app.get('/health', (_req, res) => res.status(200).json({ ok:true, scraperRunning:scraper.isRunning() }));

  // Protected endpoint used by GitHub Actions. It returns immediately; Render
  // continues the ingestion in-process while GitHub polls the status endpoint.
  app.post('/admin/ingest', async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    if (scraper.isRunning() || (remoteJob && remoteJob.status === 'running')) {
      return res.status(409).json({ ok:false, error:'scraper_busy', job:publicJob(remoteJob) });
    }
    const modeRaw = String(req.body?.mode || 'backfill').toLowerCase();
    const mode = ['backfill','recent','both'].includes(modeRaw) ? modeRaw : 'backfill';
    const requestedBackfill = clampInt(req.body?.backfillPages, 25, 0, 100);
    const requestedRecent = clampInt(req.body?.recentPages, 3, 0, 20);
    const options = {
      mode,
      backfillPages: mode === 'recent' ? 0 : requestedBackfill,
      recentPages: mode === 'backfill' ? 0 : requestedRecent,
      retryFailures: req.body?.retryFailures === false ? 0 : clampInt(req.body?.retryLimit, 20, 0, 100),
    };
    const startPage = clampInt(req.body?.startPage, 0, 0, 1_000_000);
    if (startPage > 0) {
      await db.updateState({ backfill_next_page:startPage, backfill_complete:false });
      console.log(`[remote-ingest] backfill cursor manually set to page ${startPage}`);
    }
    const job = startRemoteIngest(options);
    return res.status(202).json({ ok:true, job:publicJob(job) });
  });

  app.get('/admin/ingest/status', (req, res) => {
    if (!authorized(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
    const requested = String(req.query.job || '');
    if (requested && (!remoteJob || requested !== remoteJob.id)) return res.status(404).json({ ok:false, error:'job_not_found' });
    return res.json({ ok:true, scraperRunning:scraper.isRunning(), job:publicJob(remoteJob) });
  });

  const server = app.listen(config.port, '0.0.0.0', () => console.log(`[web] listening on :${config.port}`));
  const stopScheduler = scraper.startScheduler();

  const shutdown = async (signal) => {
    console.log(`[app] ${signal}; shutting down`);
    stopScheduler();
    try { if (telegram.getBot()) await telegram.getBot().stopPolling(); } catch (_) {}
    await new Promise((resolve) => server.close(resolve));
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => { console.error('[fatal]', error); process.exit(1); });
