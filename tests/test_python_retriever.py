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


if __name__ == "__main__":
    unittest.main()
