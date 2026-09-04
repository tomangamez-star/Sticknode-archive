#!/usr/bin/env python3
"""
Authenticated StickNodes ingest entrypoint.

This wrapper keeps the normal/fast ingest code unchanged. It loads a temporary
Netscape-format cookies.txt file into the existing direct Retriever session,
then executes the already-working fast_ingest pipeline.
"""
import os
from pathlib import Path

import fast_ingest as fast

COOKIE_FILE = os.getenv("STICKNODES_COOKIES_FILE", "").strip()


def load_netscape_cookies(path):
    jar = fast.core.web_retriever.session.cookies
    loaded = 0

    for raw in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            if not line.startswith("#HttpOnly_"):
                continue
            line = line[len("#HttpOnly_"):]

        parts = line.split("\t")
        if len(parts) < 7:
            continue

        domain, include_subdomains, cookie_path, secure, expires, name = parts[:6]
        value = "\t".join(parts[6:])
        if not name:
            continue

        kwargs = {"domain": domain.lstrip("."), "path": cookie_path or "/"}
        try:
            jar.set(name, value, **kwargs)
        except TypeError:
            jar.set(name, value)
        loaded += 1

    return loaded


def main():
    if fast.core.web_retriever is None:
        raise RuntimeError("cookie ingest requires INGEST_FETCH_PROVIDER=retriever")
    if not COOKIE_FILE:
        raise RuntimeError("STICKNODES_COOKIES_FILE is not set")

    cookie_path = Path(COOKIE_FILE)
    if not cookie_path.is_file():
        raise RuntimeError(f"StickNodes cookie file does not exist: {COOKIE_FILE}")

    loaded = load_netscape_cookies(cookie_path)
    if loaded < 1:
        raise RuntimeError("No valid Netscape-format cookies were loaded")

    print(f"[auth] loaded {loaded} StickNodes cookies into direct retriever session")
    fast.core.main()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        fast.core.send_ingest_error_notification(error)
        raise
    finally:
        if fast.core.web_retriever is not None:
            fast.core.web_retriever.close()
        if fast.core._chrome_session is not None:
            fast.core._chrome_session.close()
        if fast.core._playwright_session is not None:
            fast.core._playwright_session.close()
        if fast._SUPER_TELEGRAM_SESSION is not None:
            fast._SUPER_TELEGRAM_SESSION.close()
