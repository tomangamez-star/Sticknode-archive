'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { normalize } = require('./utils');

let pool = null;
let trigramReady = false;
let scrapeLockClient = null;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000,
      application_name: 'sticknodes_archive_bot',
    });
  }
  return pool;
}

async function init() {
  const p = getPool();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_init.sql'), 'utf8');
  await p.query(sql);
  try {
    await p.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await p.query('CREATE INDEX IF NOT EXISTS stick_archive_title_trgm_idx ON stick_archive_files USING gin (normalized_title gin_trgm_ops)');
    await p.query('CREATE INDEX IF NOT EXISTS stick_archive_tags_trgm_idx ON stick_archive_files USING gin (tags_text gin_trgm_ops)');
    trigramReady = true;
  } catch (error) {
    trigramReady = false;
    console.warn('[db] pg_trgm unavailable; fuzzy search will use LIKE fallback:', error.message);
  }
  await p.query(`INSERT INTO stick_archive_scraper_state(state_key) VALUES('main') ON CONFLICT(state_key) DO NOTHING`);
}

async function close() {
  await releaseScrapeLock().catch(() => {});
  if (pool) { await pool.end(); pool = null; }
}
async function query(text, params = []) { return getPool().query(text, params); }

async function getBySource(sourceUrl) {
  const { rows } = await query('SELECT * FROM stick_archive_files WHERE source_url=$1 LIMIT 1', [sourceUrl]);
  return rows[0] || null;
}
async function getByHash(hash) {
  if (!hash) return null;
  const { rows } = await query('SELECT * FROM stick_archive_files WHERE sha256=$1 LIMIT 1', [hash]);
  return rows[0] || null;
}
async function getById(id) {
  const { rows } = await query('SELECT * FROM stick_archive_files WHERE id=$1 LIMIT 1', [id]);
  return rows[0] || null;
}
async function addAlias(sourceUrl, fileId) {
  await query(`INSERT INTO stick_archive_aliases(source_url,file_id) VALUES($1,$2)
    ON CONFLICT(source_url) DO UPDATE SET file_id=EXCLUDED.file_id`, [sourceUrl, fileId]);
}

async function saveFile(file) {
  const sql = `INSERT INTO stick_archive_files(
    source_url,detail_url,source_page,title,normalized_title,original_filename,file_type,category,categories,
    tags,tags_text,creator,creator_handle,description,source_date,source_hits,pack_count,declared_size_bytes,
    actual_size_bytes,sha256,telegram_file_id,telegram_file_unique_id,telegram_message_id,archive_chat_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
    ON CONFLICT(source_url) DO UPDATE SET
      detail_url=EXCLUDED.detail_url,source_page=EXCLUDED.source_page,title=EXCLUDED.title,
      normalized_title=EXCLUDED.normalized_title,original_filename=EXCLUDED.original_filename,file_type=EXCLUDED.file_type,
      category=EXCLUDED.category,categories=EXCLUDED.categories,tags=EXCLUDED.tags,tags_text=EXCLUDED.tags_text,
      creator=EXCLUDED.creator,creator_handle=EXCLUDED.creator_handle,description=EXCLUDED.description,
      source_date=EXCLUDED.source_date,source_hits=EXCLUDED.source_hits,pack_count=EXCLUDED.pack_count,
      declared_size_bytes=EXCLUDED.declared_size_bytes,actual_size_bytes=EXCLUDED.actual_size_bytes,sha256=EXCLUDED.sha256,
      telegram_file_id=EXCLUDED.telegram_file_id,telegram_file_unique_id=EXCLUDED.telegram_file_unique_id,
      telegram_message_id=EXCLUDED.telegram_message_id,archive_chat_id=EXCLUDED.archive_chat_id,updated_at=NOW()
    RETURNING *`;
  const values = [
    file.source_url, file.detail_url || '', file.source_page || '', file.title, normalize(file.title), file.original_filename,
    file.file_type, file.category || 'miscellaneous', file.categories || [], file.tags || [], (file.tags || []).join(' '),
    file.creator || '', file.creator_handle || '', file.description || '', file.source_date || '', Number(file.source_hits || 0),
    Number(file.pack_count || 0), Number(file.declared_size_bytes || 0), Number(file.actual_size_bytes || 0), file.sha256 || '',
    file.telegram_file_id, file.telegram_file_unique_id || '', Number(file.telegram_message_id || 0), Number(file.archive_chat_id || 0),
  ];
  const { rows } = await query(sql, values);
  return rows[0];
}

async function recordFailure(item, page, error) {
  await query(`INSERT INTO stick_archive_failures(source_url,detail_url,gallery_page,error_text,attempts,last_seen_at)
    VALUES($1,$2,$3,$4,1,NOW()) ON CONFLICT(source_url) DO UPDATE SET
    detail_url=EXCLUDED.detail_url,gallery_page=EXCLUDED.gallery_page,error_text=EXCLUDED.error_text,
    attempts=stick_archive_failures.attempts+1,last_seen_at=NOW()`,
    [item.source_url || item.download_url || `page:${page}`, item.detail_url || '', Number(page || 0), String(error || '').slice(0, 1200)]);
}
async function clearFailure(sourceUrl) { await query('DELETE FROM stick_archive_failures WHERE source_url=$1', [sourceUrl]); }
async function listFailures(limit = 10) {
  const { rows } = await query(`SELECT * FROM stick_archive_failures ORDER BY last_seen_at ASC LIMIT $1`, [Math.max(1, Math.min(100, Number(limit || 10)))]);
  return rows;
}

async function getState() {
  const { rows } = await query(`SELECT * FROM stick_archive_scraper_state WHERE state_key='main'`);
  return rows[0];
}
async function updateState(values) {
  const allowed = new Set(['backfill_next_page','backfill_complete','status','run_id','current_page','pages_completed_latest',
    'archived_latest','skipped_latest','failed_latest','last_error','heartbeat_at','last_success_at','run_started_at','run_finished_at']);
  const entries = Object.entries(values).filter(([k]) => allowed.has(k));
  if (!entries.length) return;
  const sets = entries.map(([k], i) => `${k}=$${i + 1}`);
  const params = entries.map(([, v]) => v);
  params.push('main');
  await query(`UPDATE stick_archive_scraper_state SET ${sets.join(',')},updated_at=NOW() WHERE state_key=$${params.length}`, params);
}

async function browse({ fileType, category = '', letter = '', page = 1, pageSize = config.pageSize }) {
  const where = ['file_type=$1'];
  const params = [fileType];
  if (category && category !== 'all') { params.push(category); where.push(`category=$${params.length}`); }
  if (letter && letter !== 'all') {
    params.push(`${letter.toLowerCase()}%`);
    where.push(`normalized_title LIKE $${params.length}`);
  }
  const offset = (Math.max(1, page) - 1) * pageSize;
  params.push(pageSize, offset);
  const limitPos = params.length - 1, offsetPos = params.length;
  const sql = `SELECT *, COUNT(*) OVER() AS total_count FROM stick_archive_files
    WHERE ${where.join(' AND ')} ORDER BY normalized_title ASC, id ASC LIMIT $${limitPos} OFFSET $${offsetPos}`;
  const { rows } = await query(sql, params);
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

async function searchFiles(search, page = 1, pageSize = config.pageSize) {
  const q = normalize(search);
  if (!q) return { rows: [], total: 0 };
  const offset = (Math.max(1, page) - 1) * pageSize;
  if (trigramReady) {
    try {
      const { rows } = await query(`WITH ranked AS (
        SELECT *, GREATEST(
          similarity(normalized_title,$1), similarity(tags_text,$1) * 0.85,
          similarity(LOWER(creator),$1) * 0.75,
          CASE WHEN normalized_title=$1 THEN 2.0 WHEN normalized_title LIKE $1 || '%' THEN 1.5 WHEN normalized_title LIKE '%' || $1 || '%' THEN 1.2 ELSE 0 END
        ) AS score
        FROM stick_archive_files
        WHERE normalized_title % $1 OR tags_text % $1 OR LOWER(creator) % $1
          OR normalized_title LIKE '%' || $1 || '%' OR tags_text LIKE '%' || $1 || '%' OR LOWER(creator) LIKE '%' || $1 || '%'
      ) SELECT *, COUNT(*) OVER() AS total_count FROM ranked
        WHERE score > 0.12 ORDER BY score DESC, normalized_title ASC LIMIT $2 OFFSET $3`, [q, pageSize, offset]);
      return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
    } catch (error) {
      console.warn('[db] trigram search failed; falling back:', error.message);
    }
  }
  const terms = q.split(' ').filter(Boolean).slice(0, 6);
  const clauses = [];
  const params = [q];
  for (const term of terms) {
    params.push(`%${term}%`);
    const n = params.length;
    clauses.push(`(normalized_title ILIKE $${n} OR tags_text ILIKE $${n} OR creator ILIKE $${n})`);
  }
  params.push(pageSize, offset);
  const { rows } = await query(`SELECT *, COUNT(*) OVER() AS total_count FROM stick_archive_files
    WHERE ${clauses.length ? clauses.join(' AND ') : 'FALSE'}
    ORDER BY CASE WHEN normalized_title=$1 THEN 0 WHEN normalized_title LIKE $1 || '%' THEN 1 WHEN normalized_title LIKE '%' || $1 || '%' THEN 2 ELSE 3 END,
      normalized_title ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

async function stats() {
  const { rows } = await query(`SELECT COUNT(*)::BIGINT total,
    COUNT(*) FILTER(WHERE file_type='node')::BIGINT nodes,
    COUNT(*) FILTER(WHERE file_type='movieclip')::BIGINT movieclips,
    COUNT(*) FILTER(WHERE file_type='pack')::BIGINT packs,
    COALESCE(SUM(actual_size_bytes),0)::BIGINT bytes,
    COUNT(DISTINCT creator)::BIGINT creators FROM stick_archive_files`);
  const failures = await query('SELECT COUNT(*)::BIGINT count FROM stick_archive_failures');
  return { ...rows[0], failures: failures.rows[0].count };
}

async function tryScrapeLock() {
  if (scrapeLockClient) return false;
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [88442211]);
    const locked = Boolean(rows[0] && rows[0].locked);
    if (!locked) { client.release(); return false; }
    scrapeLockClient = client;
    return true;
  } catch (error) {
    client.release();
    throw error;
  }
}
async function releaseScrapeLock() {
  const client = scrapeLockClient;
  scrapeLockClient = null;
  if (!client) return;
  try { await client.query('SELECT pg_advisory_unlock($1)', [88442211]); }
  finally { client.release(); }
}

module.exports = { init, close, query, getBySource, getByHash, getById, addAlias, saveFile, recordFailure, clearFailure, listFailures,
  getState, updateState, browse, searchFiles, stats, tryScrapeLock, releaseScrapeLock, _trigramReady: () => trigramReady };
