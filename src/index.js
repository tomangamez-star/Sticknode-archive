'use strict';
const express = require('express');
const config = require('./config');
const db = require('./db');
const telegram = require('./telegram');
const scraper = require('./scraper');

async function main() {
  for (const [name, value] of [['DATABASE_URL', config.databaseUrl], ['TELEGRAM_TOKEN', config.telegramToken], ['ARCHIVE_CHAT_ID', config.archiveChatId]]) {
    if (!value) throw new Error(`${name} is required`);
  }
  await db.init();
  await telegram.start();

  const app = express();
  app.get('/', async (_req, res) => {
    try {
      const stats = await db.stats();
      res.type('text/plain').send(`Stick Nodes Archive Bot\nfiles=${stats.total}\nscraper_running=${scraper.isRunning()}\n`);
    } catch (_) { res.type('text/plain').send('Stick Nodes Archive Bot'); }
  });
  app.get('/health', (_req, res) => res.status(200).json({ ok:true, scraperRunning:scraper.isRunning() }));
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
