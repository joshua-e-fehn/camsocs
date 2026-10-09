"""Termcards: a society's term programme as a PDF or image (source-research §21).

`fetch_termcard` fetches a `termcardUrl` through the polite client (robots.txt,
per-host pacing, cache) with a society purpose (`sources/policy.py`, D3: the
society published the card). The URL may be the file itself, or a page that
shows it — then the first linked or embedded PDF/image that looks like a
termcard is followed, one level deep and robots-checked like any other fetch.

- **Cambridge SU** (source-research §1, §21): profile resources are
  ``/file/<id>/<name>/`` links. They are fetched now (D3), but on 2026-10-08
  they redirected to the SU login page, which is never followed: such a card
  is recorded ``access_restricted``. A file under the robots-disallowed
  ``/asset/`` is read under the society override (``robots_override:society``).
- Hosts never fetched for a termcard (`never_fetched`), recorded as skipped
  with the reason before any request: **talks.cam** and tbc.xyz (§6: their
  content never reaches the LLM), and **Instagram, Facebook, LinkedIn** and
  the other networks (links only).

A fetched card reaches the vision model only when every host it came from
lets AI read it (§14): `PoliteClient.ai_input_allowed` for the page's and the
file's final URLs (no AI crawler disallowed by name, no
``Content-Signal: ai-input=no``), and no ``noai`` robots meta on a page that
embeds it — or the D3 society override lifts that opt-out
(`TermcardFile.ai_override`), which never happens for talks.cam or tbc.xyz.

`term_hint` reads the term a card is for from its URL or file name
("CUHCS-Michaelmas-Term-Card", "termcard-LT27.pdf").

**Old cards** (`stale_reason`): a card whose URL or link names a term of an
earlier academic year ("lent-2024-term-card", "Easter 2026 Termcard.pdf" in
2026-27), or that a WordPress-style upload path dates more than four months
before the academic year began (``/uploads/2021/04/termcard.png``), is not
read: it can only hold past events, and the vision model is the expensive
one. A page linking several cards follows the newest-named first
(`_file_links`). Image files are recognised by their name, by
Wix's media paths (``…~mv2.png/v1/fill/…``) and by lazy-loaded ``data-src``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from urllib.parse import unquote, urljoin

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.extract.images import vision_image
from camsocs_pipeline.extract.llm import NO_LLM_HOSTS
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.links import host_of
from camsocs_pipeline.sources.policy import SOCIETY, FetchPurpose, ai_optout_override
from camsocs_pipeline.sources.websites.page import robots_directives

#: A termcard changes at most once a term; re-download weekly at most.
FRESH_FOR = timedelta(days=7)
ACCEPT = "application/pdf,image/*;q=0.9,text/html;q=0.5,*/*;q=0.1"
_FILE_SUFFIXES = (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif")
_TERM_WORDS = re.compile(r"term[\s_-]?card|termcard|programme|program|schedule|poster", re.I)
_TERM_NAME = re.compile(r"(michaelmas|lent|easter)\D{0,12}(20\d\d)?", re.I)
_TERM_CODE = re.compile(r"(?<![a-z])(mt|lt|et)[\s_-]?(\d\d)(?!\d)", re.I)
_CODES = {"mt": "michaelmas", "lt": "lent", "et": "easter"}
#: A WordPress-style upload path: ``/uploads/2026/09/…``.
_UPLOAD_PATH = re.compile(r"/uploads/(20\d\d)/(0[1-9]|1[0-2])/")
#: Wix media: ``static.wixstatic.com/media/…~mv2.png/v1/fill/…``.
_WIX_MEDIA = re.compile(r"~mv2\.(?:png|jpe?g|webp|gif)(?:/|$)")

#: Hosts a termcard is never fetched from, with the reason the stage records.
NEVER_FETCHED: tuple[tuple[tuple[str, ...], str], ...] = (
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
#: The termcard URL is a page that links or embeds no card file: the stage
#: then reads the page's own text (`stages.termcards.page_events`).
NO_CARD_FILE = "a page without a readable termcard file"


@dataclass(frozen=True)
class TermcardFile:
    url: str
    #: `pdf` or `image`.
    kind: str
    data: bytes
    content_sha256: str
    fetch: FetchResult
    #: The card reaches the model only because the D3 society override lifted
    #: an AI opt-out on a host it came through (`policy.AI_OVERRIDE_NOTE`).
    ai_override: bool = False


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


def academic_start_year(today: date) -> int:
    """2026 for any day of 2026-27 (1 July turnover)."""
    return today.year if today.month >= 7 else today.year - 1


def stale_reason(text: str, today: date) -> str | None:
    """Why a card that `text` (its URL, file name or link label) describes is
    last year's or older, or None (module docstring)."""
    current = academic_start_year(today)
    name, year = term_hint(text)
    if name is not None and year is not None:
        academic = year if name == "michaelmas" else year - 1
        if academic < current:
            return "names a past term"
    upload = _UPLOAD_PATH.search(text)
    if upload:
        uploaded = date(int(upload.group(1)), int(upload.group(2)), 1)
        if uploaded < date(current, 3, 1):
            return "uploaded before this academic year"
    return None


def _is_file(path: str) -> bool:
    return path.endswith(_FILE_SUFFIXES) or bool(_WIX_MEDIA.search(path))


_TERM_ORDER = {"michaelmas": 0, "lent": 1, "easter": 2}


def _recency(text: str) -> tuple[int, int] | None:
    """(academic year, term) a link names, for putting the newest first."""
    name, year = term_hint(text)
    if name is None or year is None:
        return None
    return (year if name == "michaelmas" else year - 1, _TERM_ORDER[name])


def _file_links(html: str, base: str) -> list[str]:
    """Linked or embedded PDFs/images whose name, label or alt text says
    termcard / programme / poster: those naming a term newest first (a page
    listing this term's card beside last year's), then the others in page
    order."""
    tree = LexborHTMLParser(html)
    named: list[tuple[tuple[int, int], int, str]] = []
    unnamed: list[str] = []
    selector = "a[href], img[src], img[data-src], embed[src], iframe[src], object[data]"
    for position, node in enumerate(tree.css(selector)):
        attrs = node.attributes
        target = (
            attrs.get("href") or attrs.get("data-src") or attrs.get("src") or attrs.get("data")
        ) or ""
        absolute = urljoin(base, target.strip())
        if not absolute.startswith(("http://", "https://")):
            continue
        path = absolute.split("?", 1)[0].split("#", 1)[0].lower()
        if not _is_file(path):
            continue
        label = " ".join(filter(None, [attrs.get("alt"), attrs.get("title"), node.text(), path]))
        if not _TERM_WORDS.search(label):
            continue
        recency = _recency(unquote(label))
        if recency is None:
            unnamed.append(absolute)
        else:
            named.append(((-recency[0], -recency[1]), position, absolute))
    ordered: list[str] = []
    for url in [url for _r, _p, url in sorted(named)] + unnamed:
        if url not in ordered:
            ordered.append(url)
    return ordered


def never_fetched(url: str) -> str | None:
    """Why a termcard at `url` is never fetched, or None."""
    host = host_of(url)
    for hosts, reason in NEVER_FETCHED:
        if any(host == domain or host.endswith("." + domain) for domain in hosts):
            return reason
    return None


@dataclass(frozen=True)
class _AiCheck:
    #: Why the content must not reach the model, or None.
    refusal: str | None = None
    #: An opt-out was lifted by the D3 society override.
    override: bool = False


def _ai_check(
    client: PoliteClient, purpose: FetchPurpose, *urls: str, page_noai: bool = False
) -> _AiCheck:
    """Whether content fetched through `urls` may reach the model. An AI
    opt-out (robots.txt, or `page_noai` on the page) is lifted where the D3
    society override applies; talks.cam and tbc.xyz never are."""
    override = False
    # A declared class covers the first URL's site only, not a redirect's.
    purpose = purpose.bound_to(urls[0]) if urls else purpose
    for url in urls:
        reason = never_fetched(url)
        if reason is not None:
            return _AiCheck(reason)
        if client.ai_input_allowed(url) and not page_noai:
            continue
        if ai_optout_override(url, purpose):
            override = True
            continue
        return _AiCheck(HOST_KEEPS_AI_OUT)
    return _AiCheck(None, override)


def fetch_termcard(
    client: PoliteClient, url: str, purpose: FetchPurpose = SOCIETY
) -> TermcardFile | Skipped:
    """The termcard file at `url` (or the first one the page at `url` links),
    fetched only from a host it may come from and returned only when every
    host it passed through lets AI read it, or the D3 society override lifts
    the opt-out — else `Skipped` with the reason. `purpose`: the society
    purpose, declaring ``society_website`` when the card is on the society's
    own domain."""
    reason = never_fetched(url)
    if reason is not None:
        return Skipped(url, reason)
    result = client.fetch(url, fresh_for=FRESH_FOR, accept=ACCEPT, purpose=purpose)
    if not result.ok or result.content is None:
        return Skipped(url, result.outcome + (f" ({result.detail})" if result.detail else ""))
    kind = _kind(result.content)
    if kind is not None:
        check = _ai_check(client, purpose, url, result.final_url)
        if check.refusal is not None:
            return Skipped(url, check.refusal)
        return TermcardFile(
            url, kind, result.content, result.content_sha256 or "", result, check.override
        )
    if "html" not in (result.content_type or "").lower():
        return Skipped(url, "not a PDF or image")
    page = _ai_check(
        client,
        purpose,
        url,
        result.final_url,
        page_noai=bool(robots_directives(result.text) & _NOAI),
    )
    if page.refusal is not None:
        return Skipped(url, page.refusal)
    # A file the page links is the page's site's only on that site: a card
    # on a shop's CDN keeps the CDN's robots.txt (the declared class does not
    # carry over, `FetchPurpose.bound_to`).
    linked_purpose = purpose.bound_to(result.final_url or url)
    for link in _file_links(result.text, result.final_url)[:2]:
        if never_fetched(link) is not None:
            continue
        linked = client.fetch(link, fresh_for=FRESH_FOR, accept=ACCEPT, purpose=linked_purpose)
        if not linked.ok or linked.content is None:
            continue
        linked_kind = _kind(linked.content)
        if linked_kind is None:
            continue
        check = _ai_check(client, linked_purpose, link, linked.final_url)
        if check.refusal is not None:
            return Skipped(url, check.refusal)
        return TermcardFile(
            link,
            linked_kind,
            linked.content,
            linked.content_sha256 or "",
            linked,
            page.override or check.override,
        )
    return Skipped(url, NO_CARD_FILE)


__all__ = [
    "NO_CARD_FILE",
    "Skipped",
    "TermcardFile",
    "academic_start_year",
    "fetch_termcard",
    "never_fetched",
    "stale_reason",
    "term_hint",
]
