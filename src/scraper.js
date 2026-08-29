'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { parseListing, parseDetail } = require('./parser');
const { sleep, clean, sha256, filenameFromUrl, fileTypeOf, tagsFromTitle, htmlEscape, formatBytes } = require('./utils');

const USER_AGENT = 'StickNodesArchiveBot/1.0 (+private preservation archive; respectful rate limits)';
let bot = null;
let runningPromise = null;

function attachBot(instance) { bot = instance; }
function pageUrl(page) {
  const url = new URL(config.listUrl);
  if (Number(page) > 1) url.searchParams.set('wpfb_list_page', String(page));
  else url.searchParams.delete('wpfb_list_page');
  return url.href;
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...options,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...(options.headers || {}) },
        signal: AbortSignal.timeout(options.timeoutMs || 30000),
      });
      if (response.status === 429) {
        const retry = Math.max(2, Number(response.headers.get('retry-after') || 3));
        await sleep(retry * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await sleep(1000 * (i + 1));
    }
  }
  throw last || new Error('request failed');
}
async function fetchText(url) {
  const response = await fetchWithRetry(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
  return response.text();
}
function contentDispositionFilename(header) {
  const raw = String(header || '');
  let m = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) { try { return decodeURIComponent(m[1].replace(/["']/g, '')); } catch (_) {} }
  m = raw.match(/filename="([^"]+)"/i) || raw.match(/filename=([^;]+)/i);
  return m ? clean(m[1]).replace(/^['"]|['"]$/g, '') : '';
}
async function downloadFile(item) {
  const response = await fetchWithRetry(item.download_url, { headers: { Accept: 'application/octet-stream,application/zip,*/*' }, timeoutMs: 60000 });
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > config.maxFileBytes) throw new Error(`file too large (${formatBytes(declared)} > ${formatBytes(config.maxFileBytes)})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > config.maxFileBytes) throw new Error(`file too large (${formatBytes(buffer.length)} > ${formatBytes(config.maxFileBytes)})`);
  const filename = contentDispositionFilename(response.headers.get('content-disposition')) || item.original_filename || filenameFromUrl(response.url || item.download_url);
  return { buffer, filename, contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

function archiveCaption(item) {
  const tags = (item.tags || []).slice(0, 8).map((t) => `#${String(t).replace(/[^a-z0-9_]+/gi, '')}`).filter((x) => x.length > 1).join(' ');
  const lines = [
    `📦 <b>${htmlEscape(item.title)}</b>`,
    `🗂 ${htmlEscape(item.file_type)} → ${htmlEscape(item.category)}`,
    item.creator ? `👤 ${htmlEscape(item.creator)}${item.creator_handle ? ` ${htmlEscape(item.creator_handle)}` : ''}` : '',
    `📄 <code>${htmlEscape(item.original_filename)}</code>`,
    item.source_date ? `📅 ${htmlEscape(item.source_date)}` : '',
    tags ? `🏷 ${htmlEscape(tags)}` : '',
    item.detail_url ? `🔗 <a href="${htmlEscape(item.detail_url)}">Original page</a>` : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1000);
}

async function uploadToTelegram(item, buffer, contentType) {
  if (!bot) throw new Error('scraper Telegram bot is not attached');
  if (!config.archiveChatId) throw new Error('ARCHIVE_CHAT_ID is required');
  const message = await bot.sendDocument(config.archiveChatId, buffer, {
    caption: archiveCaption(item), parse_mode: 'HTML', disable_content_type_detection: false,
  }, {
    filename: item.original_filename,
    contentType: contentType || 'application/octet-stream',
  });
  const doc = message.document || {};
  if (!doc.file_id) throw new Error('Telegram returned no document file_id');
  return {
    telegram_file_id: doc.file_id,
    telegram_file_unique_id: doc.file_unique_id || '',
    telegram_message_id: Number(message.message_id || 0),
    archive_chat_id: Number(config.archiveChatId),
  };
}

async function hydrateDetail(item) {
  if (!config.fetchDetails || !item.detail_url) return item;
  await sleep(config.siteDelayMs);
  const html = await fetchText(item.detail_url);
  return parseDetail(html, item.detail_url, item);
}

async function processItem(seed, page) {
  const existing = await db.getBySource(seed.source_url);
  if (existing && existing.telegram_file_id) return { status: 'skipped', file: existing };
  let item = seed;
  try {
    item = await hydrateDetail(seed);
    await sleep(config.siteDelayMs);
    const downloaded = await downloadFile(item);
    item.original_filename = downloaded.filename || item.original_filename;
    item.file_type = fileTypeOf(item.original_filename, item.title);
    if (item.file_type === 'pack') item.category = 'packs';
    item.tags = [...new Set([...(item.tags || []), ...tagsFromTitle(item.title, item.category, item.file_type)])];
    item.actual_size_bytes = downloaded.buffer.length;
    item.sha256 = sha256(downloaded.buffer);

    const duplicate = await db.getByHash(item.sha256);
    if (duplicate && duplicate.telegram_file_id) {
      await db.addAlias(item.source_url, duplicate.id);
      await db.clearFailure(item.source_url);
      return { status: 'duplicate', file: duplicate };
    }

    const archived = await uploadToTelegram(item, downloaded.buffer, downloaded.contentType);
    await sleep(config.uploadDelayMs);
    const saved = await db.saveFile({ ...item, ...archived });
    await db.clearFailure(item.source_url);
    return { status: 'archived', file: saved };
  } catch (error) {
    await db.recordFailure(item, page, error.message || error);
    return { status: 'failed', error };
  }
}

async function scrapePage(page) {
  const url = pageUrl(page);
  console.log(`[scraper] listing page ${page}: ${url}`);
  const html = await fetchText(url);
  const items = parseListing(html, url);
  if (!items.length) return { page, empty: true, archived: 0, skipped: 0, failed: 0, duplicate: 0, count: 0 };
  let archived = 0, skipped = 0, failed = 0, duplicate = 0;
  for (const item of items) {
    const result = await processItem(item, page);
    if (result.status === 'archived') archived += 1;
    else if (result.status === 'failed') failed += 1;
    else if (result.status === 'duplicate') duplicate += 1;
    else skipped += 1;
    console.log(`[scraper] ${result.status}: ${item.original_filename}`);
  }
  return { page, empty: false, archived, skipped, failed, duplicate, count: items.length };
}

async function runInternal(options = {}) {
  const locked = await db.tryScrapeLock();
  if (!locked) return { ok: false, alreadyRunning: true, message: 'Another scraper run already holds the database lock.' };
  const runId = crypto.randomBytes(6).toString('hex');
  const totals = { archived: 0, skipped: 0, failed: 0, duplicate: 0, pages: 0 };
  try {
    const state = await db.getState();
    await db.updateState({ status: 'running', run_id: runId, run_started_at: new Date(), run_finished_at: null,
      archived_latest: 0, skipped_latest: 0, failed_latest: 0, pages_completed_latest: 0, last_error: '', heartbeat_at: new Date() });

    // Retry a small number of previously failed files every cycle so a transient
    // Telegram/site error never leaves a permanent hole in the archive.
    const retryLimit = Math.max(0, Math.min(100, Number(options.retryFailures ?? 10)));
    const retryRows = retryLimit > 0 ? await db.listFailures(retryLimit) : [];
    for (const failure of retryRows) {
      const filename = filenameFromUrl(failure.source_url);
      const seed = {
        source_url: failure.source_url, download_url: failure.source_url, detail_url: failure.detail_url || '', source_page: '',
        title: filename.replace(/\.(nodes|nodemc|stk|zip)$/i, '').replace(/[-_]+/g, ' '), original_filename: filename,
        file_type: fileTypeOf(filename), category: 'miscellaneous', categories: ['miscellaneous'],
        tags: tagsFromTitle(filename, 'miscellaneous', fileTypeOf(filename)), creator: '', creator_handle: '', description: '',
        source_date: '', source_hits: 0, pack_count: 0, declared_size_bytes: 0,
      };
      const result = await processItem(seed, Number(failure.gallery_page || 0));
      if (result.status === 'archived') totals.archived += 1;
      else if (result.status === 'duplicate') totals.duplicate += 1;
      else if (result.status === 'skipped') totals.skipped += 1;
      else totals.failed += 1;
    }

    const recentPages = Math.max(0, Number(options.recentPages ?? config.recentPages));
    for (let page = 1; page <= recentPages; page += 1) {
      await db.updateState({ current_page: page, heartbeat_at: new Date() });
      const result = await scrapePage(page);
      totals.archived += result.archived; totals.skipped += result.skipped; totals.failed += result.failed; totals.duplicate += result.duplicate; totals.pages += 1;
    }

    let next = Math.max(1, Number(state.backfill_next_page || 1));
    let complete = Boolean(state.backfill_complete);
    const batch = Math.max(0, Number(options.backfillPages ?? config.backfillPagesPerCycle));
    if (!complete && batch > 0) {
      for (let i = 0; i < batch; i += 1) {
        const page = next;
        await db.updateState({ current_page: page, heartbeat_at: new Date() });
        const result = await scrapePage(page);
        if (result.empty) {
          complete = true;
          await db.updateState({ backfill_complete: true, current_page: page, last_success_at: new Date() });
          console.log(`[scraper] backfill complete at empty page ${page}`);
          break;
        }
        totals.archived += result.archived; totals.skipped += result.skipped; totals.failed += result.failed; totals.duplicate += result.duplicate; totals.pages += 1;
        next = page + 1;
        await db.updateState({ backfill_next_page: next, pages_completed_latest: totals.pages,
          archived_latest: totals.archived, skipped_latest: totals.skipped + totals.duplicate, failed_latest: totals.failed,
          last_success_at: new Date(), heartbeat_at: new Date() });
      }
    }

    await db.updateState({ status: complete ? 'complete' : 'waiting', run_finished_at: new Date(), heartbeat_at: new Date(),
      pages_completed_latest: totals.pages, archived_latest: totals.archived, skipped_latest: totals.skipped + totals.duplicate,
      failed_latest: totals.failed, last_error: '' });
    return { ok: true, runId, ...totals, backfillNextPage: next, backfillComplete: complete };
  } catch (error) {
    await db.updateState({ status: 'stalled', run_finished_at: new Date(), heartbeat_at: new Date(), last_error: String(error.message || error).slice(0, 1000) }).catch(() => {});
    throw error;
  } finally {
    await db.releaseScrapeLock();
  }
}

function runCycle(options = {}) {
  if (runningPromise) return runningPromise;
  runningPromise = runInternal(options).finally(() => { runningPromise = null; });
  return runningPromise;
}
function isRunning() { return Boolean(runningPromise); }

function startScheduler() {
  if (!config.autoRun) { console.log('[scraper] automatic scheduler disabled'); return () => {}; }
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runCycle();
      console.log('[scraper] cycle finished', result);
    } catch (error) {
      console.error('[scraper] cycle failed:', error);
    }
    if (!stopped) timer = setTimeout(tick, config.intervalMinutes * 60_000);
  };
  timer = setTimeout(tick, 5000);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

module.exports = { attachBot, pageUrl, fetchText, downloadFile, processItem, scrapePage, runCycle, isRunning, startScheduler, archiveCaption };
