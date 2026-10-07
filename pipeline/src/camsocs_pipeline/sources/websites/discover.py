"""Which few pages of a society's site to read besides the home page (§14).

The LLM reads at most ~12k characters per organisation, so the pages are
chosen for what they usually hold: **about**, **join** / membership,
**committee**, **contact**, **events**, **sponsors** / partners. One page per
kind, scored by the link's path (stronger) and its anchor text, shallower
paths first.

Only links inside the site are followed — the same host, and under the
starting path when the "website" is a sub-page of a bigger site (a society
page on a department's site must not lead to the department's own "about").
Never followed: files, login / account / members-only areas (Raven), feeds,
anchors on the same page, and anything when the home page says ``nofollow``.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

from camsocs_pipeline.sources.websites.page import Link

KINDS: dict[str, tuple[str, ...]] = {
    "about": (r"about", r"who[- ]?we[- ]?are", r"our[- ]?story", r"history", r"what[- ]?we[- ]?do"),
    "join": (
        r"join",
        r"membership",
        r"become[- ]?a[- ]?member",
        r"sign[- ]?up",
        r"get[- ]?involved",
        r"freshers?",
    ),
    "committee": (
        r"committee",
        r"exec(utive)?",
        r"officers?",
        r"our[- ]?team",
        r"the[- ]?team",
        r"meet[- ]?the",
        r"who'?s[- ]?who",
        r"people",
    ),
    "contact": (r"contact", r"get[- ]?in[- ]?touch"),
    "events": (
        r"events?",
        r"calendar",
        r"what'?s[- ]?on",
        r"term[- ]?card",
        r"programme",
        r"fixtures",
        r"training",
        r"sessions",
    ),
    "sponsors": (
        r"sponsors?(hip)?",
        r"partners?(hips)?",
        r"work[- ]?with[- ]?us",
        r"corporate",
        r"supporters",
    ),
}
_COMPILED = {
    kind: re.compile(r"(?<![a-z])(" + "|".join(patterns) + r")(?![a-z])", re.I)
    for kind, patterns in KINDS.items()
}
_FILE = re.compile(
    r"\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|ics|xml|rss|css|js)$", re.I
)
_PRIVATE = re.compile(
    r"(login|log-in|signin|sign-in|wp-admin|wp-login|account|my-account|members-only|"
    r"members-area|raven|auth|cart|checkout|basket|feed|wp-json|xmlrpc|\?s=|/tag/|/category/"
    r"|/author/|/page/\d)",
    re.I,
)

#: Kinds in the order their pages are worth reading.
ORDER = ("about", "join", "committee", "contact", "events", "sponsors")


def _norm(url: str) -> str:
    parts = urlsplit(url)
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme, parts.netloc.lower(), path, parts.query, ""))


def in_scope(url: str, home: str) -> bool:
    """Same host (``www.`` aside) and, for a sub-page site, under its path."""
    target, base = urlsplit(url), urlsplit(home)
    host = target.netloc.lower().removeprefix("www.")
    if host != base.netloc.lower().removeprefix("www."):
        return False
    base_path = base.path.rstrip("/")
    if base_path and not (target.path == base_path or target.path.startswith(base_path + "/")):
        return False
    return not _FILE.search(target.path) and not _PRIVATE.search(f"{target.path}?{target.query}")


def choose_pages(home: str, links: list[Link], *, nofollow: bool = False) -> dict[str, str]:
    """``kind → url`` of the best page per kind (at most one each)."""
    if nofollow:
        return {}
    home_norm = _norm(home)
    best: dict[str, tuple[float, str]] = {}
    for link in links:
        if not in_scope(link.url, home):
            continue
        target = _norm(link.url.split("#", 1)[0])
        if target == home_norm:
            continue
        path = urlsplit(target).path
        depth = len([part for part in path.split("/") if part])
        for kind in ORDER:
            pattern = _COMPILED[kind]
            score = 0.0
            if pattern.search(path.replace("_", "-")):
                score += 2
            if pattern.search(link.text):
                score += 1
            if not score:
                continue
            score -= 0.25 * max(depth - 1, 0)
            if link.region in ("nav", "header"):
                score += 0.25
            current = best.get(kind)
            if (
                current is None
                or score > current[0]
                or (score == current[0] and target < current[1])
            ):
                best[kind] = (score, target)
    chosen: dict[str, str] = {}
    used: set[str] = set()
    for kind in ORDER:
        if kind in best and best[kind][1] not in used:
            chosen[kind] = best[kind][1]
            used.add(best[kind][1])
    return chosen


__all__ = ["KINDS", "ORDER", "choose_pages", "in_scope"]
