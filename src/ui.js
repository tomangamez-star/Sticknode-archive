'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { htmlEscape, truncate, formatBytes } = require('./utils');

const TYPE_CODE = { n: 'node', m: 'movieclip', p: 'pack' };
const TYPE_REV = { node: 'n', movieclip: 'm', pack: 'p' };
const CAT_CODE = { all:'a', backgrounds:'bg', effects:'ef', miscellaneous:'mi', objects:'ob', people:'pe', weapons:'we', vehicles:'ve', packs:'pk' };
const CAT_REV = Object.fromEntries(Object.entries(CAT_CODE).map(([k,v]) => [v,k]));
const CATEGORIES = ['people','weapons','objects','vehicles','effects','backgrounds','miscellaneous'];
const searchSessions = new Map();

function typeName(type) { return ({ node:'Nodes', movieclip:'Movieclips', pack:'Packs' })[type] || type; }
function pretty(value) { return String(value || '').replace(/(^|\s)\S/g, (m) => m.toUpperCase()); }
function kb(rows) { return { inline_keyboard: rows }; }
function rootMenu() {
  return {
    text: '<b>📦 STICK NODES ARCHIVE</b>\n\nBrowse the backed-up files or search the full catalogue.',
    keyboard: kb([
      [{ text:'🧍 Nodes', callback_data:'at:n' }, { text:'🎬 Movieclips', callback_data:'at:m' }],
      [{ text:'🗜 Packs', callback_data:'at:p' }],
      [{ text:'🔎 Search help', callback_data:'help:search' }, { text:'📊 Stats', callback_data:'stats' }],
    ]),
  };
}
function categoryMenu(type) {
  if (type === 'pack') return letterMenu(type, 'packs');
  const tc = TYPE_REV[type];
  const rows = [[{ text:'📚 All categories', callback_data:`ac:${tc}:a` }]];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(CATEGORIES.slice(i, i + 2).map((c) => ({ text: pretty(c), callback_data:`ac:${tc}:${CAT_CODE[c]}` })));
  }
  rows.push([{ text:'⬅️ Back', callback_data:'root' }]);
  return { text:`<b>📁 ${htmlEscape(typeName(type).toUpperCase())}</b>\n\nChoose a category.`, keyboard: kb(rows) };
}
function letterMenu(type, category) {
  const tc = TYPE_REV[type], cc = CAT_CODE[category] || 'a';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const rows = [[{ text:'📚 Browse All', callback_data:`al:${tc}:${cc}:_:1` }]];
  for (let i = 0; i < letters.length; i += 5) rows.push(letters.slice(i, i + 5).map((l) => ({ text:l, callback_data:`al:${tc}:${cc}:${l.toLowerCase()}:1` })));
  rows.push([{ text:type === 'pack' ? '⬅️ Back' : '⬅️ Categories', callback_data:type === 'pack' ? 'root' : `at:${tc}` }]);
  return { text:`<b>${htmlEscape(typeName(type))} → ${htmlEscape(pretty(category === 'all' ? 'All categories' : category))}</b>\n\nChoose A–Z or browse everything.`, keyboard: kb(rows) };
}

function resultText(title, rows, total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lines = [`<b>${htmlEscape(title)}</b>`, `<i>${total.toLocaleString()} result${total === 1 ? '' : 's'} • Page ${page}/${pages}</i>`, ''];
  rows.forEach((row, i) => {
    const number = (page - 1) * pageSize + i + 1;
    lines.push(`${number}. <b>${htmlEscape(row.title)}</b>`);
    lines.push(`   ${htmlEscape(row.file_type)} • ${htmlEscape(row.category)}${row.creator ? ` • ${htmlEscape(row.creator)}` : ''}`);
  });
  return lines.join('\n').slice(0, 3900);
}
function resultKeyboard(rows, page, total, pageSize, prevData, nextData, backData) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const buttons = rows.map((row, i) => [{ text:`📥 ${(page - 1) * pageSize + i + 1}. ${truncate(row.original_filename, 42)}`, callback_data:`dl:${row.id}` }]);
  const nav = [];
  if (page > 1) nav.push({ text:'⬅️ Previous', callback_data:prevData });
  nav.push({ text:`${page}/${pages}`, callback_data:'noop' });
  if (page < pages) nav.push({ text:'Next ➡️', callback_data:nextData });
  buttons.push(nav);
  if (backData) buttons.push([{ text:'⬅️ Back', callback_data:backData }]);
  return kb(buttons);
}
async function browseView(type, category, letter, page) {
  const result = await db.browse({ fileType:type, category, letter:letter === '_' ? '' : letter, page, pageSize:config.pageSize });
  const tc = TYPE_REV[type], cc = CAT_CODE[category] || 'a', lc = letter || '_';
  const label = `${typeName(type)} → ${pretty(category === 'all' ? 'All categories' : category)}${letter && letter !== '_' ? ` → ${letter.toUpperCase()}` : ''}`;
  return {
    text: resultText(`📦 ${label}`, result.rows, result.total, page, config.pageSize),
    keyboard: resultKeyboard(result.rows, page, result.total, config.pageSize,
      `al:${tc}:${cc}:${lc}:${Math.max(1,page-1)}`, `al:${tc}:${cc}:${lc}:${page+1}`, `ac:${tc}:${cc}`),
  };
}
function createSearch(query) {
  const token = crypto.randomBytes(4).toString('hex');
  searchSessions.set(token, { query, expires:Date.now() + 30 * 60_000 });
  if (searchSessions.size > 300) {
    for (const [k,v] of searchSessions) if (v.expires < Date.now()) searchSessions.delete(k);
  }
  return token;
}
async function searchView(token, page = 1) {
  const session = searchSessions.get(token);
  if (!session || session.expires < Date.now()) return { expired:true };
  const result = await db.searchFiles(session.query, page, config.pageSize);
  return {
    text: resultText(`🔎 Search: “${session.query}”`, result.rows, result.total, page, config.pageSize),
    keyboard: resultKeyboard(result.rows, page, result.total, config.pageSize,
      `sp:${token}:${Math.max(1,page-1)}`, `sp:${token}:${page+1}`, 'root'),
  };
}
function fileCaption(file) {
  const lines = [
    `📦 <b>${htmlEscape(file.title)}</b>`,
    `📄 <code>${htmlEscape(file.original_filename)}</code>`,
    `🗂 ${htmlEscape(file.file_type)} → ${htmlEscape(file.category)}`,
    file.creator ? `👤 ${htmlEscape(file.creator)}${file.creator_handle ? ` ${htmlEscape(file.creator_handle)}` : ''}` : '',
    file.actual_size_bytes ? `💾 ${formatBytes(file.actual_size_bytes)}` : '',
    file.source_date ? `📅 ${htmlEscape(file.source_date)}` : '',
    file.tags && file.tags.length ? `🏷 ${htmlEscape(file.tags.slice(0,10).join(', '))}` : '',
    file.detail_url ? `🔗 <a href="${htmlEscape(file.detail_url)}">Original StickNodes page</a>` : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1000);
}
module.exports = { TYPE_CODE, TYPE_REV, CAT_CODE, CAT_REV, CATEGORIES, rootMenu, categoryMenu, letterMenu, browseView, createSearch, searchView, fileCaption, typeName };
