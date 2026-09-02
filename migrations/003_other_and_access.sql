ALTER TABLE stick_archive_files
  DROP CONSTRAINT IF EXISTS stick_archive_files_file_type_check;

ALTER TABLE stick_archive_files
  ADD CONSTRAINT stick_archive_files_file_type_check
  CHECK (file_type IN ('node','movieclip','pack','other'));

CREATE TABLE IF NOT EXISTS stick_archive_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stick_archive_settings(setting_key, setting_value)
VALUES('bot_access_mode', 'private')
ON CONFLICT(setting_key) DO NOTHING;


ALTER TABLE stick_archive_files
  ADD COLUMN IF NOT EXISTS preview_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preview_telegram_file_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preview_telegram_file_unique_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS preview_telegram_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS preview_archive_chat_id BIGINT;

INSERT INTO stick_archive_settings(setting_key, setting_value)
VALUES('archive_gif', 'off')
ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO stick_archive_settings(setting_key, setting_value)
VALUES('gif_archive_chat_id', '')
ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO stick_archive_settings(setting_key, setting_value)
VALUES('super_ingest', 'off')
ON CONFLICT(setting_key) DO NOTHING;
