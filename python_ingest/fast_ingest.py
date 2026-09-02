#!/usr/bin/env python3
import hashlib
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import ingest as core

KNOWN_NODE_EXTS = ('.nodes', '.stk')
KNOWN_MOVIE_EXTS = ('.nodemc',)
PACK_EXTS = ('.zip',)
SAFE_EXTENSION = re.compile(r'\.[a-z0-9]{1,12}$', re.I)
PREVIEW_ATTRS = (
    'data-src', 'data-lazy-src', 'data-original', 'data-gif',
    'data-srcset', 'srcset', 'src',
)

_BASE_SCRAPE = core.scrape
_SUPER_MODE = None
_GIF_MODE = None
_GIF_CHAT = ''
_SUPER_TELEGRAM_SESSION = None


def setting(c, key, fallback=''):
    rows = core.q(
        c,
        'SELECT setting_value FROM stick_archive_settings WHERE setting_key=%s LIMIT 1',
        (key,),
    )
    return str(rows[0]['setting_value']) if rows else str(fallback)


def super_enabled(c):
    global _SUPER_MODE, _SUPER_TELEGRAM_SESSION
    if _SUPER_MODE is None:
        _SUPER_MODE = setting(c, 'super_ingest', 'off').strip().lower() == 'on'
        print(f"[mode] super ingest={'ON' if _SUPER_MODE else 'OFF'}")
        if _SUPER_MODE and _SUPER_TELEGRAM_SESSION is None:
            # Keep Telegram HTTP connections alive during the upload phase.
            _SUPER_TELEGRAM_SESSION = core.telegram_requests.Session()
            core.telegram_requests = _SUPER_TELEGRAM_SESSION
    return _SUPER_MODE


def preview_chat(c):
    global _GIF_MODE, _GIF_CHAT
    if _GIF_MODE is None:
        _GIF_MODE = setting(c, 'archive_gif', 'off').strip().lower() == 'on'
        _GIF_CHAT = setting(c, 'gif_archive_chat_id', '').strip()
        if _GIF_MODE:
            if _GIF_CHAT:
                print(f'[preview] GIF archiving=ON chat={_GIF_CHAT}')
            else:
                print('[preview] GIF archiving=ON but no GIF archive chat is configured')
        else:
            print('[preview] GIF archiving=OFF')
    return _GIF_CHAT if _GIF_MODE and _GIF_CHAT else ''


def preview_url_from(node, page_url):
    candidates = []
    for el in node.select('img, source'):
        for attr in PREVIEW_ATTRS:
            raw = str(el.get(attr) or '').strip()
            if not raw:
                continue
            for chunk in raw.split(','):
                token = chunk.strip().split()[0] if chunk.strip() else ''
                if not token:
                    continue
                url = urljoin(page_url, token)
                low = url.lower()
                if '.gif' in low and not any(x in low for x in ('star-', '/stars/', 'rating')):
                    candidates.append(url)
    return candidates[0] if candidates else ''


def fetch_preview(c, it):
    chat_id = preview_chat(c)
    preview_url = str(it.get('preview_url') or '').strip()
    if not chat_id or not preview_url:
        return None

    try:
        r = core.get(
            preview_url,
            60,
            binary=True,
            source_page=it.get('source_page', ''),
        )
        data = r.content
        if not data:
            raise RuntimeError('empty preview response')
        content_type = str(r.headers.get('content-type', '') or '').lower()
        looks_html = (
            'text/html' in content_type
            or data[:128].lstrip().lower().startswith((b'<!doctype html', b'<html'))
        )
        if looks_html:
            raise RuntimeError('preview URL returned HTML instead of preview media')
        return {
            'url': preview_url,
            'chat_id': chat_id,
            'content_type': content_type or 'image/gif',
            'data': data,
        }
    except Exception as exc:
        # Preview failure must never fail the actual archive item.
        print('[preview failed]', it.get('original_filename'), exc)
        return None


def upload_preview(it, preview):
    if not preview:
        return None
    try:
        resp = core.telegram_requests.post(
            f'https://api.telegram.org/bot{core.TOKEN}/sendAnimation',
            data={
                'chat_id': preview['chat_id'],
                'caption': f"🎞 Preview — {it.get('title') or it.get('original_filename') or 'StickNodes item'}",
            },
            files={
                'animation': (
                    'preview.gif',
                    preview['data'],
                    preview.get('content_type') or 'image/gif',
                )
            },
            timeout=120,
        )
        if not resp.ok:
            raise RuntimeError(
                f"Telegram preview upload failed ({resp.status_code}): {core.telegram_error_text(resp)}"
            )
        body = resp.json()
        if not body.get('ok'):
            raise RuntimeError(body.get('description') or 'Telegram preview upload failed')
        msg = body['result']
        animation = msg.get('animation') or msg.get('document') or {}
        return {
            'file_id': animation.get('file_id', ''),
            'file_unique_id': animation.get('file_unique_id', ''),
            'message_id': msg.get('message_id'),
            'chat_id': int(preview['chat_id']),
        }
    except Exception as exc:
        print('[preview upload failed]', it.get('original_filename'), exc)
        return None


def extended_ftype(name, title=''):
    lower = str(name or '').lower()
    if lower.endswith(PACK_EXTS):
        return 'pack'
    if lower.endswith(KNOWN_MOVIE_EXTS) or 'movieclip' in (lower + ' ' + str(title or '').lower()):
        return 'movieclip'
    if lower.endswith(KNOWN_NODE_EXTS):
        return 'node'
    return 'other'


def extended_parse_listing(text, url):
    soup = BeautifulSoup(text, 'html.parser')
    out, seen = [], set()

    for a in soup.select('a[href*="/download/"]'):
        href = urljoin(url, a.get('href', ''))
        name = core.fname(href)
        if href in seen or not SAFE_EXTENSION.search(name):
            continue

        node = a
        for _ in range(8):
            txt = core.clean(node.get_text(' ', strip=True))
            if re.search(r'Hits:\s*[\d,]+', txt, re.I) and node.select_one('a[href*="/sticks/"]'):
                break
            if not node.parent:
                break
            node = node.parent

        text2 = core.clean(node.get_text(' ', strip=True))
        title = core.clean(a.get_text()) or re.sub(
            r'[-_]+',
            ' ',
            re.sub(r'\.[a-z0-9]{1,12}$', '', name, flags=re.I),
        )
        detail_anchor = node.select_one('a[href*="/sticks/"]')
        detail = urljoin(url, detail_anchor.get('href', '')) if detail_anchor else ''
        category_match = re.search(
            r'\((Backgrounds|Effects|Miscellaneous|Objects|People|Weapons|Vehicles|Packs)(?:\s+(\d+))?\)',
            text2,
            re.I,
        )
        typ = extended_ftype(name, title)
        normal_category = category_match.group(1).lower() if category_match else core.category_from(href)
        category = 'packs' if typ == 'pack' else ('other' if typ == 'other' else normal_category)
        hits_match = re.search(r'Hits:\s*([\d,]+)', text2, re.I)
        date_match = re.search(
            r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}',
            text2,
            re.I,
        )

        out.append(dict(
            source_url=href,
            download_url=href,
            detail_url=detail,
            source_page=url,
            preview_url=preview_url_from(node, url),
            title=title,
            original_filename=name,
            file_type=typ,
            category=category,
            categories=[category],
            tags=core.tags(title, category, typ),
            creator='',
            creator_handle='',
            description='',
            source_date=date_match.group(0) if date_match else '',
            source_hits=int(hits_match.group(1).replace(',', '')) if hits_match else 0,
            pack_count=int(category_match.group(2)) if category_match and category_match.group(2) else 0,
            declared_size_bytes=0,
        ))
        seen.add(href)

    return out


def validate_download_bytes(it, data, content_type):
    lower_name = str(it.get('original_filename') or '').lower()
    legitimate_html_file = lower_name.endswith(('.html', '.htm'))
    looks_html = (
        'text/html' in str(content_type or '').lower()
        or data[:128].lstrip().lower().startswith((b'<!doctype html', b'<html'))
    )

    if looks_html and not legitimate_html_file:
        raise RuntimeError(
            'download URL returned HTML instead of the original asset bytes; refusing to archive it'
        )

    if looks_html and legitimate_html_file:
        sample = data[:200000].decode('utf-8', errors='replace')
        if core.looks_like_browser_challenge('', sample):
            raise RuntimeError(
                'HTML download matched a browser verification/challenge page; refusing to archive it'
            )

    if len(data) > core.MAX_BYTES:
        raise RuntimeError(f'file too large ({len(data)} bytes)')


def prepare_item(c, it, page, use_delays):
    if core.q(
        c,
        'SELECT id FROM stick_archive_files WHERE source_url=%s AND telegram_file_id IS NOT NULL LIMIT 1',
        (it['source_url'],),
    ):
        return 'skipped', None

    try:
        it = core.hydrate(it)
        if use_delays:
            time.sleep(core.DELAY)

        r = core.get(
            it['download_url'],
            60,
            binary=True,
            source_page=it.get('source_page', ''),
        )
        data = r.content
        content_type = r.headers.get('content-type', 'application/octet-stream')
        validate_download_bytes(it, data, content_type)

        it['actual_size_bytes'] = len(data)
        it['sha256'] = hashlib.sha256(data).hexdigest()

        duplicate = core.q(
            c,
            'SELECT id FROM stick_archive_files WHERE sha256=%s AND telegram_file_id IS NOT NULL LIMIT 1',
            (it['sha256'],),
        )
        if duplicate:
            core.q(
                c,
                'INSERT INTO stick_archive_aliases(source_url,file_id) VALUES(%s,%s) '
                'ON CONFLICT(source_url) DO UPDATE SET file_id=EXCLUDED.file_id',
                (it['source_url'], duplicate[0]['id']),
            )
            c.commit()
            return 'duplicate', None

        preview = fetch_preview(c, it)
        return 'ready', {
            'item': it,
            'data': data,
            'content_type': content_type,
            'preview': preview,
        }

    except core.ProviderUnavailableError:
        raise
    except Exception as exc:
        core.record_fail(c, it, page, exc)
        print('[failed]', it.get('original_filename'), exc)
        return 'failed', None


def save_archive_record(c, it, msg, preview_result):
    doc = msg['document']
    core.q(c, """INSERT INTO stick_archive_files(
        source_url,detail_url,source_page,title,normalized_title,original_filename,file_type,category,categories,
        tags,tags_text,creator,creator_handle,description,source_date,source_hits,pack_count,declared_size_bytes,
        actual_size_bytes,sha256,telegram_file_id,telegram_file_unique_id,telegram_message_id,archive_chat_id,
        preview_url,preview_telegram_file_id,preview_telegram_file_unique_id,preview_telegram_message_id,
        preview_archive_chat_id,updated_at
    ) VALUES(
        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
        %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
        %s,%s,%s,%s,%s,%s,%s,%s,%s,NOW()
    )
    ON CONFLICT(source_url) DO UPDATE SET
        title=EXCLUDED.title,
        normalized_title=EXCLUDED.normalized_title,
        original_filename=EXCLUDED.original_filename,
        file_type=EXCLUDED.file_type,
        category=EXCLUDED.category,
        categories=EXCLUDED.categories,
        tags=EXCLUDED.tags,
        tags_text=EXCLUDED.tags_text,
        actual_size_bytes=EXCLUDED.actual_size_bytes,
        sha256=EXCLUDED.sha256,
        telegram_file_id=EXCLUDED.telegram_file_id,
        telegram_file_unique_id=EXCLUDED.telegram_file_unique_id,
        telegram_message_id=EXCLUDED.telegram_message_id,
        archive_chat_id=EXCLUDED.archive_chat_id,
        preview_url=CASE
            WHEN EXCLUDED.preview_url<>'' THEN EXCLUDED.preview_url
            ELSE stick_archive_files.preview_url
        END,
        preview_telegram_file_id=CASE
            WHEN EXCLUDED.preview_telegram_file_id<>'' THEN EXCLUDED.preview_telegram_file_id
            ELSE stick_archive_files.preview_telegram_file_id
        END,
        preview_telegram_file_unique_id=CASE
            WHEN EXCLUDED.preview_telegram_file_unique_id<>'' THEN EXCLUDED.preview_telegram_file_unique_id
            ELSE stick_archive_files.preview_telegram_file_unique_id
        END,
        preview_telegram_message_id=COALESCE(
            EXCLUDED.preview_telegram_message_id,
            stick_archive_files.preview_telegram_message_id
        ),
        preview_archive_chat_id=COALESCE(
            EXCLUDED.preview_archive_chat_id,
            stick_archive_files.preview_archive_chat_id
        ),
        updated_at=NOW()
    """, (
        it['source_url'],
        it['detail_url'],
        it['source_page'],
        it['title'],
        core.norm(it['title']),
        it['original_filename'],
        it['file_type'],
        it['category'],
        it['categories'],
        it['tags'],
        ' '.join(it['tags']),
        it['creator'],
        it['creator_handle'],
        it['description'],
        it['source_date'],
        it['source_hits'],
        it['pack_count'],
        it['declared_size_bytes'],
        it['actual_size_bytes'],
        it['sha256'],
        doc['file_id'],
        doc.get('file_unique_id', ''),
        msg['message_id'],
        int(core.CHAT),
        it.get('preview_url', ''),
        (preview_result or {}).get('file_id', ''),
        (preview_result or {}).get('file_unique_id', ''),
        (preview_result or {}).get('message_id'),
        (preview_result or {}).get('chat_id'),
    ))


def archive_ready(c, prepared, page, use_delays):
    it = prepared['item']
    try:
        msg = core.send_archive_document(
            it,
            prepared['data'],
            prepared.get('content_type') or 'application/octet-stream',
        )
        preview_result = upload_preview(it, prepared.get('preview'))
        save_archive_record(c, it, msg, preview_result)
        core.q(
            c,
            'DELETE FROM stick_archive_failures WHERE source_url=%s',
            (it['source_url'],),
        )
        c.commit()
        if use_delays:
            time.sleep(core.UPLOAD_DELAY)
        return 'archived'
    except Exception as exc:
        core.record_fail(c, it, page, exc)
        print('[failed]', it.get('original_filename'), exc)
        return 'failed'


def extended_process(c, it, page):
    status, prepared = prepare_item(c, it, page, use_delays=True)
    if status != 'ready':
        return status
    return archive_ready(c, prepared, page, use_delays=True)


def stage_prepared(prepared, folder, index):
    item_path = folder / f'{index:04d}.asset'
    item_path.write_bytes(prepared['data'])
    prepared['data'] = None
    prepared['item_path'] = item_path

    preview = prepared.get('preview')
    if preview and preview.get('data'):
        preview_path = folder / f'{index:04d}.preview'
        preview_path.write_bytes(preview['data'])
        preview['data'] = None
        preview['path'] = preview_path

    return prepared


def restore_staged(prepared):
    prepared['data'] = prepared['item_path'].read_bytes()
    preview = prepared.get('preview')
    if preview and preview.get('path'):
        preview['data'] = preview['path'].read_bytes()
    return prepared


def apply_partial_counts_before_stall(c, counts):
    totals = core.RUN_CONTEXT.get('totals') or {}
    for key in ('archived', 'skipped', 'failed', 'duplicate'):
        totals[key] = int(totals.get(key) or 0) + int(counts.get(key) or 0)
    core.RUN_CONTEXT['totals'] = totals
    core.upd(
        c,
        archived_latest=totals['archived'],
        skipped_latest=totals['skipped'] + totals['duplicate'],
        failed_latest=totals['failed'],
        heartbeat_at=datetime.now(timezone.utc),
    )


def super_scrape(c, page):
    url = core.page_url(page)
    print('[super] listing page', page, url)
    items = core.parse_listing(core.get(url).text, url)
    counts = {'archived': 0, 'skipped': 0, 'failed': 0, 'duplicate': 0}
    fatal_provider_error = None

    with tempfile.TemporaryDirectory(prefix=f'sticknodes-page-{page}-') as tmp:
        folder = Path(tmp)
        staged = []

        print(f'[super] DIRECT DOWNLOAD PHASE — {len(items)} links, sequential, no click path')
        for index, it in enumerate(items, start=1):
            try:
                status, prepared = prepare_item(c, it, page, use_delays=False)
            except core.ProviderUnavailableError as exc:
                fatal_provider_error = exc
                print('[super] provider disappeared; preserving already-downloaded files before stopping')
                break

            if status == 'ready':
                staged.append(stage_prepared(prepared, folder, index))
                print('[super] downloaded', it['original_filename'])
            else:
                counts[status] += 1
                print('[super]', status, it['original_filename'])

        print(f'[super] TELEGRAM ARCHIVE PHASE — {len(staged)} staged files')
        for prepared in staged:
            prepared = restore_staged(prepared)
            status = archive_ready(c, prepared, page, use_delays=False)
            counts[status] += 1
            print('[super]', status, prepared['item']['original_filename'])
            prepared['data'] = None
            if prepared.get('preview'):
                prepared['preview']['data'] = None

    if fatal_provider_error is not None:
        # Do not advance the page cursor, but keep telemetry accurate for files
        # that were successfully salvaged from the interrupted page.
        apply_partial_counts_before_stall(c, counts)
        raise fatal_provider_error

    return items, counts


def adaptive_scrape(c, page):
    if super_enabled(c):
        return super_scrape(c, page)
    return _BASE_SCRAPE(c, page)


core.ftype = extended_ftype
core.parse_listing = extended_parse_listing
core.process = extended_process
core.scrape = adaptive_scrape

if __name__ == '__main__':
    try:
        core.main()
    except Exception as error:
        core.send_ingest_error_notification(error)
        raise
    finally:
        if core.web_retriever is not None:
            core.web_retriever.close()
        if core._chrome_session is not None:
            core._chrome_session.close()
        if core._playwright_session is not None:
            core._playwright_session.close()
        if _SUPER_TELEGRAM_SESSION is not None:
            _SUPER_TELEGRAM_SESSION.close()
