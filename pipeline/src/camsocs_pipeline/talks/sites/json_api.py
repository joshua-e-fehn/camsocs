"""The JSON event APIs some department sites expose (source kind
``json_api``, source type ``dept_json``). Recognised by the shape of the
answer, not by host, so another site running the same plugin needs no code:

- **The Events Calendar REST API** (``/wp-json/tribe/events/v1/events``,
  Cambridge Neuroscience): ``{"events": [{"title", "url", "start_date",
  "end_date", "all_day", "venue", "categories", "description"}],
  "next_rest_url"}``. ``start_date`` is the site's wall-clock time, read as
  London time (the sites label it "UTC+0" while meaning Cambridge time).
- **Judge Business School's event search** (``/wp-json/cjbs-event/v1/search``):
  ``{"post": [{"title", "permalink", "start_date" (Unix seconds, the day),
  "time" ("HH:MM-HH:MM"), "location", "categoryField"}], "pages"}``, paged
  with ``pagination=N``.
- **A plain array of events with an ``event_date``** (ai@cam's
  ``events.json``): ``[{"title", "url", "event_date": "YYYY-MM-DD",
  "category_name"}]``; a date without a time is an all-day item.

WordPress ``/wp/v2/<type>`` endpoints carry publication dates only, never an
event's, so no registry source points at one. Pages are followed at most
`common.MAX_PAGES` times.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from camsocs_pipeline.events.common import LONDON
from camsocs_pipeline.talks.sites.common import (
    MAX_PAGES,
    ParsedTalk,
    SiteContext,
    SourceError,
    canonical,
    london_day,
    parse_iso,
    parse_when,
    single_line,
    talks_cam_id,
)

SOURCE_TYPE = "dept_json"

_TAGS = re.compile(r"<[^>]+>")


def _str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    return None


def _names(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    names: list[str] = []
    for entry in values:
        if isinstance(entry, dict):
            name = _str(entry.get("name")) or _str(entry.get("venue"))
            if name:
                names.append(name)
        elif _str(entry):
            names.append(str(entry).strip())
    return names


# --- the three shapes ------------------------------------------------------------------------


def tribe_items(data: dict[str, Any], source_url: str) -> list[ParsedTalk]:
    items: list[ParsedTalk] = []
    for event in data.get("events") or []:
        if not isinstance(event, dict):
            continue
        start = parse_iso(_str(event.get("start_date")))
        if start is None:
            continue
        end = parse_iso(_str(event.get("end_date")))
        all_day = str(event.get("all_day")).lower() == "true" or start[1]
        url = canonical(_str(event.get("url")) or source_url)
        venue = event.get("venue")
        venue_text = ", ".join(_names(venue)) if venue else None
        items.append(
            ParsedTalk(
                external_id=_str(event.get("global_id")) or _str(event.get("id")) or url,
                url=url,
                source_url=source_url,
                title=single_line(_str(event.get("title"))) or "",
                starts_at=start[0],
                ends_at=end[0] if end else None,
                all_day=all_day,
                venue=venue_text or None,
                abstract=_str(event.get("description")),
                categories=_names(event.get("categories")),
                online=True if str(event.get("is_virtual")).lower() == "true" else None,
                talks_cam_id=talks_cam_id(_str(event.get("description"))),
            )
        )
    return items


def cjbs_items(data: dict[str, Any], source_url: str) -> list[ParsedTalk]:
    items: list[ParsedTalk] = []
    for post in data.get("post") or []:
        if not isinstance(post, dict):
            continue
        stamp = post.get("start_date")
        try:
            day = datetime.fromtimestamp(int(stamp), tz=UTC).astimezone(LONDON).date()
        except (TypeError, ValueError, OverflowError):
            continue
        when = parse_when(f"{day.isoformat()} {_str(post.get('time')) or ''}")
        if when is None:
            continue
        url = canonical(_str(post.get("permalink")) or source_url)
        categories = _TAGS.sub(" ", _str(post.get("categoryField")) or "")
        items.append(
            ParsedTalk(
                external_id=url,
                url=url,
                source_url=source_url,
                title=single_line(_str(post.get("title"))) or "",
                starts_at=when[0],
                ends_at=when[1],
                all_day=when[2],
                venue=", ".join(_names(post.get("location"))) or None,
                abstract=_str(post.get("excerpt")),
                categories=[c for c in (single_line(categories),) if c],
            )
        )
    return items


def dated_array_items(data: list[Any], source_url: str) -> list[ParsedTalk]:
    items: list[ParsedTalk] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        start = parse_iso(_str(entry.get("event_date")) or _str(entry.get("start_date")))
        if start is None:
            continue
        url = canonical(_str(entry.get("url")) or source_url, source_url)
        ends = start[0] + timedelta(days=1) if start[1] else None
        items.append(
            ParsedTalk(
                external_id=url,
                url=url,
                source_url=source_url,
                title=single_line(_str(entry.get("title"))) or "",
                starts_at=start[0],
                ends_at=ends,
                all_day=start[1],
                categories=[
                    c
                    for c in (_str(entry.get("category_name")), _str(entry.get("event_categories")))
                    if c
                ],
            )
        )
    return items


def parse_payload(data: Any, source_url: str) -> tuple[str, list[ParsedTalk]]:
    """``(shape, items)``; raises ValueError for a shape no parser reads."""
    if isinstance(data, dict) and isinstance(data.get("events"), list):
        return "tribe", tribe_items(data, source_url)
    if isinstance(data, dict) and isinstance(data.get("post"), list):
        return "cjbs", cjbs_items(data, source_url)
    if (
        isinstance(data, list)
        and all(isinstance(e, dict) for e in data)
        and (not data or any("event_date" in e or "start_date" in e for e in data))
    ):
        return "dated_array", dated_array_items(data, source_url)
    raise ValueError("an unknown JSON shape (no event dates)")


def _with_page(url: str, page: int) -> str:
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    query["pagination"] = [str(page)]
    return urlunsplit((*parts[:3], urlencode(query, doseq=True), ""))


def _next_url(shape: str, data: Any, url: str, page: int) -> str | None:
    if shape == "tribe":
        nxt = data.get("next_rest_url")
        return nxt if isinstance(nxt, str) and nxt.startswith("http") else None
    if shape == "cjbs":
        try:
            pages = int(data.get("pages") or 1)
        except (TypeError, ValueError):
            return None
        return _with_page(url, page + 1) if page < pages else None
    return None


def collect(ctx: SiteContext) -> None:
    url: str | None = ctx.source.url
    page = int(parse_qs(urlsplit(ctx.source.url).query).get("pagination", ["1"])[0] or 1)
    seen: set[str] = set()
    for _ in range(MAX_PAGES):
        if url is None:
            break
        result = ctx.get(url, accept="application/json")
        try:
            data = json.loads(result.content or b"null")
            shape, items = parse_payload(data, ctx.source.url)
        except ValueError as error:
            raise SourceError(f"{error}: {url}") from error
        ctx.read.shape = ctx.read.shape or shape
        fresh = [i for i in items if i.external_id not in seen]
        for item in fresh:
            seen.add(item.external_id)
            ctx.keep(item, result)
        if not fresh or _past_window(ctx, items):
            break
        url = _next_url(shape, data, url, page)
        page += 1


def _past_window(ctx: SiteContext, items: list[ParsedTalk]) -> bool:
    """Whether a page sorted by date already reaches past the window."""
    return bool(items) and all(london_day(i.starts_at) >= london_day(ctx.window.end) for i in items)
