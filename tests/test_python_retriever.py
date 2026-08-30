#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import sys
import unittest
from unittest.mock import patch
import types

# Keep parser/security unit tests independent of optional runtime packages.
if "curl_cffi" not in sys.modules:
    curl_cffi = types.ModuleType("curl_cffi")
    curl_cffi.requests = types.SimpleNamespace(Session=lambda: None)
    sys.modules["curl_cffi"] = curl_cffi
if "psycopg" not in sys.modules:
    psycopg = types.ModuleType("psycopg")
    psycopg.connect = lambda *a, **k: None
    rows = types.ModuleType("psycopg.rows")
    rows.dict_row = object()
    psycopg.rows = rows
    sys.modules["psycopg"] = psycopg
    sys.modules["psycopg.rows"] = rows

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("retriever", ROOT / "python_retriever" / "retriever.py")
retriever = importlib.util.module_from_spec(SPEC)
sys.modules["retriever"] = retriever
SPEC.loader.exec_module(retriever)


class RetrieverParserTests(unittest.TestCase):
    def test_parse_html(self):
        html = """<html><head><title> Demo Page </title><meta name='description' content=' Demo description '>
        <link rel='canonical' href='/canonical'></head><body><script>ignore me</script>
        <h1>Hello world</h1><a href='/next?utm_source=x&a=1'>Next page</a></body></html>"""
        title, desc, text, canonical, links = retriever._parse_html(html, "https://example.com/start")
        self.assertEqual(title, "Demo Page")
        self.assertEqual(desc, "Demo description")
        self.assertEqual(canonical, "https://example.com/canonical")
        self.assertIn("Hello world", text)
        self.assertNotIn("ignore me", text)
        self.assertEqual(links[0]["url"], "https://example.com/next?a=1")

    def test_challenge_detection(self):
        reason = retriever._challenge_reason(
            200,
            {},
            "Just a moment...",
            "<script src='https://challenges.cloudflare.com/x'></script>Cloudflare",
        )
        self.assertTrue(reason)

    @patch.dict(os.environ, {"RETRIEVER_ALLOWED_HOSTS": "example.com"})
    @patch("socket.getaddrinfo")
    def test_allowlist_and_private_ip_guard(self, mocked_dns):
        mocked_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]
        self.assertEqual(retriever.validate_url("https://example.com/a#x"), "https://example.com/a")
        with self.assertRaises(retriever.DisallowedUrlError):
            retriever.validate_url("https://not-example.test/")

    @patch.dict(os.environ, {
        "RETRIEVER_ALLOWED_HOSTS": "example.com",
        "SCRAPERAPI_KEY": "test-key",
    })
    @patch("socket.getaddrinfo")
    def test_scraperapi_standard_endpoint_only(self, mocked_dns):
        mocked_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]

        class FakeResponse:
            status_code = 200
            url = "https://api.scraperapi.com/"
            headers = {"content-type": "text/html"}
            content = b"<html><head><title>OK</title></head><body>Hello</body></html>"

        class FakeSession:
            def __init__(self):
                self.calls = []
            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return FakeResponse()
            def close(self):
                pass

        with patch.object(retriever, "SCRAPERAPI_KEY", "test-key"):
            client = retriever.Retriever(provider="scraperapi")
        client.session = FakeSession()
        raw = client.raw_fetch("https://example.com/page", respect_robots=False)
        self.assertEqual(raw.status_code, 200)
        endpoint, kwargs = client.session.calls[0]
        self.assertEqual(endpoint, client.scraperapi_endpoint)
        self.assertEqual(kwargs["params"], {
            "api_key": "test-key",
            "url": "https://example.com/page",
        })
        self.assertNotIn("render", kwargs["params"])
        self.assertNotIn("premium", kwargs["params"])
        self.assertNotIn("session_number", kwargs["params"])

    @patch.dict(os.environ, {"RETRIEVER_ALLOWED_HOSTS": "example.com"})
    @patch("socket.getaddrinfo")
    def test_raw_fetch_rejects_challenge_html(self, mocked_dns):
        mocked_dns.return_value = [(2, 1, 6, "", ("93.184.216.34", 443))]

        class FakeResponse:
            status_code = 200
            url = "https://example.com/"
            headers = {"content-type": "text/html"}
            content = b"<html><head><title>Just a moment...</title></head><body>Cloudflare <script src='https://challenges.cloudflare.com/x'></script></body></html>"

        class FakeSession:
            def get(self, *a, **k):
                return FakeResponse()
            def close(self):
                pass

        client = retriever.Retriever(provider="direct")
        client.session = FakeSession()
        with self.assertRaises(retriever.BlockedPageError):
            client.raw_fetch("https://example.com/", respect_robots=False)


if __name__ == "__main__":
    unittest.main()
