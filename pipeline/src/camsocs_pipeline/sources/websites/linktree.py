"""Linktree pages (source-research §13): ``linktr.ee/<handle>`` is server-
rendered and its links sit in the ``__NEXT_DATA__`` JSON. Read
deterministically — a Linktree is a list of links, nothing for an LLM.

Linktree's robots.txt is honoured like any other: on 2026-10-07 it answered
403 to our User-Agent, which the polite client treats as "disallow
everything", so in practice these pages are recorded as disallowed and never
read. The parser stays for the day that changes.
"""

from __future__ import annotations

import json
from typing import Any

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.sources.websites.page import Link


def linktree_links(html: str) -> list[Link]:
    """The links of a Linktree page (title as the anchor text), in page order."""
    tree = LexborHTMLParser(html)
    script = tree.css_first("script#__NEXT_DATA__")
    if script is None:
        return []
    try:
        data = json.loads(script.text())
    except ValueError:
        return []
    account: dict[str, Any] = data.get("props", {}).get("pageProps", {}).get("account", {}) or {}
    out: list[Link] = []
    for entry in [*(account.get("links") or []), *(account.get("socialLinks") or [])]:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            title = entry.get("title") or entry.get("type") or ""
            out.append(Link(url, str(title)[:200], "main"))
    return out


__all__ = ["linktree_links"]
