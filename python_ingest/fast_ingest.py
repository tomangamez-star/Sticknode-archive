#!/usr/bin/env python3
import hashlib
import re
import time
from urllib.parse import urljoin
from bs4 import BeautifulSoup
from python_ingest import ingest as core

KNOWN_NODE_EXTS = ('.nodes', '.stk')
KNOWN_MOVIE_EXTS = ('.nodemc',)
PACK_EXTS = ('.zip',)
SAFE_EXTENSION = re.compile(r'\.[a-z0-9]{1,12}$', re.I)

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
        title = core.clean(a.get_text()) or re.sub(r'[-_]+', ' ', re.sub(r'\.[a-z0-9]{1,12}$', '', name, flags=re.I))
        da = node.select_one('a[href*="/sticks/"]')
        detail = urljoin(url, da.get('href', '')) if da else ''
        cm = re.search(r'\((Backgrounds|Effects|Miscellaneous|Objects|People|Weapons|Vehicles|Packs)(?:\s+(\d+))?\)', text2, re.I)
        typ = extended_ftype(name, title)
        normal_cat = cm.group(1).lower() if cm else core.category_from(href)
        cat = 'packs' if typ == 'pack' else ('other' if typ == 'other' else normal_cat)
        hm = re.search(r'Hits:\s*([\d,]+)', text2, re.I)
        dm = re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}', text2, re.I)
        out.append(dict(
            source_url=href, download_url=href, detail_url=detail, source_page=url,
            title=title, original_filename=name, file_type=typ, category=cat,
            categories=[cat], tags=core.tags(title, cat, typ),
            creator='', creator_handle='', description='',
            source_date=dm.group(0) if dm else '',
            source_hits=int(hm.group(1).replace(',', '')) if hm else 0,
            pack_count=int(cm.group(2)) if cm and cm.group(2) else 0,
            declared_size_bytes=0,
        ))
        seen.add(href)
    return out

def extended_process(c, it, p):
    if core.q(c, 'SELECT id FROM stick_archive_files WHERE source_url=%s AND telegram_file_id IS NOT NULL LIMIT 1', (it['source_url'],)):
        return 'skipped'
    try:
        it = core.hydrate(it)
        time.sleep(core.DELAY)
        r = core.get(it['download_url'], 60, binary=True, source_page=it.get('source_page', ''))
        data = r.content
        content_type = str(r.headers.get('content-type', '')).lower()
        lower_name = str(it.get('original_filename') or '').lower()
        legitimate_html_file = lower_name.endswith(('.html', '.htm'))
        looks_html = 'text/html' in content_type or data[:128].lstrip().lower().startswith((b'<!doctype html', b'<html'))
        if looks_html and not legitimate_html_file:
            raise RuntimeError('download URL returned HTML instead of the original asset bytes; refusing to archive it')
        if looks_html and legitimate_html_file:
            preview = data[:200000].decode('utf-8', errors='replace')
            if core.looks_like_browser_challenge('', preview):
                raise RuntimeError('HTML download matched a browser verification/challenge page; refusing to archive it')
        if len(data) > core.MAX_BYTES:
            raise RuntimeError(f'file too large ({len(data)} bytes)')
        it['actual_size_bytes'] = len(data)
        it['sha256'] = hashlib.sha256(data).hexdigest()
        dup = core.q(c, 'SELECT id FROM stick_archive_files WHERE sha256=%s AND telegram_file_id IS NOT NULL LIMIT 1', (it['sha256'],))
        if dup:
            core.q(c, 'INSERT INTO stick_archive_aliases(source_url,file_id) VALUES(%s,%s) ON CONFLICT(source_url) DO UPDATE SET file_id=EXCLUDED.file_id', (it['source_url'], dup[0]['id']))
            c.commit()
            return 'duplicate'
        msg = core.send_archive_document(it, data, r.headers.get('content-type', 'application/octet-stream'))
        doc = msg['document']
        core.q(c, """INSERT INTO stick_archive_files(
            source_url,detail_url,source_page,title,normalized_title,original_filename,file_type,category,categories,
            tags,tags_text,creator,creator_handle,description,source_date,source_hits,pack_count,declared_size_bytes,
            actual_size_bytes,sha256,telegram_file_id,telegram_file_unique_id,telegram_message_id,archive_chat_id,updated_at
        ) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
        ON CONFLICT(source_url) DO UPDATE SET
            title=EXCLUDED.title,normalized_title=EXCLUDED.normalized_title,original_filename=EXCLUDED.original_filename,
            file_type=EXCLUDED.file_type,category=EXCLUDED.category,categories=EXCLUDED.categories,
            tags=EXCLUDED.tags,tags_text=EXCLUDED.tags_text,actual_size_bytes=EXCLUDED.actual_size_bytes,
            sha256=EXCLUDED.sha256,telegram_file_id=EXCLUDED.telegram_file_id,
            telegram_file_unique_id=EXCLUDED.telegram_file_unique_id,telegram_message_id=EXCLUDED.telegram_message_id,
            archive_chat_id=EXCLUDED.archive_chat_id,updated_at=NOW()
        """, (
            it['source_url'], it['detail_url'], it['source_page'], it['title'], core.norm(it['title']),
            it['original_filename'], it['file_type'], it['category'], it['categories'], it['tags'], ' '.join(it['tags']),
            it['creator'], it['creator_handle'], it['description'], it['source_date'], it['source_hits'], it['pack_count'],
            it['declared_size_bytes'], it['actual_size_bytes'], it['sha256'], doc['file_id'], doc.get('file_unique_id', ''),
            msg['message_id'], int(core.CHAT)
        ))
        core.q(c, 'DELETE FROM stick_archive_failures WHERE source_url=%s', (it['source_url'],))
        c.commit()
        time.sleep(core.UPLOAD_DELAY)
        return 'archived'
    except core.ProviderUnavailableError:
        raise
    except Exception as exc:
        core.record_fail(c, it, p, exc)
        print('[failed]', it.get('original_filename'), exc)
        return 'failed'

core.ftype = extended_ftype
core.parse_listing = extended_parse_listing
core.process = extended_process

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
