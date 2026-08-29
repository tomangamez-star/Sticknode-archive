'use strict';
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const scraper = require('./scraper');
const ui = require('./ui');
const { htmlEscape, formatBytes } = require('./utils');

let bot = null;

function ownerOnly(msg) {
  return config.ownerId && String(msg.from && msg.from.id) === String(config.ownerId);
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

async function sendRoot(chatId) {
  const view = ui.rootMenu();
  return bot.sendMessage(chatId, view.text, { parse_mode:'HTML', reply_markup:view.keyboard });
}

function wire() {
  bot.onText(/^\/(?:start|archive)(?:@\w+)?$/i, async (msg) => sendRoot(msg.chat.id));

  bot.onText(/^\/search(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    const q = String(match && match[1] || '').trim();
    if (!q) return bot.sendMessage(msg.chat.id, '🔎 Use <code>/search sword</code> (or any filename, creator, tag, or similar name).', { parse_mode:'HTML' });
    const token = ui.createSearch(q);
    const view = await ui.searchView(token, 1);
    return bot.sendMessage(msg.chat.id, view.text, { parse_mode:'HTML', disable_web_page_preview:true, reply_markup:view.keyboard });
  });

  bot.onText(/^\/stats(?:@\w+)?$/i, async (msg) => {
    const s = await db.stats();
    const text = [
      '<b>📊 ARCHIVE STATS</b>', '',
      `📦 Total: <b>${Number(s.total).toLocaleString()}</b>`,
      `🧍 Nodes: ${Number(s.nodes).toLocaleString()}`,
      `🎬 Movieclips: ${Number(s.movieclips).toLocaleString()}`,
      `🗜 Packs: ${Number(s.packs).toLocaleString()}`,
      `👤 Creators: ${Number(s.creators).toLocaleString()}`,
      `💾 Archived bytes: ${formatBytes(Number(s.bytes))}`,
      `⚠️ Recorded failures: ${Number(s.failures).toLocaleString()}`,
    ].join('\n');
    return bot.sendMessage(msg.chat.id, text, { parse_mode:'HTML' });
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
      if (data === 'noop') return answerCallback(query.id);
      if (data === 'root') { await answerCallback(query.id); return editOrSend(query, ui.rootMenu()); }
      if (data === 'help:search') {
        await answerCallback(query.id);
        return bot.sendMessage(query.message.chat.id, '🔎 Search the full archive with <code>/search name</code>.\n\nExamples:\n<code>/search sword</code>\n<code>/search gojo</code>\n<code>/search MxAnimator</code>', { parse_mode:'HTML' });
      }
      if (data === 'stats') {
        await answerCallback(query.id);
        const s = await db.stats();
        return bot.sendMessage(query.message.chat.id, `📊 <b>${Number(s.total).toLocaleString()}</b> files archived\n🧍 ${Number(s.nodes).toLocaleString()} nodes • 🎬 ${Number(s.movieclips).toLocaleString()} movieclips • 🗜 ${Number(s.packs).toLocaleString()} packs`, { parse_mode:'HTML' });
      }
      let m = data.match(/^at:([nmp])$/);
      if (m) { await answerCallback(query.id); return editOrSend(query, ui.categoryMenu(ui.TYPE_CODE[m[1]])); }
      m = data.match(/^ac:([nmp]):([a-z]{1,2})$/);
      if (m) {
        await answerCallback(query.id);
        const type = ui.TYPE_CODE[m[1]], category = ui.CAT_REV[m[2]] || 'all';
        return editOrSend(query, ui.letterMenu(type, type === 'pack' ? 'packs' : category));
      }
      m = data.match(/^al:([nmp]):([a-z]{1,2}):([a-z_]):(\d+)$/);
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
  wire();
  const me = await bot.getMe();
  console.log(`[telegram] connected as @${me.username}`);
  return bot;
}
function getBot() { return bot; }
module.exports = { start, getBot };
