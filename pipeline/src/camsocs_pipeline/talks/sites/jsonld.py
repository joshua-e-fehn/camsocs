"""schema.org events embedded in department pages (source kind ``json_ld``,
source type ``dept_jsonld``), and the detail-page reader the other parsers
share.

**A listing with events in it.** When the source page itself carries
JSON-LD or microdata items of an ``Event`` type (``Event``,
``EducationEvent``, ``SocialEvent`` …, inside ``@graph`` too), each one is
an item: ``name``, ``startDate`` / ``endDate`` (ISO; naive = London),
``location`` (a place's name and address, or ``VirtualLocation`` = online),
``performer`` (speakers), ``description`` (the abstract),
``eventStatus`` (cancelled or postponed) and ``eventAttendanceMode``
(online or mixed = online).

**A listing of links.** Otherwise the page's links to detail pages on its
own host (paths with ``/event``, ``/seminar``, ``/talk`` or ``/lecture`` in
them, not the listing itself, not a pager or filter link) are followed, at
most `common.DETAIL_CAP`, and each page's own event item is read.

**Machine-readable times outside JSON-LD** (`machine_times`), for pages
that have none: Drupal's RDFa ``property="dc:date" content="…"`` (start,
then ``date-display-end``), microdata ``itemprop="startDate"`` and HTML
``<time datetime>``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from selectolax.lexbor import LexborHTMLParser, LexborNode

from camsocs_pipeline.events.common import clean_text
from camsocs_pipeline.sources.websites.events import structured_events
from camsocs_pipeline.sources.websites.page import parse_page
from camsocs_pipeline.talks.sites.common import (
    ParsedTalk,
    SiteContext,
    canonical,
    first,
    parse_iso,
    single_line,
    speaker_line,
    speakers_from,
    talks_cam_id,
)

SOURCE_TYPE = "dept_jsonld"

_DETAIL_PATH = re.compile(r"/(?:events?|seminars?|talks?|lectures?)(?:/|-|$)", re.IGNORECASE)
_PAGER = re.compile(r"[?&](?:page|filter|sort|type|category)=", re.IGNORECASE)


@dataclass
class Detail:
    """What a detail page adds to a listed item."""

    starts_at: datetime | None = None
    ends_at: datetime | None = None
    all_day: bool = False
    title: str | None = None
    venue: str | None = None
    abstract: str | None = None
    speakers: list[dict[str, str]] = field(default_factory=list)
    online: bool | None = None
    cancelled: bool | None = None
    talks_cam_id: int | None = None


# --- schema.org items --------------------------------------------------------------------


def _text(value: Any) -> str | None:
    if isinstance(value, list):
        value = next((v for v in value if isinstance(v, str) and v.strip()), None)
    if isinstance(value, dict):
        value = value.get("name")
    return clean_text(value) if isinstance(value, str) else None


def _types(item: dict[str, Any]) -> list[str]:
    value = item.get("@type")
    values = value if isinstance(value, list) else [value]
    return [v for v in values if isinstance(v, str)]


def _location(value: Any) -> tuple[str | None, bool]:
    """``(venue text, online)`` from a schema.org ``location``."""
    values = value if isinstance(value, list) else [value]
    names: list[str] = []
    online = False
    for place in values:
        if isinstance(place, str):
            if place.strip():
                names.append(place.strip())
            continue
        if not isinstance(place, dict):
            continue
        if any("VirtualLocation" in t for t in _types(place)):
            online = True
            continue
        name = _text(place.get("name"))
        address = place.get("address")
        if isinstance(address, dict):
            address = ", ".join(
                part
                for part in (
                    _text(address.get("streetAddress")),
                    _text(address.get("addressLocality")),
                )
                if part
            )
        address_text = _text(address) if address else None
        if name and address_text and address_text not in name:
            names.append(f"{name}, {address_text}")
        elif name or address_text:
            names.append(name or address_text or "")
    return (", ".join(n for n in names if n) or None), online


def _performers(value: Any) -> list[dict[str, str]]:
    values = value if isinstance(value, list) else [value]
    speakers: list[dict[str, str]] = []
    for person in values:
        if isinstance(person, str):
            speakers.extend(speakers_from(person))
        elif isinstance(person, dict):
            name = _text(person.get("name"))
            if not name:
                continue
            affiliation = _text(person.get("affiliation") or person.get("worksFor"))
            speakers.append({"name": name, **({"affiliation": affiliation} if affiliation else {})})
    return speakers


def item_detail(item: dict[str, Any]) -> Detail | None:
    """One schema.org event item → its fields, or None without a start."""
    start = parse_iso(_text(item.get("startDate")))
    if start is None:
        return None
    end = parse_iso(_text(item.get("endDate")))
    venue, virtual = _location(item.get("location"))
    status = (_text(item.get("eventStatus")) or "").lower()
    mode = (_text(item.get("eventAttendanceMode")) or "").lower()
    return Detail(
        starts_at=start[0],
        ends_at=end[0] if end else None,
        all_day=start[1],
        title=_text(item.get("name")),
        venue=venue,
        abstract=_text(item.get("description")),
        speakers=_performers(item.get("performer")),
        online=True if virtual or "online" in mode or "mixed" in mode else None,
        cancelled=True if "cancelled" in status or "postponed" in status else None,
    )


def page_items(html: str, url: str) -> list[dict[str, Any]]:
    return structured_events(parse_page(url, html))


# --- machine-readable times outside JSON-LD ---------------------------------------------


def machine_times(html: str) -> tuple[datetime, datetime | None, bool] | None:
    """The first start (and end) a page states in RDFa, microdata or
    ``<time datetime>`` (module docstring)."""
    tree = LexborHTMLParser(html)
    starts: list[str] = []
    end: str | None = None
    for node in tree.css('[property="dc:date"][content]'):
        value = node.attributes.get("content") or ""
        if "date-display-end" in (node.attributes.get("class") or ""):
            end = end or value
        else:
            starts.append(value)
    for node in tree.css('[itemprop="startDate"]'):
        starts.append(node.attributes.get("content") or node.attributes.get("datetime") or "")
    for node in tree.css('[itemprop="endDate"]'):
        end = end or node.attributes.get("content") or node.attributes.get("datetime")
    if not starts:
        stamps = [n.attributes.get("datetime") or "" for n in tree.css("time[datetime]")]
        stamps = [s for s in stamps if len(s) > 10]
        if stamps:
            starts.append(stamps[0])
            if len(stamps) > 1:
                end = end or stamps[1]
    start = next((p for p in (parse_iso(s) for s in starts) if p), None)
    if start is None:
        return None
    end_at = parse_iso(end) if end else None
    return start[0], end_at[0] if end_at else None, start[1]


def labelled_fields(node: LexborNode) -> dict[str, str]:
    """``Label: value`` fields of a Drupal 7–10 node, by lower-cased label."""
    fields: dict[str, str] = {}
    for cell in node.css(".field, .views-field"):
        label = cell.css_first(".field-label, .field__label, .views-label")
        if label is None:
            continue
        key = " ".join((label.text() or "").lower().replace(":", " ").split())
        value_node = cell.css_first(".field-items, .field__item, .field-content")
        value = single_line(value_node.text(separator=" ") if value_node else None)
        if key and value and key not in fields:
            fields[key] = value
    return fields


# --- detail pages ---------------------------------------------------------------------------


def _prose(tree: LexborHTMLParser) -> str | None:
    """A detail page's body text: the UIS theme's prose block, Drupal's body
    field, or the page's ``<main>``."""
    for selector in (
        '[data-testid="prose"]',
        ".field-name-body",
        ".field--name-body",
        "article .content",
        "main",
    ):
        node = tree.css_first(selector)
        if node is not None:
            text = clean_text(node.html)
            if text and len(text) > 40:
                return text
    return None


def read_detail(html: str, url: str) -> Detail:
    """Everything a detail page states (JSON-LD first, then RDFa / time)."""
    detail = next((d for d in (item_detail(i) for i in page_items(html, url)) if d), None)
    if detail is None:
        detail = Detail()
        times = machine_times(html)
        if times:
            detail.starts_at, detail.ends_at, detail.all_day = times
    tree = LexborHTMLParser(html)
    if not detail.venue:
        fields = labelled_fields(tree.css_first("main") or tree.body or tree.root)
        detail.venue = fields.get("location") or fields.get("venue") or fields.get("where")
    prose = _prose(tree)
    if not detail.abstract:
        detail.abstract = prose
    if not detail.speakers:
        detail.speakers = speaker_line(prose)
    detail.talks_cam_id = talks_cam_id(html)
    return detail


def merge(item: ParsedTalk, detail: Detail | None) -> ParsedTalk:
    """`item` with what its detail page adds: the page's own times win (a
    card shows less), the listing's title and venue stay unless missing."""
    if detail is None:
        return item
    if detail.starts_at is not None:
        item.starts_at = detail.starts_at
        item.ends_at = detail.ends_at or (item.ends_at if not detail.all_day else None)
        item.all_day = detail.all_day
    item.venue = item.venue or detail.venue
    item.abstract = item.abstract or detail.abstract
    item.speakers = item.speakers or detail.speakers
    item.online = detail.online if detail.online is not None else item.online
    item.cancelled = detail.cancelled if detail.cancelled is not None else item.cancelled
    item.talks_cam_id = item.talks_cam_id or detail.talks_cam_id
    return item


# --- the source ---------------------------------------------------------------------------


def _detail_links(html: str, base: str) -> list[str]:
    tree = LexborHTMLParser(html)
    root = tree.css_first("main") or tree.body or tree.root
    listing = canonical(base)
    host = urlsplit(base).netloc.lower()
    links: list[str] = []
    for anchor in root.css("a[href]") if root is not None else []:
        href = (anchor.attributes.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        url = canonical(href, base)
        parts = urlsplit(url)
        if parts.netloc != host or url == listing or _PAGER.search(url):
            continue
        if not _DETAIL_PATH.search(parts.path) or parts.path.rstrip("/") == urlsplit(
            listing
        ).path.rstrip("/"):
            continue
        links.append(url)
    return list(dict.fromkeys(links))


def collect(ctx: SiteContext) -> None:
    listing = ctx.get(ctx.source.url)
    html = listing.text
    page_url = listing.final_url or ctx.source.url
    items = page_items(html, page_url)
    if items:
        for item in items:
            detail = item_detail(item)
            if detail is None or detail.starts_at is None:
                ctx.read.drop("no date")
                continue
            own = first([_text(item.get("url")), _text(item.get("@id"))])
            url = canonical(own, page_url) if own else canonical(page_url)
            # Items without their own URL all point at the listing: tell them
            # apart by their start (one key per item, `sites._unique`).
            external = url if own else f"{url}#{detail.starts_at.isoformat()}"
            parsed = ParsedTalk(
                external_id=external,
                url=url,
                source_url=page_url,
                title=detail.title or "",
                starts_at=detail.starts_at,
            )
            ctx.keep(merge(parsed, detail), listing)
        return
    for url in _detail_links(html, page_url):
        result = ctx.detail(url)
        if result is None:
            continue
        detail = read_detail(result.text, url)
        if detail.starts_at is None:
            ctx.read.drop("no date")
            continue
        title = detail.title or _page_title(result.text)
        parsed = ParsedTalk(
            external_id=url,
            url=url,
            source_url=page_url,
            title=title or "",
            starts_at=detail.starts_at,
        )
        ctx.keep(merge(parsed, detail), result)


def _page_title(html: str) -> str | None:
    tree = LexborHTMLParser(html)
    node = tree.css_first("h1") or tree.css_first("title")
    return clean_text(node.text()) if node is not None else None
