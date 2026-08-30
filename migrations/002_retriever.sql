CREATE TABLE IF NOT EXISTS retriever_pages (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  canonical_url TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_sha256 TEXT NOT NULL DEFAULT '',
  etag TEXT NOT NULL DEFAULT '',
  last_modified TEXT NOT NULL DEFAULT '',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  fetch_ms INTEGER NOT NULL DEFAULT 0,
  error_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS retriever_pages_host_idx ON retriever_pages(host);
CREATE INDEX IF NOT EXISTS retriever_pages_fetched_at_idx ON retriever_pages(fetched_at DESC);
CREATE INDEX IF NOT EXISTS retriever_pages_body_sha_idx ON retriever_pages(body_sha256) WHERE body_sha256 <> '';
CREATE INDEX IF NOT EXISTS retriever_pages_title_lower_idx ON retriever_pages(LOWER(title));

CREATE TABLE IF NOT EXISTS retriever_links (
  source_url TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor_text TEXT NOT NULL DEFAULT '',
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_url, target_url)
);
CREATE INDEX IF NOT EXISTS retriever_links_target_idx ON retriever_links(target_url);

CREATE TABLE IF NOT EXISTS retriever_queue (
  url TEXT PRIMARY KEY,
  depth INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','fetching','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS retriever_queue_ready_idx ON retriever_queue(status, available_at, priority, created_at);

-- Full-text index where supported by PostgreSQL. No extension is required.
CREATE INDEX IF NOT EXISTS retriever_pages_fts_idx ON retriever_pages USING GIN (
  to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(body_text,''))
);
