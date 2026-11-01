"""RSS 2.0 and Atom feeds of department events (source kind ``rss``, source
type ``dept_rss``). A feed item is a talk only with an **event** date, which
feeds put in different places; tried in order:

1. **An event-date element** in any namespace: ``ev:startdate`` /
   ``ev:enddate`` (the RSS event module), ``xcal:dtstart``, or a
   ``startDate`` / ``start_date`` / ``eventDate`` / ``event_date`` element
   (plugins' custom fields); a ``location`` / ``venue`` element is the venue.
2. **A Drupal date field inside the description** (Drupal 7 feeds such as
   Computer Science's seminars): RDFa ``property="dc:date" content="…"``,
   ``<time datetime>`` (`jsonld.machine_times`).
3. **A publication date in the future** (Hugo sites such as the Centre for
   Music and Science date each event page by its start): a post is never
   published after the moment it is read, so a ``pubDate`` / ``published``
   later than the fetch is the event's start. A past ``pubDate`` is a post
   date and is never used.
4. **The item's own page** (on the feed's host, at most
   `common.DETAIL_CAP`): its JSON-LD or RDFa (`jsonld.read_detail`). The Law
   Faculty's feeds give only the event month, in the link
   (``/press/events/2026/11/<slug>``); an item whose month lies outside the
   window is not read at all.

An item with none of these is skipped (``no event date``).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from camsocs_pipeline.events.common import LONDON, EventWindow
from camsocs_pipeline.talks.sites import jsonld
from camsocs_pipeline.talks.sites.common import (
    ParsedTalk,
    SiteContext,
    SourceError,
    canonical,
    mirrored_talks_cam_id,
    parse_iso,
    retrieved_at,
    talks_cam_id,
)

SOURCE_TYPE = "dept_rss"

_START_NAMES = frozenset(
    {"startdate", "start_date", "eventdate", "event_date", "dtstart", "eventstart", "event_start"}
)
_END_NAMES = frozenset({"enddate", "end_date", "dtend", "eventend", "event_end"})
_VENUE_NAMES = frozenset({"location", "venue"})
_MONTH_PATH = re.compile(r"/((?:19|20)\d\d)/(0[1-9]|1[0-2])/")


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, *names: str) -> str | None:
    for child in element:
        if _local(child.tag) in names and (child.text or "").strip():
            return (child.text or "").strip()
    return None


def _link(element: ET.Element) -> str | None:
    for child in element:
        if _local(child.tag) != "link":
            continue
        href = child.attrib.get("href")
        if href and child.attrib.get("rel", "alternate") == "alternate":
            return href.strip()
        if (child.text or "").strip():
            return (child.text or "").strip()
    return None


def _dated(value: str | None) -> tuple[datetime, bool] | None:
    """``(moment, date_only)`` from an RFC 822 or ISO 8601 value."""
    if not value:
        return None
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return parse_iso(value.strip())
    return (moment if moment.tzinfo else moment.replace(tzinfo=LONDON)), False


def _date(value: str | None) -> datetime | None:
    dated = _dated(value)
    return dated[0] if dated else None


def feed_items(data: bytes) -> list[ET.Element]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise ValueError(f"not an RSS or Atom feed: {error}") from error
    return [e for e in root.iter() if _local(e.tag) in ("item", "entry")]


def _month_outside(url: str, window: EventWindow) -> bool:
    """Whether a link's ``/YYYY/MM/`` month lies wholly outside the window."""
    match = _MONTH_PATH.search(urlsplit(url).path)
    if match is None:
        return False
    month = (int(match.group(1)), int(match.group(2)))
    return month not in window.months()


def parse_item(
    element: ET.Element, feed_url: str, read_at: datetime
) -> tuple[ParsedTalk | None, str | None]:
    """``(item, link)``: the item when the feed itself dates the event, else
    None and the link to read for a date."""
    title = _child_text(element, "title") or ""
    link = _link(element)
    url = canonical(link, feed_url) if link else feed_url
    description = _child_text(element, "description", "summary", "content", "encoded")
    external = _child_text(element, "guid", "id") or url
    dated = _dated(next((c.text for c in element if _local(c.tag) in _START_NAMES), None))
    start, all_day = dated if dated else (None, False)
    ended = _dated(next((c.text for c in element if _local(c.tag) in _END_NAMES), None))
    end = ended[0] if ended else None
    if all_day and ended and ended[1]:
        end = end + timedelta(days=1) if end else None  # the last day, inclusive
    if start is None and description:
        times = jsonld.machine_times(description)
        if times is not None:
            start, end, all_day = times
    if start is None:
        published = _date(_child_text(element, "pubdate", "published"))
        if published is not None and published > read_at:
            start = published
    if start is None:
        return None, url
    item = ParsedTalk(
        external_id=external,
        url=url,
        source_url=feed_url,
        title=title,
        starts_at=start,
        ends_at=end,
        all_day=all_day,
        venue=_child_text(element, *_VENUE_NAMES),
        abstract=description,
        categories=[(c.text or "").strip() for c in element if _local(c.tag) == "category"],
        talks_cam_id=mirrored_talks_cam_id(url) or talks_cam_id(link, description),
    )
    return item, url


def collect(ctx: SiteContext) -> None:
    result = ctx.get(ctx.source.url, accept="application/rss+xml, application/atom+xml, */*;q=0.5")
    try:
        elements = feed_items(result.content or b"")
    except ValueError as error:
        raise SourceError(f"{error}: {ctx.source.url}") from error
    read_at = retrieved_at(result)
    for element in elements:
        item, url = parse_item(element, ctx.source.url, read_at)
        if item is not None:
            ctx.keep(item, result)
            continue
        if url is None or url == ctx.source.url or _month_outside(url, ctx.window):
            ctx.read.drop("no event date")
            continue
        listed = ParsedTalk(
            external_id=url,
            url=url,
            source_url=ctx.source.url,
            title=_child_text(element, "title") or "",
            starts_at=read_at,
            categories=[(c.text or "").strip() for c in element if _local(c.tag) == "category"],
        )
        if not ctx.looks_like_a_talk(listed):
            ctx.read.drop("not a talk")
            continue
        page = ctx.detail(url)
        detail = jsonld.read_detail(page.text, url) if page is not None else None
        if detail is None or detail.starts_at is None:
            ctx.read.drop("no event date")
            continue
        title = _child_text(element, "title") or detail.title or ""
        parsed = ParsedTalk(
            external_id=_child_text(element, "guid", "id") or url,
            url=url,
            source_url=ctx.source.url,
            title=title,
            starts_at=detail.starts_at,
            categories=[(c.text or "").strip() for c in element if _local(c.tag) == "category"],
        )
        jsonld.merge(parsed, detail)
        parsed.abstract = parsed.abstract or _child_text(element, "description")
        ctx.keep(parsed, page or result)
