#!/usr/bin/env python3
"""Small, permission-aware web retrieval engine.

This module is intentionally conservative:
- explicit host allowlist
- robots.txt respected by default
- localhost/private-network URLs rejected
- Cloudflare/challenge/interstitial pages are detected and rejected, not bypassed
- HTML is cached and indexed in PostgreSQL
- links are discovered and can be queued for a bounded crawl
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup
from curl_cffi import requests
import psycopg
from psycopg.rows import dict_row

DEFAULT_UA = os.getenv(
    "RETRIEVER_USER_AGENT",
    "JTF-Retriever/1.0 (+permission-aware archive retriever)",
).strip()
DEFAULT_TIMEOUT = max(5, min(120, int(os.getenv("RETRIEVER_TIMEOUT_SECONDS", "30"))))
MAX_HTML_BYTES = max(64 * 1024, min(10 * 1024 * 1024, int(os.getenv("RETRIEVER_MAX_HTML_BYTES", str(3 * 1024 * 1024)))))
CACHE_MINUTES = max(1, min(7 * 24 * 60, int(os.getenv("RETRIEVER_CACHE_MINUTES", "60"))))
RESPECT_ROBOTS = os.getenv("RETRIEVER_RESPECT_ROBOTS", "true").lower() in ("1", "true", "yes", "on")
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()


class RetrieverError(RuntimeError):
    pass


class BlockedPageError(RetrieverError):
    pass


class DisallowedUrlError(RetrieverError):
    pass


@dataclass
class RetrievedPage:
    url: str
    final_url: str
    canonical_url: str
    status_code: int
    content_type: str
    title: str
    description: str
    text: str
    links: list[dict]
    sha256: str
    fetched_at: str
    fetch_ms: int
    from_cache: bool = False


def _allowed_hosts() -> set[str]:
    raw = os.getenv("RETRIEVER_ALLOWED_HOSTS", "")
    return {x.strip().lower().rstrip(".") for x in raw.split(",") if x.strip()}


def _host_is_allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    allowed = _allowed_hosts()
    if not allowed:
        return False
    return any(host == item or host.endswith("." + item) for item in allowed)


def _is_public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_url(url: str) -> str:
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise DisallowedUrlError("only http:// and https:// URLs are supported")
    if not parts.hostname:
        raise DisallowedUrlError("URL has no hostname")
    host = parts.hostname.lower().rstrip(".")
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise DisallowedUrlError("local hostnames are not allowed")
    if not _host_is_allowed(host):
        raise DisallowedUrlError(
            f"host '{host}' is not allowlisted; set RETRIEVER_ALLOWED_HOSTS explicitly"
        )

    # Reject obvious IP literals and hostnames resolving only to private/local addresses.
    try:
        if not _is_public_ip(host):
            raise DisallowedUrlError("private/local IP addresses are not allowed")
    except ValueError:
        try:
            answers = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
            ips = {item[4][0] for item in answers}
            if ips and not all(_is_public_ip(ip) for ip in ips):
                raise DisallowedUrlError("hostname resolves to a private/local address")
        except socket.gaierror as exc:
            raise DisallowedUrlError(f"hostname could not be resolved: {exc}") from exc

    # Strip fragments; keep query because it can select different documents.
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


def normalize_url(url: str, base: str = "") -> str:
    absolute = urljoin(base, url) if base else url
    parts = urlsplit(absolute)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return ""
    # Remove common tracking params, preserve meaningful query parameters.
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not k.lower().startswith("utm_")]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", urlencode(query, doseq=True), ""))


def _request_with_safe_redirects(session, url: str, *, headers: dict, timeout: int, max_redirects: int = 5):
    current = validate_url(url)
    for _ in range(max_redirects + 1):
        response = session.get(current, timeout=timeout, allow_redirects=False, headers=headers)
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("location")
        if not location:
            return response
        current = validate_url(urljoin(current, location))
    raise RetrieverError(f"too many redirects (>{max_redirects})")


def _challenge_reason(status: int, headers: dict, title: str, html: str) -> str:
    lower_title = (title or "").lower()
    lower = (html or "").lower()
    mitigated = str(headers.get("cf-mitigated", "")).lower()
    if mitigated == "challenge":
        return "Cloudflare challenge response"
    if "just a moment" in lower_title and "cloudflare" in lower:
        return "Cloudflare interstitial"
    if "challenges.cloudflare.com" in lower:
        return "Cloudflare challenge document"
    if status in (401, 403) and ("captcha" in lower or "verify you are human" in lower):
        return "human-verification interstitial"
    return ""


def _parse_html(html: str, final_url: str) -> tuple[str, str, str, str, list[dict]]:
    soup = BeautifulSoup(html, "html.parser")
    title = ""
    if soup.title:
        title = " ".join(soup.title.get_text(" ", strip=True).split())

    description = ""
    meta = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
    if meta and meta.get("content"):
        description = " ".join(str(meta.get("content")).split())

    canonical = ""
    canonical_tag = soup.find("link", attrs={"rel": lambda value: value and "canonical" in str(value).lower()})
    if canonical_tag and canonical_tag.get("href"):
        canonical = normalize_url(canonical_tag.get("href"), final_url)

    for node in soup(["script", "style", "noscript", "template", "svg"]):
        node.decompose()
    text = " ".join(soup.get_text(" ", strip=True).split())

    links: list[dict] = []
    seen = set()
    for a in soup.find_all("a", href=True):
        target = normalize_url(a.get("href", ""), final_url)
        if not target or target in seen:
            continue
        seen.add(target)
        anchor = " ".join(a.get_text(" ", strip=True).split())[:500]
        links.append({"url": target, "text": anchor})
    return title, description, text, canonical, links


class RobotsCache:
    def __init__(self):
        self._items: dict[str, RobotFileParser] = {}

    def allowed(self, session, url: str) -> bool:
        if not RESPECT_ROBOTS:
            return True
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._items:
            rp = RobotFileParser()
            robots_url = origin + "/robots.txt"
            try:
                response = _request_with_safe_redirects(
                    session,
                    robots_url,
                    timeout=DEFAULT_TIMEOUT,
                    headers={"User-Agent": DEFAULT_UA, "Accept": "text/plain,*/*;q=0.1"},
                )
                if response.status_code >= 400:
                    rp.parse([])
                else:
                    rp.parse(response.text.splitlines())
            except Exception:
                # Fail open for unavailable robots.txt, not for an explicit disallow.
                rp.parse([])
            self._items[origin] = rp
        return self._items[origin].can_fetch(DEFAULT_UA, url)


class Retriever:
    def __init__(self):
        self.session = requests.Session()
        self.robots = RobotsCache()

    def close(self):
        try:
            self.session.close()
        except Exception:
            pass

    def fetch(self, raw_url: str) -> RetrievedPage:
        url = validate_url(raw_url)
        if not self.robots.allowed(self.session, url):
            raise DisallowedUrlError("robots.txt disallows this retriever for the requested URL")

        started = time.monotonic()
        response = _request_with_safe_redirects(
            self.session,
            url,
            timeout=DEFAULT_TIMEOUT,
            headers={
                "User-Agent": DEFAULT_UA,
                "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.2",
            },
        )
        final_url = validate_url(str(response.url))
        content_type = str(response.headers.get("content-type", "")).lower()
        if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
            raise RetrieverError(f"retriever only indexes HTML pages; received '{content_type or 'unknown'}'")

        raw = response.content
        if len(raw) > MAX_HTML_BYTES:
            raise RetrieverError(f"HTML exceeds RETRIEVER_MAX_HTML_BYTES ({len(raw)} bytes)")
        html = response.text
        title, description, text, canonical, links = _parse_html(html, final_url)
        blocked = _challenge_reason(response.status_code, dict(response.headers), title, html)
        if blocked:
            raise BlockedPageError(f"{blocked}; retriever will not bypass verification pages")
        response.raise_for_status()

        elapsed = int((time.monotonic() - started) * 1000)
        digest = hashlib.sha256(raw).hexdigest()
        return RetrievedPage(
            url=url,
            final_url=final_url,
            canonical_url=canonical,
            status_code=int(response.status_code),
            content_type=content_type,
            title=title,
            description=description,
            text=text,
            links=links,
            sha256=digest,
            fetched_at=datetime.now(timezone.utc).isoformat(),
            fetch_ms=elapsed,
        )


def db_connect():
    if not DATABASE_URL:
        raise RetrieverError("DATABASE_URL is required for cache/index commands")
    sslmode = "prefer" if re.search(r"localhost|127\.0\.0\.1", DATABASE_URL) else "require"
    return psycopg.connect(DATABASE_URL, sslmode=sslmode, row_factory=dict_row)


def ensure_schema(conn):
    root = Path(__file__).resolve().parents[1]
    sql = (root / "migrations" / "002_retriever.sql").read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()


def cache_page(conn, page: RetrievedPage):
    host = urlsplit(page.final_url).hostname or ""
    expires = datetime.now(timezone.utc) + timedelta(minutes=CACHE_MINUTES)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO retriever_pages(url,canonical_url,host,status_code,content_type,title,description,body_text,
              body_sha256,fetched_at,expires_at,fetch_ms,error_text,updated_at)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),%s,%s,'',NOW())
            ON CONFLICT(url) DO UPDATE SET canonical_url=EXCLUDED.canonical_url,host=EXCLUDED.host,
              status_code=EXCLUDED.status_code,content_type=EXCLUDED.content_type,title=EXCLUDED.title,
              description=EXCLUDED.description,body_text=EXCLUDED.body_text,body_sha256=EXCLUDED.body_sha256,
              fetched_at=NOW(),expires_at=EXCLUDED.expires_at,fetch_ms=EXCLUDED.fetch_ms,error_text='',updated_at=NOW()
            """,
            (
                page.url,
                page.canonical_url,
                host,
                page.status_code,
                page.content_type,
                page.title,
                page.description,
                page.text,
                page.sha256,
                expires,
                page.fetch_ms,
            ),
        )
        cur.execute("DELETE FROM retriever_links WHERE source_url=%s", (page.url,))
        if page.links:
            cur.executemany(
                "INSERT INTO retriever_links(source_url,target_url,anchor_text) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                [(page.url, item["url"], item.get("text", "")) for item in page.links],
            )
    conn.commit()


def get_cached(conn, url: str, allow_stale: bool = False):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT * FROM retriever_pages WHERE url=%s AND (%s OR expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
            (url, allow_stale),
        )
        row = cur.fetchone()
    if not row:
        return None
    with conn.cursor() as cur:
        cur.execute("SELECT target_url,anchor_text FROM retriever_links WHERE source_url=%s ORDER BY target_url", (url,))
        links = [{"url": r["target_url"], "text": r["anchor_text"]} for r in cur.fetchall()]
    return RetrievedPage(
        url=row["url"],
        final_url=row["url"],
        canonical_url=row["canonical_url"],
        status_code=row["status_code"],
        content_type=row["content_type"],
        title=row["title"],
        description=row["description"],
        text=row["body_text"],
        links=links,
        sha256=row["body_sha256"],
        fetched_at=row["fetched_at"].isoformat(),
        fetch_ms=row["fetch_ms"],
        from_cache=True,
    )


def retrieve(url: str, use_cache: bool = True) -> RetrievedPage:
    clean_url = validate_url(url)
    conn = None
    if DATABASE_URL:
        conn = db_connect()
        ensure_schema(conn)
        if use_cache:
            cached = get_cached(conn, clean_url)
            if cached:
                conn.close()
                return cached
    client = Retriever()
    try:
        page = client.fetch(clean_url)
        if conn:
            cache_page(conn, page)
        return page
    finally:
        client.close()
        if conn:
            conn.close()


def enqueue(conn, urls: Iterable[str], depth: int, priority: int = 100) -> int:
    count = 0
    with conn.cursor() as cur:
        for raw in urls:
            try:
                url = validate_url(raw)
            except RetrieverError:
                continue
            cur.execute(
                """
                INSERT INTO retriever_queue(url,depth,priority,status,available_at,updated_at)
                VALUES(%s,%s,%s,'queued',NOW(),NOW())
                ON CONFLICT(url) DO NOTHING
                """,
                (url, max(0, depth), priority),
            )
            count += cur.rowcount
    conn.commit()
    return count


def claim_queue(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH picked AS (
              SELECT url FROM retriever_queue
              WHERE status='queued' AND available_at<=NOW()
              ORDER BY priority ASC, created_at ASC
              FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE retriever_queue q SET status='fetching',attempts=attempts+1,updated_at=NOW()
            FROM picked WHERE q.url=picked.url
            RETURNING q.*
            """
        )
        row = cur.fetchone()
    conn.commit()
    return row


def run_crawl(seed: str, max_pages: int, max_depth: int, same_host: bool = True):
    seed = validate_url(seed)
    seed_host = urlsplit(seed).hostname
    conn = db_connect()
    ensure_schema(conn)
    enqueue(conn, [seed], depth=0, priority=0)
    retriever = Retriever()
    done = 0
    failed = 0
    try:
        while done + failed < max_pages:
            job = claim_queue(conn)
            if not job:
                break
            url = job["url"]
            try:
                page = retriever.fetch(url)
                cache_page(conn, page)
                child_depth = int(job["depth"]) + 1
                if child_depth <= max_depth:
                    children = []
                    for item in page.links:
                        target = item["url"]
                        if same_host and urlsplit(target).hostname != seed_host:
                            continue
                        children.append(target)
                    enqueue(conn, children, depth=child_depth, priority=100 + child_depth)
                with conn.cursor() as cur:
                    cur.execute("UPDATE retriever_queue SET status='done',last_error='',updated_at=NOW() WHERE url=%s", (url,))
                conn.commit()
                done += 1
                print(json.dumps({"status": "done", "url": url, "title": page.title, "links": len(page.links)}))
            except Exception as exc:
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE retriever_queue SET status='failed',last_error=%s,updated_at=NOW() WHERE url=%s",
                        (str(exc)[:1000], url),
                    )
                conn.commit()
                failed += 1
                print(json.dumps({"status": "failed", "url": url, "error": str(exc)}), file=sys.stderr)
        return {"done": done, "failed": failed}
    finally:
        retriever.close()
        conn.close()


def search_index(query: str, limit: int = 20):
    conn = db_connect()
    ensure_schema(conn)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT url,title,description,host,fetched_at,
                  ts_rank(
                    to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(body_text,'')),
                    plainto_tsquery('simple', %s)
                  ) AS score
                FROM retriever_pages
                WHERE to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(body_text,''))
                      @@ plainto_tsquery('simple', %s)
                ORDER BY score DESC, fetched_at DESC
                LIMIT %s
                """,
                (query, query, max(1, min(100, limit))),
            )
            return cur.fetchall()
    finally:
        conn.close()


def stats():
    conn = db_connect()
    ensure_schema(conn)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS pages, COUNT(DISTINCT host) AS hosts, MAX(fetched_at) AS latest FROM retriever_pages")
            page_stats = cur.fetchone()
            cur.execute("SELECT status,COUNT(*) AS count FROM retriever_queue GROUP BY status ORDER BY status")
            queue = cur.fetchall()
        return {"pages": page_stats["pages"], "hosts": page_stats["hosts"], "latest": page_stats["latest"], "queue": queue}
    finally:
        conn.close()


def page_json(page: RetrievedPage, include_text: bool = True):
    data = asdict(page)
    if not include_text:
        data.pop("text", None)
    return data


def main():
    parser = argparse.ArgumentParser(description="Permission-aware mini web retrieval engine")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create retrieval cache/index tables")
    p_fetch = sub.add_parser("fetch", help="retrieve one allowlisted HTML page")
    p_fetch.add_argument("url")
    p_fetch.add_argument("--no-cache", action="store_true")
    p_fetch.add_argument("--full-text", action="store_true")

    p_crawl = sub.add_parser("crawl", help="bounded same-host crawl")
    p_crawl.add_argument("url")
    p_crawl.add_argument("--max-pages", type=int, default=20)
    p_crawl.add_argument("--max-depth", type=int, default=1)
    p_crawl.add_argument("--cross-host", action="store_true")

    p_search = sub.add_parser("search", help="search cached/indexed pages")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=20)

    sub.add_parser("stats", help="show retriever cache/queue stats")

    args = parser.parse_args()
    if args.command == "init":
        conn = db_connect()
        try:
            ensure_schema(conn)
        finally:
            conn.close()
        print(json.dumps({"ok": True, "schema": "retriever"}))
    elif args.command == "fetch":
        page = retrieve(args.url, use_cache=not args.no_cache)
        print(json.dumps(page_json(page, include_text=args.full_text), ensure_ascii=False, default=str, indent=2))
    elif args.command == "crawl":
        result = run_crawl(args.url, max(1, args.max_pages), max(0, args.max_depth), same_host=not args.cross_host)
        print(json.dumps(result))
    elif args.command == "search":
        print(json.dumps(search_index(args.query, args.limit), ensure_ascii=False, default=str, indent=2))
    elif args.command == "stats":
        print(json.dumps(stats(), ensure_ascii=False, default=str, indent=2))


if __name__ == "__main__":
    main()
