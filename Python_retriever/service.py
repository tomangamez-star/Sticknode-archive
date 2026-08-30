#!/usr/bin/env python3
"""Tiny JSON HTTP wrapper around python_retriever.retriever.

Endpoints:
  GET /health
  GET /retrieve?url=https://example.com/page
  GET /search?q=words&limit=20
  GET /stats

The same RETRIEVER_ALLOWED_HOSTS and SSRF/robots/challenge protections apply.
"""

from __future__ import annotations

import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from retriever import RetrieverError, page_json, retrieve, search_index, stats

PORT = int(os.getenv("RETRIEVER_PORT", "8090"))
API_KEY = os.getenv("RETRIEVER_API_KEY", "").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "JTF-Retriever/1.0"

    def _json(self, status: int, payload):
        raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self):
        if not API_KEY:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {API_KEY}"

    def do_GET(self):
        if not self._authorized():
            return self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
        parts = urlsplit(self.path)
        qs = parse_qs(parts.query)
        try:
            if parts.path == "/health":
                return self._json(HTTPStatus.OK, {"ok": True, "service": "retriever"})
            if parts.path == "/retrieve":
                url = (qs.get("url") or [""])[0]
                if not url:
                    return self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "url is required"})
                page = retrieve(url, use_cache=(qs.get("cache") or ["1"])[0] != "0")
                return self._json(HTTPStatus.OK, {"ok": True, "page": page_json(page, include_text=True)})
            if parts.path == "/search":
                query = (qs.get("q") or [""])[0].strip()
                if not query:
                    return self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "q is required"})
                limit = int((qs.get("limit") or ["20"])[0])
                return self._json(HTTPStatus.OK, {"ok": True, "results": search_index(query, limit)})
            if parts.path == "/stats":
                return self._json(HTTPStatus.OK, {"ok": True, "stats": stats()})
            return self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
        except RetrieverError as exc:
            return self._json(HTTPStatus.BAD_GATEWAY, {"ok": False, "error": str(exc)})
        except Exception as exc:
            return self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("[retriever-service] " + (fmt % args))


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[retriever-service] listening on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
