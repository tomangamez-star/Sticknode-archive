'use strict';

const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const scraper = require('./scraper');
const { htmlEscape } = require('./utils');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function intArg(name, fallback, min = 0, max = 1000) {
  const value = Number.parseInt(arg(name, String(fallback)), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
function boolArg(name, fallback = true) {
  const raw = String(arg(name, fallback ? 'true' : 'false')).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
function modeArgs() {
  const mode = String(arg('mode', 'backfill')).trim().toLowerCase();
  const backfillPages = intArg('backfill-pages', 25, 0, 500);
  const recentPages = intArg('recent-pages', 3, 0, 20);
  if (mode === 'recent') return { mode, backfillPages: 0, recentPages };
  if (mode === 'both') return { mode, backfillPages, recentPages };
  return { mode: 'backfill', backfillPages, recentPages: 0 };
}
async function notify(bot, text) {
  const chatId = String(process.env.INGEST_NOTIFICATION_CHAT_ID || '').trim();
  if (!chatId) return;
  try { await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (error) { console.warn('[ingest] notification failed:', error.message || error); }
}
function appendGithubSummary(result, options) {
  const target = String(process.env.GITHUB_STEP_SUMMARY || '').trim();
  if (!target) return;
  const lines = [
    '# Stick Nodes archive ingestion', '',
    `- Mode: **${options.mode}**`,
    `- Pages processed: **${Number(result.pages || 0)}**`,
    `- Archived: **${Number(result.archived || 0)}**`,
    `- Skipped: **${Number(result.skipped || 0)}**`,
    `- Duplicates: **${Number(result.duplicate || 0)}**`,
    `- Failed: **${Number(result.failed || 0)}**`,
    `- Backfill next page: **${Number(result.backfillNextPage || 1)}**`,
    `- Backfill complete: **${result.backfillComplete ? 'yes' : 'no'}**`, '',
  ];
  fs.appendFileSync(target, lines.join('\n'));
}
async function runWithLockWait(options) {
  const maxWaitSeconds = intArg('lock-wait-seconds', 300, 0, 1800);
  const started = Date.now();
  while (true) {
    const result = await scraper.runCycle(options);
    if (!result || !result.alreadyRunning) return result;
    if ((Date.now() - started) / 1000 >= maxWaitSeconds) return result;
    console.log('[ingest] another scraper owns the DB lock; retrying in 20 seconds');
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
}

async function main() {
  for (const [name, value] of [['DATABASE_URL', config.databaseUrl], ['TELEGRAM_TOKEN', config.telegramToken], ['ARCHIVE_CHAT_ID', config.archiveChatId]]) {
    if (!value) throw new Error(`${name} is required`);
  }

  const options = modeArgs();
  options.retryFailures = boolArg('retry-failures', true) ? intArg('retry-limit', 20, 0, 100) : 0;
  const startPage = intArg('start-page', 0, 0, 1_000_000);

  await db.init();
  if (startPage > 0) {
    await db.updateState({ backfill_next_page: startPage, backfill_complete: false });
    console.log(`[ingest] backfill cursor manually set to page ${startPage}`);
  }

  const bot = new TelegramBot(config.telegramToken, { polling: false });
  scraper.attachBot(bot);
  const me = await bot.getMe();
  console.log(`[ingest] authenticated as @${me.username}`);

  await notify(bot, [
    '<b>📦 Stick Nodes ingestion started</b>',
    `Mode: <b>${htmlEscape(options.mode)}</b>`,
    options.backfillPages ? `Backfill pages: <b>${options.backfillPages}</b>` : '',
    options.recentPages ? `Recent pages: <b>${options.recentPages}</b>` : '',
    startPage > 0 ? `Starting page override: <b>${startPage}</b>` : '',
  ].filter(Boolean).join('\n'));

  const result = await runWithLockWait(options);
  if (result && result.alreadyRunning) {
    appendGithubSummary({ ...result, pages: 0 }, options);
    throw new Error('Another scraper run still owns the Postgres advisory lock. Re-run the workflow after it finishes.');
  }

  console.log('[ingest] complete:', JSON.stringify(result));
  appendGithubSummary(result || {}, options);
  await notify(bot, [
    '<b>✅ Stick Nodes ingestion finished</b>',
    `Archived: <b>${Number(result.archived || 0)}</b>`,
    `Skipped: <b>${Number(result.skipped || 0)}</b>`,
    `Duplicates: <b>${Number(result.duplicate || 0)}</b>`,
    `Failed: <b>${Number(result.failed || 0)}</b>`,
    `Backfill next page: <b>${Number(result.backfillNextPage || 1)}</b>`,
    `Complete: <b>${result.backfillComplete ? 'yes' : 'no'}</b>`,
  ].join('\n'));
}

main().catch(async (error) => {
  console.error('[ingest fatal]', error);
  try {
    if (config.telegramToken) {
      const bot = new TelegramBot(config.telegramToken, { polling: false });
      await notify(bot, `❌ <b>Stick Nodes ingestion failed</b>\n<code>${htmlEscape(error.message || error)}</code>`);
    }
  } catch (_) {}
  process.exitCode = 1;
}).finally(async () => {
  await db.close().catch(() => {});
});
