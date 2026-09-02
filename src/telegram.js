'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const scraper = require('./scraper');
const ui = require('./ui');
const { htmlEscape, formatBytes } = require('./utils');

let bot = null;
let accessMode = 'private';

const STICKNODES_TOTAL_PAGES = Math.max(1, Number(process.env.STICKNODES_TOTAL_PAGES || 3101));

function secondsBetween(a, b = new Date()) {
  if (!a) return 0;
  const start = new Date(a).getTime();
  const end = new Date(b).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(0, (end - start) / 1000);
}
function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds || 0)));
  if (!seconds) return 'calculating…';
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600); seconds %= 3600;
  const m = Math.floor(seconds / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.slice(0, 2).join(' ');
}
function runTargetFromState(state) {
  const m = String(state && state.run_id || '').match(/^gh:[^:]+:[^:]+:(\d+)$/);
  return m ? Math.max(0, Number(m[1])) : 0;
}
function statusInfo(state) {
  const raw = String(state && state.status || 'unknown').toLowerCase();
  const heartbeatAge = state && state.heartbeat_at ? secondsBetween(state.heartbeat_at) : 0;
  if (raw === 'running' && heartbeatAge > 600) return { label:'STALLED', emoji:'🟠' };
  if (raw === 'running') return { label:'RUNNING', emoji:'🟢' };
  if (raw === 'preparing') return { label:'PREPARING', emoji:'🟡' };
  if (raw === 'stalled') return { label:'STALLED', emoji:'🟠' };
  if (raw === 'paused') return { label:'PAUSED', emoji:'⏸' };
  if (raw === 'waiting' || raw === 'new') return { label:'STOPPED / IDLE', emoji:'⚪️' };
  return { label:raw.toUpperCase(), emoji:'⚪️' };
}
function progressMetrics(state) {
  const target = runTargetFromState(state);
  const completed = Math.max(0, Number(state && state.pages_completed_latest || 0));
  const runElapsed = secondsBetween(state && state.run_started_at,
    state && state.run_finished_at && String(state.status).toLowerCase() !== 'running' ? new Date(state.run_finished_at) : new Date());
  const avgPageSeconds = completed > 0 && runElapsed > 0 ? runElapsed / completed : 0;
  const remainingRun = target > 0 ? Math.max(0, target - completed) : 0;
  const globalDone = Math.max(0, Math.min(STICKNODES_TOTAL_PAGES, Number(state && state.backfill_next_page || 1) - 1));
  const globalRemaining = Math.max(0, STICKNODES_TOTAL_PAGES - globalDone);
  return {
    target, completed, avgPageSeconds,
    runEtaSeconds: avgPageSeconds && target ? remainingRun * avgPageSeconds : 0,
    globalDone, globalRemaining,
    globalEtaSeconds: avgPageSeconds ? globalRemaining * avgPageSeconds : 0,
    globalPercent: STICKNODES_TOTAL_PAGES ? (globalDone / STICKNODES_TOTAL_PAGES) * 100 : 0,
  };
}

function ownerUser(user) {
  return Boolean(config.ownerId && String(user && user.id) === String(config.ownerId));
}
function ownerOnly(msg) {
  return ownerUser(msg && msg.from);
}
function canUse(user) {
  return ownerUser(user) || accessMode === 'public';
}
async function denyPrivate(chatId) {
  return bot.sendMessage(chatId, '🔒 This archive bot is currently private.');
}

async function answerCallback(id, text = '') {
  try { await bot.answerCallbackQuery(id, text ? { text, show_alert:false } : undefined); } catch (_) {}
}
async function editOrSend(query, view) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  try {
    await bot.editMessageText(view.text, { chat_id:chatId, message_id:messageId, parse_mode:'HTML', disable_web_page_preview:true, reply_markup:view.keyboard });
  } catch (error) {
    if (!/message is not modified/i.test(error.message || '')) {
      await bot.sendMessage(chatId, view.text, { parse_mode:'HTML', disable_web_page_preview:true, reply_markup:view.keyboard });
    }
  }
}

async function sendRoot(msg) {
  if (!canUse(msg.from)) return denyPrivate(msg.chat.id);
  const view = ui.rootMenu({ owner:ownerOnly(msg) });
  return bot.sendMessage(msg.chat.id, view.text, { parse_mode:'HTML', reply_markup:view.keyboard });
}

function wire() {
  bot.onText(/^\/(?:start|archive)(?:@\w+)?$/i, async (msg) => sendRoot(msg));

  bot.onText(/^\/search(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    if (!canUse(msg.from)) return denyPrivate(msg.chat.id);
    const q = String(match && match[1] || '').trim();
    if (!q) return bot.sendMessage(msg.chat.id, '🔎 Use <code>/search sword</code> (or any filename, creator, tag, or similar name).', { parse_mode:'HTML' });
    const token = ui.createSearch(q);
    const view = await ui.searchView(token, 1);
    return bot.sendMessage(msg.chat.id, view.text, { parse_mode:'HTML', disable_web_page_preview:true, reply_markup:view.keyboard });
  });

  bot.onText(/^\/stats(?:@\w+)?$/i, async (msg) => {
    if (!canUse(msg.from)) return denyPrivate(msg.chat.id);
    const [s, state] = await Promise.all([db.stats(), db.getState()]);
    const status = statusInfo(state);
    const p = progressMetrics(state);
    const currentPage = Math.max(0, Number(state.current_page || 0));
    const creatorMissing = Number(s.creator_missing || 0);
    const text = [
      '<b>📊 ARCHIVE STATS</b>', '',
      `${status.emoji} Archive: <b>${status.label}</b>`,
      p.target ? `📄 Current run: <b>${Math.min(p.completed, p.target)}/${p.target} pages</b>${currentPage ? ` • site page ${currentPage}` : ''}` : `📄 Current page: ${currentPage || '—'}`,
      p.avgPageSeconds ? `⚡ Avg/page: ${formatDuration(p.avgPageSeconds)}` : '⚡ Avg/page: calculating…',
      p.runEtaSeconds ? `⏳ Run ETA: ~${formatDuration(p.runEtaSeconds)}` : (p.target && p.completed >= p.target ? '⏳ Run ETA: complete' : '⏳ Run ETA: calculating…'),
      '',
      `🌐 Global pages: <b>${p.globalDone.toLocaleString()}/${STICKNODES_TOTAL_PAGES.toLocaleString()}</b> (${p.globalPercent.toFixed(1)}%)`,
      `📚 Pages remaining: ${p.globalRemaining.toLocaleString()}`,
      p.globalEtaSeconds ? `🕒 Global ETA: ~${formatDuration(p.globalEtaSeconds)} active scraping time` : '🕒 Global ETA: calculating…',
      '',
      `📦 Total files: <b>${Number(s.total).toLocaleString()}</b>`,
      `🧍 Nodes: ${Number(s.nodes).toLocaleString()}`,
      `🎬 Movieclips: ${Number(s.movieclips).toLocaleString()}`,
      `🗜 Packs: ${Number(s.packs).toLocaleString()}`,
      `🧩 Other: ${Number(s.other || 0).toLocaleString()}`,
      `👤 Creators identified: ${Number(s.creators).toLocaleString()}`,
      creatorMissing ? `❔ Creator metadata missing: ${creatorMissing.toLocaleString()}` : '',
      `💾 Archived bytes: ${formatBytes(Number(s.bytes))}`,
      `⚠️ Recorded failures: ${Number(s.failures).toLocaleString()}`,
      '',
      `✅ This run archived: ${Number(state.archived_latest || 0).toLocaleString()}`,
      `⏭ This run skipped: ${Number(state.skipped_latest || 0).toLocaleString()}`,
      `❌ This run failed: ${Number(state.failed_latest || 0).toLocaleString()}`,
      state.last_error ? `\nLast error: <code>${htmlEscape(state.last_error)}</code>` : '',
    ].filter(Boolean).join('\n');
    return bot.sendMessage(msg.chat.id, text, { parse_mode:'HTML' });
  });

  bot.onText(/^\/archivegif(?:@\w+)?(?:\s+(on|off))?$/i, async (msg, match) => {
    if (!ownerOnly(msg)) return;
    const requested = String(match && match[1] || '').toLowerCase();
    if (!requested) {
      const enabled = String(await db.getSetting('archive_gif', 'off')).toLowerCase() === 'on';
      const chatId = await db.getSetting('gif_archive_chat_id', '');
      return bot.sendMessage(msg.chat.id,
        `🎞 GIF archiving: <b>${enabled ? 'ON' : 'OFF'}</b>\n` +
        `📂 GIF archive chat: <code>${htmlEscape(chatId || 'not set')}</code>\n\n` +
        `Use <code>/archivegif on</code> or <code>/archivegif off</code>.`,
        { parse_mode:'HTML' });
    }
    await db.setSetting('archive_gif', requested);
    const chatId = await db.getSetting('gif_archive_chat_id', '');
    if (requested === 'on' && !chatId) {
      return bot.sendMessage(msg.chat.id,
        '⚠️ GIF archiving is ON, but no GIF archive group is set yet.\n\n' +
        'Add the bot to the preview group and send <code>/gifchat here</code> there.',
        { parse_mode:'HTML' });
    }
    return bot.sendMessage(msg.chat.id,
      `🎞 GIF archiving is now <b>${requested.toUpperCase()}</b>.`,
      { parse_mode:'HTML' });
  });

  bot.onText(/^\/gifchat(?:@\w+)?(?:\s+(here|clear))?$/i, async (msg, match) => {
    if (!ownerOnly(msg)) return;
    const action = String(match && match[1] || '').toLowerCase();
    if (!action) {
      const chatId = await db.getSetting('gif_archive_chat_id', '');
      return bot.sendMessage(msg.chat.id,
        `🎞 GIF archive chat: <code>${htmlEscape(chatId || 'not set')}</code>\n\n` +
        `Send <code>/gifchat here</code> inside the group you want to use.`,
        { parse_mode:'HTML' });
    }
    if (action === 'clear') {
      await db.setSetting('gif_archive_chat_id', '');
      return bot.sendMessage(msg.chat.id, '🧹 GIF archive chat cleared.');
    }
    await db.setSetting('gif_archive_chat_id', String(msg.chat.id));
    return bot.sendMessage(msg.chat.id,
      `✅ This chat is now the <b>GIF preview archive</b>.\n<code>${htmlEscape(String(msg.chat.id))}</code>`,
      { parse_mode:'HTML' });
  });

  bot.onText(/^\/superingest(?:@\w+)?(?:\s+(on|off))?$/i, async (msg, match) => {
    if (!ownerOnly(msg)) return;
    const requested = String(match && match[1] || '').toLowerCase();
    if (!requested) {
      const enabled = String(await db.getSetting('super_ingest', 'off')).toLowerCase() === 'on';
      return bot.sendMessage(msg.chat.id,
        `⚡ Super ingest: <b>${enabled ? 'ON' : 'OFF'}</b>\n\n` +
        `Use <code>/superingest on</code> or <code>/superingest off</code>.\n` +
        `The setting is read when the next GitHub ingest run starts.`,
        { parse_mode:'HTML' });
    }
    await db.setSetting('super_ingest', requested);
    return bot.sendMessage(msg.chat.id,
      `⚡ Super ingest is now <b>${requested.toUpperCase()}</b>.\n` +
      `It will apply to the next GitHub ingest run.`,
      { parse_mode:'HTML' });
  });

  bot.onText(/^\/access(?:@\w+)?(?:\s+(private|public))?$/i, async (msg, match) => {
    if (!ownerOnly(msg)) return;
    const requested = String(match && match[1] || '').toLowerCase();
    if (!requested) {
      return bot.sendMessage(msg.chat.id,
        `🔐 Bot access: <b>${accessMode.toUpperCase()}</b>\n\nUse <code>/access private</code> or <code>/access public</code>.`,
        { parse_mode:'HTML' });
    }
    accessMode = await db.setAccessMode(requested);
    return bot.sendMessage(msg.chat.id,
      `✅ Archive access is now <b>${accessMode.toUpperCase()}</b>.`,
      { parse_mode:'HTML' });
  });

  bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
    if (!ownerOnly(msg)) return;
    const state = await db.getState();
    const text = [
      '<b>🛠 SCRAPER STATUS</b>', '',
      `Status: <b>${htmlEscape(state.status)}</b>`,
      `Running now: ${scraper.isRunning() ? 'yes' : 'no'}`,
      `Backfill next page: ${Number(state.backfill_next_page || 1)}`,
      `Backfill complete: ${state.backfill_complete ? 'yes' : 'no'}`,
      `Last cycle archived: ${Number(state.archived_latest || 0)}`,
      `Last cycle skipped: ${Number(state.skipped_latest || 0)}`,
      `Last cycle failed: ${Number(state.failed_latest || 0)}`,
      state.last_error ? `\nLast error: <code>${htmlEscape(state.last_error)}</code>` : '',
    ].filter(Boolean).join('\n');
    return bot.sendMessage(msg.chat.id, text, { parse_mode:'HTML' });
  });

  bot.onText(/^\/sync(?:@\w+)?(?:\s+(\d+))?$/i, async (msg, match) => {
    if (!ownerOnly(msg)) return;
    const pages = Math.max(1, Math.min(100, Number(match && match[1] || config.backfillPagesPerCycle)));
    if (scraper.isRunning()) return bot.sendMessage(msg.chat.id, '⚙️ A scraper cycle is already running.');
    await bot.sendMessage(msg.chat.id, `⚙️ Sync started: recent pages + up to <b>${pages}</b> backfill pages.`, { parse_mode:'HTML' });
    scraper.runCycle({ backfillPages:pages }).then(async (result) => {
      await bot.sendMessage(msg.chat.id, `✅ Sync finished.\nArchived: <b>${result.archived || 0}</b>\nSkipped/duplicates: <b>${(result.skipped || 0)+(result.duplicate || 0)}</b>\nFailed: <b>${result.failed || 0}</b>\nBackfill next page: <b>${result.backfillNextPage || '?'}</b>`, { parse_mode:'HTML' });
    }).catch(async (error) => {
      await bot.sendMessage(msg.chat.id, `❌ Sync failed: <code>${htmlEscape(error.message || error)}</code>`, { parse_mode:'HTML' });
    });
  });

  bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    try {
      if (!canUse(query.from)) {
        await answerCallback(query.id, 'This archive bot is private.');
        return;
      }
      if (data === 'noop') return answerCallback(query.id);
      if (data === 'root') { await answerCallback(query.id); return editOrSend(query, ui.rootMenu({ owner:ownerUser(query.from) })); }
      if (data === 'help:search') {
        await answerCallback(query.id);
        return bot.sendMessage(query.message.chat.id, '🔎 Search the full archive with <code>/search name</code>.\n\nExamples:\n<code>/search sword</code>\n<code>/search gojo</code>\n<code>/search MxAnimator</code>', { parse_mode:'HTML' });
      }
      if (data === 'stats') {
        await answerCallback(query.id);
        const s = await db.stats();
        return bot.sendMessage(query.message.chat.id, `📊 <b>${Number(s.total).toLocaleString()}</b> files archived\n🧍 ${Number(s.nodes).toLocaleString()} nodes • 🎬 ${Number(s.movieclips).toLocaleString()} movieclips • 🗜 ${Number(s.packs).toLocaleString()} packs`, { parse_mode:'HTML' });
      }
      let m = data.match(/^at:([nmpo])$/);
      if (m) {
        if (m[1] === 'o' && !ownerUser(query.from)) return answerCallback(query.id, 'Other files are owner-only.');
        await answerCallback(query.id);
        return editOrSend(query, ui.categoryMenu(ui.TYPE_CODE[m[1]]));
      }
      m = data.match(/^ac:([nmpo]):([a-z]{1,2})$/);
      if (m) {
        await answerCallback(query.id);
        const type = ui.TYPE_CODE[m[1]], category = ui.CAT_REV[m[2]] || 'all';
        return editOrSend(query, ui.letterMenu(type, type === 'pack' ? 'packs' : category));
      }
      m = data.match(/^al:([nmpo]):([a-z]{1,2}):([a-z_]):(\d+)$/);
      if (m) {
        await answerCallback(query.id);
        const type = ui.TYPE_CODE[m[1]], category = ui.CAT_REV[m[2]] || 'all', letter = m[3], page = Math.max(1, Number(m[4]));
        return editOrSend(query, await ui.browseView(type, type === 'pack' ? 'packs' : category, letter, page));
      }
      m = data.match(/^sp:([a-f0-9]{8}):(\d+)$/);
      if (m) {
        await answerCallback(query.id);
        const view = await ui.searchView(m[1], Math.max(1, Number(m[2])));
        if (view.expired) return bot.sendMessage(query.message.chat.id, '⌛ That search session expired. Run /search again.');
        return editOrSend(query, view);
      }
      m = data.match(/^dl:(\d+)$/);
      if (m) {
        await answerCallback(query.id, 'Sending file…');
        const file = await db.getById(Number(m[1]));
        if (!file) return bot.sendMessage(query.message.chat.id, '❌ Archived file not found.');
        if (file.file_type === 'other' && !ownerUser(query.from)) {
          return bot.sendMessage(query.message.chat.id, '🔒 Other files are owner-only.');
        }
        if (file.preview_telegram_file_id) {
          try {
            await bot.sendAnimation(query.message.chat.id, file.preview_telegram_file_id, {
              caption:`🎞 <b>Preview — ${htmlEscape(file.title)}</b>`,
              parse_mode:'HTML',
            });
          } catch (previewError) {
            console.warn('[telegram] preview send failed:', previewError.message);
          }
        }
        return bot.sendDocument(query.message.chat.id, file.telegram_file_id, {
          caption: ui.fileCaption(file), parse_mode:'HTML', disable_content_type_detection:false,
        });
      }
      await answerCallback(query.id);
    } catch (error) {
      console.error('[telegram] callback error', error);
      await answerCallback(query.id, 'Something went wrong.');
    }
  });

  bot.on('polling_error', (error) => console.error('[telegram] polling error:', error.message || error));
}

async function start() {
  if (!config.telegramToken) throw new Error('TELEGRAM_TOKEN is required');
  bot = new TelegramBot(config.telegramToken, { polling:{ interval:300, params:{ timeout:25, allowed_updates:['message','callback_query'] } } });
  scraper.attachBot(bot);
  accessMode = await db.getAccessMode();
  console.log(`[telegram] access mode: ${accessMode}`);
  wire();
  const me = await bot.getMe();
  console.log(`[telegram] connected as @${me.username}`);
  return bot;
}
function getBot() { return bot; }
module.exports = { start, getBot };
