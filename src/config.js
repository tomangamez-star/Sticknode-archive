'use strict';
require('dotenv').config();

function int(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
function bool(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
function cleanBase(value) { return String(value || '').replace(/\/+$/, ''); }

module.exports = {
  telegramToken: String(process.env.TELEGRAM_TOKEN || '').trim(),
  databaseUrl: String(process.env.DATABASE_URL || '').trim(),
  archiveChatId: String(process.env.ARCHIVE_CHAT_ID || '').trim(),
  ownerId: String(process.env.OWNER_ID || '').trim(),
  port: int('PORT', 10000, 1, 65535),
  baseUrl: cleanBase(process.env.STICKNODES_BASE_URL || 'https://sticknodes.com'),
  listUrl: String(process.env.STICKNODES_LIST_URL || 'https://sticknodes.com/stickfigures/').trim(),
  autoRun: bool('SCRAPER_AUTO_RUN', true),
  intervalMinutes: int('SCRAPER_INTERVAL_MINUTES', 10, 1, 1440),
  backfillPagesPerCycle: int('SCRAPER_BACKFILL_PAGES_PER_CYCLE', 0, 0, 100),
  recentPages: int('SCRAPER_RECENT_PAGES', 3, 1, 20),
  siteDelayMs: int('SCRAPER_SITE_DELAY_MS', 350, 100, 10000),
  uploadDelayMs: int('SCRAPER_UPLOAD_DELAY_MS', 1100, 250, 30000),
  maxFileBytes: int('SCRAPER_MAX_FILE_MB', 45, 1, 49) * 1024 * 1024,
  fetchDetails: bool('SCRAPER_FETCH_DETAILS', true),
  pageSize: int('ARCHIVE_PAGE_SIZE', 20, 10, 30),
};
