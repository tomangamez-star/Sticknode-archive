CREATE TABLE IF NOT EXISTS stick_archive_files (
  id BIGSERIAL PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  detail_url TEXT DEFAULT '',
  source_page TEXT DEFAULT '',
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('node','movieclip','pack')),
  category TEXT NOT NULL DEFAULT 'miscellaneous',
  categories TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  tags_text TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  creator_handle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_date TEXT NOT NULL DEFAULT '',
  source_hits BIGINT NOT NULL DEFAULT 0,
  pack_count BIGINT NOT NULL DEFAULT 0,
  declared_size_bytes BIGINT NOT NULL DEFAULT 0,
  actual_size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT NOT NULL DEFAULT '',
  telegram_message_id BIGINT NOT NULL DEFAULT 0,
  archive_chat_id BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stick_archive_type_category_idx ON stick_archive_files(file_type, category);
CREATE INDEX IF NOT EXISTS stick_archive_normalized_title_idx ON stick_archive_files(normalized_title);
CREATE INDEX IF NOT EXISTS stick_archive_creator_lower_idx ON stick_archive_files(LOWER(creator));
CREATE INDEX IF NOT EXISTS stick_archive_sha_idx ON stick_archive_files(sha256) WHERE sha256 <> '';

CREATE TABLE IF NOT EXISTS stick_archive_aliases (
  source_url TEXT PRIMARY KEY,
  file_id BIGINT NOT NULL REFERENCES stick_archive_files(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stick_archive_failures (
  source_url TEXT PRIMARY KEY,
  detail_url TEXT DEFAULT '',
  gallery_page BIGINT NOT NULL DEFAULT 0,
  error_text TEXT NOT NULL DEFAULT '',
  attempts BIGINT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stick_archive_scraper_state (
  state_key TEXT PRIMARY KEY,
  backfill_next_page BIGINT NOT NULL DEFAULT 1,
  backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'new',
  run_id TEXT NOT NULL DEFAULT '',
  current_page BIGINT NOT NULL DEFAULT 0,
  pages_completed_latest BIGINT NOT NULL DEFAULT 0,
  archived_latest BIGINT NOT NULL DEFAULT 0,
  skipped_latest BIGINT NOT NULL DEFAULT 0,
  failed_latest BIGINT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  heartbeat_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  run_started_at TIMESTAMPTZ,
  run_finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
