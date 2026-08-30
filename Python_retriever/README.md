# JTF Mini Web Retriever v1.1

A small retrieval/indexing layer that sits between the archive ingester and the network.

## Fetch flow

```text
python_ingest/ingest.py
        |
        v
python_retriever/retriever.py
        |
        +-- RETRIEVER_PROVIDER=direct      -> ordinary HTTP
        |
        +-- RETRIEVER_PROVIDER=scraperapi  -> ScraperAPI standard endpoint
```

The existing Chrome/UC code remains in `python_ingest/ingest.py` as an optional browser
fallback. It is lazy now, so it does not launch during normal retriever runs.

## ScraperAPI mode

Set:

```text
INGEST_FETCH_PROVIDER=retriever
RETRIEVER_PROVIDER=scraperapi
SCRAPERAPI_KEY=your-key
RETRIEVER_ALLOWED_HOSTS=example.com
```

The retriever sends the target URL to ScraperAPI's normal API endpoint using only:

```text
api_key=<secret>
url=<target>
```

No premium, JavaScript-rendering, CAPTCHA-solving, country, session, or stealth flags are
enabled by this integration.

The returned bytes then go through the same local protections and parser as a direct fetch:
host allowlist, private-network rejection, robots handling, challenge/interstitial detection,
file-type checks, SHA-256 dedupe, PostgreSQL metadata, and Telegram upload.

## General retriever features

- explicit hostname allowlist (`RETRIEVER_ALLOWED_HOSTS`)
- localhost/private-network rejection
- `robots.txt` respected by default
- challenge/interstitial HTML rejected instead of indexed
- HTML title/description/text/link extraction
- PostgreSQL cache/index
- bounded crawl queue
- JSON service for other bots

## Optional settings

```text
DATABASE_URL=
RETRIEVER_USER_AGENT=JTF-Retriever/1.0 (+contact)
RETRIEVER_TIMEOUT_SECONDS=60
RETRIEVER_MAX_HTML_BYTES=3145728
RETRIEVER_CACHE_MINUTES=60
RETRIEVER_RESPECT_ROBOTS=true
RETRIEVER_PROVIDER=direct
SCRAPERAPI_KEY=
SCRAPERAPI_ENDPOINT=https://api.scraperapi.com/
RETRIEVER_PORT=8090
RETRIEVER_API_KEY=
```

## CLI

```bash
python python_retriever/retriever.py init
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
