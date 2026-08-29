'use strict';
const crypto = require('crypto');
const path = require('path');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalize(value) {
  return clean(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch (_) { return value; } }
function filenameFromUrl(url) {
  try { return safeDecode(path.posix.basename(new URL(url).pathname)); } catch (_) { return 'sticknodes-file.bin'; }
}
function extensionOf(filename) { return path.extname(String(filename || '')).toLowerCase(); }
function fileTypeOf(filename, title = '') {
  const ext = extensionOf(filename);
  if (ext === '.zip') return 'pack';
  if (ext === '.nodemc' || /\bmovieclip\b/i.test(title)) return 'movieclip';
  return 'node';
}
function parseByteSize(input) {
  const m = clean(input).match(/([\d.]+)\s*(KB|MB|GB|B)\b/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return Math.round(n * ({ B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] || 1));
}
function formatBytes(n) {
  const value = Number(n || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value >= 10240 ? 0 : 1)} KB`;
  return `${(value / 1024 ** 2).toFixed(2)} MB`;
}
function htmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(value, max = 54) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
function tagsFromTitle(title, category, fileType) {
  const stop = new Set(['the','and','for','with','from','movieclip','pack','redo','new','remake','v1','v2','v3','v4']);
  const tokens = normalize(title).split(' ').filter((x) => x.length >= 2 && !stop.has(x));
  return [...new Set([normalize(category), normalize(fileType), ...tokens].filter(Boolean))];
}
module.exports = { sleep, clean, normalize, sha256, filenameFromUrl, extensionOf, fileTypeOf, parseByteSize, formatBytes, htmlEscape, truncate, tagsFromTitle };
