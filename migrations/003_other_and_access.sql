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
