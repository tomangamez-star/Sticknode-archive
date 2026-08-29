# Stick Nodes Telegram Archive Bot

A separate Render-ready Telegram bot that preserves publicly downloadable StickNodes.com files in a private Telegram archive and maintains a searchable Postgres catalogue.

## What it does

- Archives `.nodes`, `.stk`, `.nodemc`, and `.zip` downloads as Telegram documents.
- Preserves the original filename.
- Separates **Nodes**, **Movieclips**, and **Packs**.
- Preserves site category data (People, Weapons, Objects, Vehicles, Effects, Backgrounds, Miscellaneous, Packs).
- Reads each submission detail page for creator, date, declared size, categories, description and hashtags.
- Stores Telegram `file_id` / `file_unique_id` so user downloads are resent without exposing the private archive chat.
- SHA-256 dedupe prevents identical bytes from being uploaded twice.
- Resumable Postgres backfill state and an advisory lock prevent overlapping ingestion runs.
- Records failed items instead of crashing the whole catalogue.
- A–Z browser with 20 results per page by default.
- Search across title, tags and creator; uses Postgres `pg_trgm` fuzzy matching when available and falls back to `ILIKE`.
- Lightweight Render sync of the newest pages plus a resumable GitHub Actions historical backfill.

## Bot commands

- `/start` or `/archive` — open archive browser.
- `/search <name>` — fuzzy catalogue search.
- `/stats` — public archive totals.
- `/status` — owner-only scraper state.
- `/sync [pages]` — owner-only manual sync/backfill batch.

## Render deployment

1. Create a **private Telegram group or channel** for the backup archive and add the bot. In a channel, make the bot an admin with permission to post files.
2. Get the archive chat ID (usually a negative ID such as `-100...`).
3. Push this project to GitHub.
4. In Render choose **New → Blueprint** and select the repository. `render.yaml` is already configured.
5. Add the secret values requested by the Blueprint:
   - `TELEGRAM_TOKEN`
   - `DATABASE_URL` (Supabase Postgres / other Postgres URL)
   - `ARCHIVE_CHAT_ID`
   - `OWNER_ID`
6. Deploy. Database tables are created automatically on first boot.

No SQLite or Render persistent disk is required. Postgres stores only metadata; Telegram stores the file bytes.

## Scraper behavior

The source list is `https://sticknodes.com/stickfigures/`. The scraper uses normal HTTP requests, not Selenium. It intentionally has conservative request/upload delays configurable through environment variables.

The scraper engine supports both recent-page checks and historical backfill. In the supplied deployment:

1. Render re-checks the newest `SCRAPER_RECENT_PAGES` pages for new uploads.
2. `SCRAPER_BACKFILL_PAGES_PER_CYCLE=0` keeps heavy historical work off the Render service.
3. GitHub Actions resumes historical pages from the shared Postgres cursor and stops when the first empty list page is reached.

The source is ordered newest-first, so recent-page checks prevent new submissions from being missed while the historical backfill progresses separately.

## Important environment variables

See `.env.example`. Useful tuning values:

- `SCRAPER_INTERVAL_MINUTES=10`
- `SCRAPER_BACKFILL_PAGES_PER_CYCLE=0` (recommended on Render; GitHub Actions handles history)
- `SCRAPER_RECENT_PAGES=3`
- `SCRAPER_SITE_DELAY_MS=350`
- `SCRAPER_UPLOAD_DELAY_MS=1100`
- `SCRAPER_MAX_FILE_MB=45`
- `ARCHIVE_PAGE_SIZE=20` (allowed 10–30)

## Archive privacy / source rights

This project is designed for a private preservation archive. StickNodes.com content is user-contributed and may carry creator/copyright conditions. Keep attribution/source metadata, respect takedowns and creator rights, and do not assume that public download availability automatically grants permission for a public redistribution mirror.

## GitHub Actions historical ingestion

The heavy historical backfill is intentionally separated from the Render web service. Render keeps the bot online and re-checks only the newest pages; GitHub Actions handles large batches of older pages.

Add these in **GitHub repository → Settings → Secrets and variables → Actions**:

Required:

- `TELEGRAM_TOKEN`
- `DATABASE_URL`
- `ARCHIVE_CHAT_ID`

Optional:

- `OWNER_ID` — kept available for the same deployment style as Render.
- `INGEST_NOTIFICATION_CHAT_ID` — private chat/group/channel where the workflow can send start/finish/failure summaries.

Then open **Actions → Stick Nodes archive ingest → Run workflow**.

Workflow controls:

- **mode=backfill** — resumes the historical cursor stored in Postgres. This is the normal first-archive option.
- **mode=recent** — re-checks only the newest pages.
- **mode=both** — does both in one run.
- **backfill_pages** — how many historical listing pages this run may process. Default `25`.
- **recent_pages** — newest listing pages to re-check. Default `3`.
- **retry_failures** — retries previously failed files before the page run.
- **start_page** — normally leave `0`; a positive number explicitly moves the saved historical cursor to that page.

The GitHub workflow and Render service use the same Postgres advisory lock. They cannot ingest simultaneously, which prevents duplicate Telegram uploads. The workflow waits briefly for a Render sync to finish and fails cleanly if the lock remains busy.

### Render responsibility after this update

`render.yaml` now sets `SCRAPER_BACKFILL_PAGES_PER_CYCLE=0`. Render therefore stays focused on the live Telegram browser/search bot plus lightweight recent-page syncing. Historical ingestion belongs to GitHub Actions.
