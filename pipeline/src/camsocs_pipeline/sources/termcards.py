"""Termcards: a society's term programme as a PDF or image (source-research §21).

`fetch_termcard` fetches a `termcardUrl` through the polite client (robots.txt,
per-host pacing, cache). The URL may be the file itself, or a page that shows
it — then the first linked or embedded PDF/image that looks like a termcard is
followed, one level deep and robots-checked like any other fetch.

Hosts never fetched for a termcard (`never_fetched`), recorded as skipped
with the reason before any request:
- **Cambridge SU** (source-research §1, §21): resource pages answered "Sorry,
  there was a problem" to an anonymous request on 2026-10-07, MSL serves the
  files under robots-disallowed `/asset/` and `/resourcehandler/`, and a
  `/file/<id>/Termcard/` link (allowed by robots.txt) redirects to the login
  page — so SU-hosted termcards are never fetched at all;
- **talks.cam** (§6): its content never reaches the LLM;
- **Instagram, Facebook, LinkedIn** and the other networks: links only.

A card that is fetched still reaches the vision model only when every host it
came from lets AI read it (§14, "the talks.cam rule applied to every site"):
`PoliteClient.ai_input_allowed` for the page's and the file's final URLs (no
AI crawler disallowed by name, no `Content-Signal: ai-input=no`), and no
`noai` robots meta on a page that embeds it.

`term_hint` reads the term a card is for from its URL or file name
("CUHCS-Michaelmas-Term-Card", "termcard-LT27.pdf").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urljoin

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.extract.images import vision_image
from camsocs_pipeline.extract.llm import NO_LLM_HOSTS
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.links import host_of
from camsocs_pipeline.sources.websites.page import robots_directives

#: A termcard changes at most once a term; re-download weekly at most.
FRESH_FOR = timedelta(days=7)
ACCEPT = "application/pdf,image/*;q=0.9,text/html;q=0.5,*/*;q=0.1"
_FILE_SUFFIXES = (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif")
_TERM_WORDS = re.compile(r"term[\s_-]?card|termcard|programme|program|schedule|poster", re.I)
_TERM_NAME = re.compile(r"(michaelmas|lent|easter)\D{0,12}(20\d\d)?", re.I)
_TERM_CODE = re.compile(r"(?<![a-z])(mt|lt|et)[\s_-]?(\d\d)(?!\d)", re.I)
_CODES = {"mt": "michaelmas", "lt": "lent", "et": "easter"}

#: Hosts a termcard is never fetched from, with the reason the stage records.
NEVER_FETCHED: tuple[tuple[tuple[str, ...], str], ...] = (
    (("cambridgesu.co.uk",), "SU-hosted: never fetched (source-research §21)"),
    (NO_LLM_HOSTS, "host keeps AI out (source-research §6)"),
    (
        (
            "instagram.com",
            "facebook.com",
            "fb.com",
            "linkedin.com",
            "x.com",
            "twitter.com",
            "tiktok.com",
            "threads.net",
        ),
        "a social network: links only",
    ),
)
#: Robots meta directives that keep a page's content from a model.
_NOAI = frozenset({"noai", "noimageai"})
HOST_KEEPS_AI_OUT = "host keeps AI out"


@dataclass(frozen=True)
class TermcardFile:
    url: str
    #: `pdf` or `image`.
    kind: str
    data: bytes
    content_sha256: str
    fetch: FetchResult


@dataclass(frozen=True)
class Skipped:
    url: str
    reason: str


def term_hint(text: str) -> tuple[str | None, int | None]:
    """`("michaelmas", 2026)` from "Michaelmas-Term-Card-2026" or "MT26"."""
    named = _TERM_NAME.search(text)
    if named:
        return named.group(1).lower(), int(named.group(2)) if named.group(2) else None
    coded = _TERM_CODE.search(text)
    if coded:
        return _CODES[coded.group(1).lower()], 2000 + int(coded.group(2))
    return None, None


def _kind(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "pdf"
    return "image" if vision_image(data) is not None else None


def _file_links(html: str, base: str) -> list[str]:
    """Linked or embedded PDFs/images whose name, label or alt text says
    termcard / programme / poster, in page order."""
    tree = LexborHTMLParser(html)
    scored: list[tuple[int, str]] = []
    for node in tree.css("a[href], img[src], embed[src], iframe[src], object[data]"):
        attrs = node.attributes
        target = attrs.get("href") or attrs.get("src") or attrs.get("data") or ""
        absolute = urljoin(base, target.strip())
        if not absolute.startswith(("http://", "https://")):
            continue
        path = absolute.split("?", 1)[0].split("#", 1)[0].lower()
        if not path.endswith(_FILE_SUFFIXES):
            continue
        label = " ".join(filter(None, [attrs.get("alt"), attrs.get("title"), node.text(), path]))
        scored.append((0 if _TERM_WORDS.search(label) else 1, absolute))
    ordered: list[str] = []
    for score, url in sorted(scored, key=lambda pair: pair[0]):
        if score == 0 and url not in ordered:
            ordered.append(url)
    return ordered


def never_fetched(url: str) -> str | None:
    """Why a termcard at `url` is never fetched, or None."""
    host = host_of(url)
    for hosts, reason in NEVER_FETCHED:
        if any(host == domain or host.endswith("." + domain) for domain in hosts):
            return reason
    return None


def _ai_refusal(client: PoliteClient, *urls: str) -> str | None:
    """Why content fetched through `urls` must not reach the model, or None."""
    for url in urls:
        reason = never_fetched(url)
        if reason is not None:
            return reason
        if not client.ai_input_allowed(url):
            return HOST_KEEPS_AI_OUT
    return None


def fetch_termcard(client: PoliteClient, url: str) -> TermcardFile | Skipped:
    """The termcard file at `url` (or the first one the page at `url` links),
    fetched only from a host it may come from and returned only when every
    host it passed through lets AI read it — else `Skipped` with the reason."""
    reason = never_fetched(url)
    if reason is not None:
        return Skipped(url, reason)
    result = client.fetch(url, fresh_for=FRESH_FOR, accept=ACCEPT)
    if not result.ok or result.content is None:
        return Skipped(url, result.outcome + (f" ({result.detail})" if result.detail else ""))
    kind = _kind(result.content)
    if kind is not None:
        refusal = _ai_refusal(client, url, result.final_url)
        if refusal is not None:
            return Skipped(url, refusal)
        return TermcardFile(url, kind, result.content, result.content_sha256 or "", result)
    if "html" not in (result.content_type or "").lower():
        return Skipped(url, "not a PDF or image")
    page_refusal = _ai_refusal(client, url, result.final_url)
    if page_refusal is None and robots_directives(result.text) & _NOAI:
        page_refusal = HOST_KEEPS_AI_OUT
    if page_refusal is not None:
        return Skipped(url, page_refusal)
    for link in _file_links(result.text, result.final_url)[:2]:
        if never_fetched(link) is not None:
            continue
        linked = client.fetch(link, fresh_for=FRESH_FOR, accept=ACCEPT)
        if not linked.ok or linked.content is None:
            continue
        linked_kind = _kind(linked.content)
        if linked_kind is None:
            continue
        refusal = _ai_refusal(client, link, linked.final_url)
        if refusal is not None:
            return Skipped(url, refusal)
        return TermcardFile(link, linked_kind, linked.content, linked.content_sha256 or "", linked)
    return Skipped(url, "a page without a readable termcard file")


__all__ = ["Skipped", "TermcardFile", "fetch_termcard", "never_fetched", "term_hint"]
