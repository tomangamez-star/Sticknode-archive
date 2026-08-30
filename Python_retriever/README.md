# JTF Mini Web Retriever v1

A small retrieval/indexing layer that can sit beside the StickNodes archive bot without replacing the existing Chrome work.

## What v1 does

- fetches ordinary public HTML over HTTP
- requires an explicit host allowlist (`RETRIEVER_ALLOWED_HOSTS`)
- rejects localhost/private-network targets
- respects `robots.txt` by default
- detects Cloudflare/human-verification interstitials and fails instead of treating them as real pages
- extracts title, description, readable text, canonical URL and links
- caches/indexes pages in PostgreSQL
- has a queue for bounded crawling
- provides a tiny JSON service that another bot can call

It does **not** solve or bypass verification/challenge pages. If a site returns one, v1 reports that as a blocked page.

## Setup

Apply/create the retriever schema:

```bash
python python_retriever/retriever.py init
```

Set at least:

```text
DATABASE_URL=...
RETRIEVER_ALLOWED_HOSTS=example.com,docs.example.org
```

Optional settings:

```text
RETRIEVER_USER_AGENT=JTF-Retriever/1.0 (+contact)
RETRIEVER_TIMEOUT_SECONDS=30
RETRIEVER_MAX_HTML_BYTES=3145728
RETRIEVER_CACHE_MINUTES=60
RETRIEVER_RESPECT_ROBOTS=true
RETRIEVER_PORT=8090
RETRIEVER_API_KEY=
```

## CLI examples

```bash
python python_retriever/retriever.py fetch https://example.com/
python python_retriever/retriever.py crawl https://example.com/ --max-pages 20 --max-depth 1
python python_retriever/retriever.py search "animation tutorial"
python python_retriever/retriever.py stats
```

## JSON service

```bash
python python_retriever/service.py
```

Endpoints:

```text
GET /health
GET /retrieve?url=https://example.com/page
GET /search?q=animation&limit=20
GET /stats
```

If `RETRIEVER_API_KEY` is set, send `Authorization: Bearer <key>`.

## Chrome

The project’s existing Chrome/UC ingestion code is intentionally left untouched. It can remain available for normal browser-rendering experiments. This retriever is a separate layer, so we do not have to rip out the browser work to keep building the archive.
