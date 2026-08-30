'use strict';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function intArg(name, fallback, min, max) {
  const n = Number.parseInt(arg(name, String(fallback)), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function boolArg(name, fallback = true) {
  return ['1','true','yes','on'].includes(String(arg(name, fallback ? 'true' : 'false')).toLowerCase());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, secret, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization:`Bearer ${secret}`, 'Content-Type':'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  let body = {};
  try { body = await response.json(); } catch (_) { body = { error:await response.text().catch(() => '') }; }
  return { response, body };
}

async function main() {
  const base = String(process.env.RENDER_INGEST_URL || '').replace(/\/+$/, '');
  const secret = String(process.env.RENDER_INGEST_SECRET || '');
  if (!base) throw new Error('RENDER_INGEST_URL secret is required');
  if (!secret) throw new Error('RENDER_INGEST_SECRET secret is required');

  const payload = {
    mode: arg('mode', 'backfill'),
    backfillPages: intArg('backfill-pages', 25, 0, 100),
    recentPages: intArg('recent-pages', 3, 0, 20),
    retryFailures: boolArg('retry-failures', true),
    retryLimit: intArg('retry-limit', 20, 0, 100),
    startPage: intArg('start-page', 0, 0, 1_000_000),
  };

  // Render may be doing its small scheduled recent sync. Wait until it is free.
  let started;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const { response, body } = await request(`${base}/admin/ingest`, secret, { method:'POST', body:JSON.stringify(payload) });
    if (response.status === 202) { started = body; break; }
    if (response.status === 409) {
      console.log(`[trigger] Render scraper busy; retry ${attempt}/30 in 20s`);
      await sleep(20_000);
      continue;
    }
    throw new Error(`Render trigger failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  if (!started?.job?.id) throw new Error('Render remained busy for 10 minutes; run the workflow again.');

  const jobId = started.job.id;
  console.log(`[trigger] Render job started: ${jobId}`);
  console.log(`[trigger] mode=${payload.mode} backfillPages=${payload.backfillPages} recentPages=${payload.recentPages}`);

  for (let poll = 1; poll <= 990; poll += 1) { // up to ~5.5 hours
    await sleep(20_000);
    const { response, body } = await request(`${base}/admin/ingest/status?job=${encodeURIComponent(jobId)}`, secret);
    if (!response.ok) throw new Error(`Status check failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    const job = body.job || {};
    if (poll === 1 || poll % 3 === 0) console.log(`[trigger] status=${job.status || 'unknown'} scraperRunning=${body.scraperRunning}`);
    if (job.status === 'completed') {
      console.log('[trigger] completed:', JSON.stringify(job.result || {}));
      const r = job.result || {};
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        require('fs').appendFileSync(summary, [
          '# Stick Nodes Render ingestion','',
          `- Archived: **${Number(r.archived || 0)}**`,
          `- Skipped: **${Number(r.skipped || 0)}**`,
          `- Duplicates: **${Number(r.duplicate || 0)}**`,
          `- Failed: **${Number(r.failed || 0)}**`,
          `- Pages processed: **${Number(r.pages || 0)}**`,
          `- Backfill next page: **${Number(r.backfillNextPage || 1)}**`,
          `- Backfill complete: **${r.backfillComplete ? 'yes' : 'no'}**`, '',
        ].join('\n'));
      }
      return;
    }
    if (job.status === 'failed') throw new Error(`Render ingestion failed: ${job.error || 'unknown error'}`);
    if (job.status === 'busy') throw new Error('Render ingestion could not acquire the database scraper lock. Re-run the workflow.');
  }
  throw new Error('Timed out waiting for Render ingestion to finish.');
}

main().catch((error) => { console.error('[trigger fatal]', error.message || error); process.exit(1); });
