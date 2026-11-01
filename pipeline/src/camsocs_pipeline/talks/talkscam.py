"""talks.cam.ac.uk's public API → `TalkRecord`s (docs/talks-redesign-spec.md
§2–§3, decision D7; stage `talks`).

**Parser only — this content never reaches a model**, nor an AI agent. Its
robots.txt disallows AI crawlers by name and asks everyone else for
``Crawl-delay: 10``. The source type ``talks_cam`` is in
`claims.NO_LLM_SOURCE_TYPES`, and the host is in `extract.llm.NO_LLM_HOSTS`.
Anything printed about a read is a count, an id or a status code.

**The read.** ``GET /api/v1alpha1/talks/?start_time__gte=…&start_time__lt=…
&ordering=start_time`` answers ``{count, next, previous, results}``. The window
(London midnight a day ago → 70 days ahead, `talks_window`) is asked for in
`CHUNK_DAYS` slices, so no one query needs more than `MAX_PAGES` pages
whatever the API's page size, and the whole read takes at most
`MAX_TOTAL_PAGES` pages (a failed slice's count too) and `READ_BUDGET` of wall
time. Each slice follows ``next`` (talks.cam only, at most
`MAX_PAGES` pages, never a page twice) and must return exactly ``count``
talks; a slice that does not is a failure, never "fewer talks". The fetches go
through the polite client with the general purpose: robots.txt holds for our
User-Agent, and requests are at least `CRAWL_DELAY` seconds apart. The read
is **complete** only when every slice was; only then may the sweep mark this
source's unlisted talks missing.

**A talk.** Plain text throughout (HTML stripped). Its page is
``/talk/index/<id>``; ``sourceUrl`` is the API page it was read from. Speakers,
cancellation, online and kind are rules (`talks.text`). Ex-directory talks are
left out. The department comes from the series (`talks.mapping`).
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

from camsocs_pipeline.events.common import (
    EventWindow,
    default_window,
    describe_failure,
    fetched_at,
)
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.talks.mapping import DepartmentMapper
from camsocs_pipeline.talks.model import TalkRecord
from camsocs_pipeline.talks.text import (
    guess_kind,
    is_cancelled,
    is_online,
    one_line,
    parse_speakers,
    plain_text,
)

logger = logging.getLogger(__name__)

HOST = "talks.cam.ac.uk"
BASE = f"https://{HOST}"
API_PATH = "/api/v1alpha1/talks/"
API = BASE + API_PATH
TALK_PAGE = BASE + "/talk/index/{id}"

SOURCE_TYPE = "talks_cam"
#: The sweep scope of every talks.cam record.
SOURCE = "talks_cam"

#: robots.txt asks every crawler for this many seconds between requests.
CRAWL_DELAY = 10.0
#: Pages one query may take; more means the date filter was ignored.
MAX_PAGES = 40
#: Pages one whole read may take (at `CRAWL_DELAY`, 20 minutes): bounds the
#: stage's run time inside the daily group whatever the page size. Pages a
#: failed slice fetched count too.
MAX_TOTAL_PAGES = 120
#: Wall time one whole read may take: a slice not started by then is a failed
#: slice. Bounds the run time when requests time out and are retried (the
#: page budget alone does not: one unreachable page can take minutes).
READ_BUDGET = timedelta(minutes=30)
#: The window is asked for in slices this long (a busy week is ~200 talks).
CHUNK_DAYS = 7

LOOKBACK_DAYS = 1
HORIZON_DAYS = 70


class TalksCamError(RuntimeError):
    """A query could not be read completely. Never treated as "no talks"."""

    #: Pages requested before the failure (they count against the budget).
    pages: int = 0


def talks_window(now: datetime | None = None) -> EventWindow:
    """London midnight yesterday → London midnight 70 days ahead."""
    return default_window(now, lookback_days=LOOKBACK_DAYS, horizon_days=HORIZON_DAYS)


def iso_z(moment: datetime) -> str:
    """An aware instant as the API's UTC form, ``2026-10-31T00:00:00Z``."""
    if moment.tzinfo is None:
        raise ValueError("window bounds must be timezone-aware")
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def query_url(start: datetime, end: datetime) -> str:
    query = urlencode(
        {"start_time__gte": iso_z(start), "start_time__lt": iso_z(end), "ordering": "start_time"}
    )
    return f"{API}?{query}"


def slices(window: EventWindow, days: int = CHUNK_DAYS) -> list[tuple[datetime, datetime]]:
    """``[start, end)`` slices covering the window exactly, `days` long (the
    last one shorter). Steps are London calendar days, so a slice boundary is a
    London midnight across a clock change too."""
    if days < 1:
        raise ValueError("slices must be at least one day")
    out: list[tuple[datetime, datetime]] = []
    cursor = window.start
    while cursor < window.end:
        local = cursor.astimezone(window.start.tzinfo)
        following = (local.replace(tzinfo=None) + timedelta(days=days)).replace(
            tzinfo=window.start.tzinfo
        )
        end = min(following, window.end)
        out.append((cursor, end))
        cursor = end
    return out


def next_page(value: object, current: str) -> str | None:
    """The ``next`` link, checked: talks.cam's own API only (an ``http`` link
    is read over https). Raises `TalksCamError` for anything else."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise TalksCamError("next is not a URL")
    parts = urlsplit(urljoin(current, value))
    if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() != HOST:
        raise TalksCamError("next points off talks.cam")
    if parts.port not in (None, 80, 443) or not parts.path.startswith(API_PATH):
        raise TalksCamError("next leaves the talks API")
    return urlunsplit(("https", HOST, parts.path, parts.query, ""))


@dataclass
class Page:
    url: str
    retrieved_at: datetime
    results: list[dict]


def read_query(client: PoliteClient, url: str, *, max_pages: int = MAX_PAGES) -> list[Page]:
    """Every page of one query. Raises `TalksCamError` on a failed fetch, a
    malformed page, a page cap or a loop, and when the talks returned are not
    the ``count`` the first page announced."""
    pages: list[Page] = []
    try:
        return _read_query(client, url, max_pages=max_pages, pages=pages)
    except TalksCamError as error:
        # The pages read and (at most) the one that failed: budget, not a report.
        error.pages = len(pages) + 1
        raise


def _read_query(client: PoliteClient, url: str, *, max_pages: int, pages: list[Page]) -> list[Page]:
    seen: set[str] = set()
    count: int | None = None
    current: str | None = url
    while current is not None:
        if len(pages) >= max_pages:
            raise TalksCamError(f"more than {max_pages} pages for one query")
        if current in seen:
            raise TalksCamError("next repeats a page")
        seen.add(current)
        result = client.fetch(current, accept="application/json")
        if not result.ok or result.content is None:
            raise TalksCamError(describe_failure(result))
        try:
            payload = json.loads(result.content)
        except ValueError as error:
            raise TalksCamError(f"page {len(pages) + 1} is not JSON") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise TalksCamError(f"page {len(pages) + 1} has no results list")
        if count is None:
            announced = payload.get("count")
            if not isinstance(announced, int) or isinstance(announced, bool) or announced < 0:
                raise TalksCamError("the first page has no count")
            count = announced
        results = [item for item in payload["results"] if isinstance(item, dict)]
        if len(results) != len(payload["results"]):
            raise TalksCamError(f"page {len(pages) + 1} holds a result that is not an object")
        pages.append(Page(current, fetched_at(result), results))
        current = next_page(payload.get("next"), current)
    received = sum(len(page.results) for page in pages)
    if count != received:
        raise TalksCamError(f"count {count} but {received} talks returned")
    return pages


def _aware(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def _talk_id(raw: dict) -> int | None:
    value = raw.get("id")
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _named(value: object) -> tuple[object, str | None]:
    """``(id, name)`` of a series or venue object (or ``(None, None)``)."""
    if not isinstance(value, dict):
        return None, None
    name = value.get("name")
    return value.get("id"), one_line(name) if isinstance(name, str) else None


def _text(raw: dict, name: str) -> str | None:
    value = raw.get(name)
    return value if isinstance(value, str) else None


def is_ex_directory(raw: dict) -> bool:
    return raw.get("exDirectory") is True


def parse_talk(
    raw: dict, *, source_url: str, retrieved_at: datetime, mapper: DepartmentMapper
) -> TalkRecord | None:
    """One API result → a `TalkRecord`, or None when it has no id, title or
    usable start. The caller leaves ex-directory talks out first."""
    talk_id = _talk_id(raw)
    title = one_line(_text(raw, "title"))
    starts_at = _aware(raw.get("startTime"))
    if talk_id is None or not title or starts_at is None:
        return None
    ends_at = _aware(raw.get("endTime"))
    if ends_at is not None and ends_at <= starts_at:
        ends_at = None
    series_id, series = _named(raw.get("series"))
    _venue_id, venue = _named(raw.get("venue"))
    abstract = plain_text(_text(raw, "abstract"))
    special = plain_text(_text(raw, "specialMessage"))
    return TalkRecord(
        source_type=SOURCE_TYPE,
        source=SOURCE,
        external_id=str(talk_id),
        url=TALK_PAGE.format(id=talk_id),
        source_url=source_url,
        title=title,
        starts_at=starts_at,
        ends_at=ends_at,
        retrieved_at=retrieved_at,
        speakers=parse_speakers(_text(raw, "nameOfSpeaker")),
        series=series,
        department_keys=mapper.departments_for(
            series_id=series_id, series_name=series, venue=venue
        ),
        venue=venue,
        online=is_online(venue=venue, special_message=special, title=title, abstract=abstract),
        kind=guess_kind(title, series),
        cancelled=is_cancelled(title, special),
        abstract=abstract,
        special_message=special,
        talks_cam_id=talk_id,
    )


@dataclass
class TalksCamRead:
    """What one read of the window found. Notes and errors hold counts, ids
    and statuses only — never a title, a name or an abstract."""

    records: list[TalkRecord] = field(default_factory=list)
    slices: int = 0
    slices_read: int = 0
    pages: int = 0
    #: Pages requested by slices that then failed (budget only).
    pages_failed: int = 0
    received: int = 0
    dropped: Counter[str] = field(default_factory=Counter)
    errors: list[str] = field(default_factory=list)
    #: The ``[start, end)`` slices not read (failed, or past a ``--limit``):
    #: their talks are missing from `records`.
    unread: list[tuple[datetime, datetime]] = field(default_factory=list)

    def covers(self, moment: datetime) -> bool:
        """Whether a talk starting at `moment` was in a slice that was read."""
        return not any(start <= moment < end for start, end in self.unread)

    @property
    def complete(self) -> bool:
        return self.slices > 0 and self.slices_read == self.slices and not self.errors

    @property
    def mapped(self) -> int:
        return sum(1 for record in self.records if record.department_keys)


def read_talks_cam(
    client: PoliteClient,
    window: EventWindow,
    mapper: DepartmentMapper,
    *,
    max_slices: int | None = None,
    days: int = CHUNK_DAYS,
    max_total_pages: int = MAX_TOTAL_PAGES,
    budget: timedelta = READ_BUDGET,
    clock: Callable[[], float] = time.monotonic,
) -> TalksCamRead:
    """Read the window slice by slice (module docstring). A failed slice is
    noted and its talks left out; the read is then incomplete. `max_slices`
    (a trial run's ``--limit``) reads only the first slices — never complete.
    `max_total_pages` and `budget` bound the whole read; a slice either would
    leave unread is a failed slice."""
    deadline = clock() + budget.total_seconds()
    read = TalksCamRead()
    planned = slices(window, days)
    read.slices = len(planned)
    if max_slices is not None:
        read.unread += planned[max_slices:]
        planned = planned[:max_slices]
        if len(planned) < read.slices:
            read.errors.append(f"limited to {len(planned)} of {read.slices} slices")
    seen: set[int] = set()
    for number, (start, end) in enumerate(planned, start=1):
        remaining = max_total_pages - read.pages - read.pages_failed
        try:
            if remaining < 1:
                raise TalksCamError(f"the {max_total_pages}-page budget is spent")
            if clock() >= deadline:
                raise TalksCamError("the time budget is spent")
            pages = read_query(client, query_url(start, end), max_pages=min(MAX_PAGES, remaining))
        except TalksCamError as error:
            read.pages_failed += error.pages
            read.unread.append((start, end))
            read.errors.append(f"slice {number}/{read.slices}: {error}")
            logger.warning("talks.cam slice %d/%d not read: %s", number, read.slices, error)
            continue
        read.slices_read += 1
        read.pages += len(pages)
        for page in pages:
            for raw in page.results:
                read.received += 1
                if is_ex_directory(raw):
                    read.dropped["ex-directory"] += 1
                    continue
                record = parse_talk(
                    raw, source_url=page.url, retrieved_at=page.retrieved_at, mapper=mapper
                )
                if record is None:
                    read.dropped["unreadable"] += 1
                    continue
                if not start <= record.starts_at < end:
                    read.dropped["outside the window"] += 1
                    continue
                if record.talks_cam_id in seen:
                    read.dropped["repeated id"] += 1
                    continue
                seen.add(record.talks_cam_id)  # type: ignore[arg-type]
                read.records.append(record)
    return read


__all__ = [
    "API",
    "CHUNK_DAYS",
    "CRAWL_DELAY",
    "MAX_PAGES",
    "MAX_TOTAL_PAGES",
    "READ_BUDGET",
    "SOURCE",
    "SOURCE_TYPE",
    "TALK_PAGE",
    "Page",
    "TalksCamError",
    "TalksCamRead",
    "is_ex_directory",
    "iso_z",
    "next_page",
    "parse_talk",
    "query_url",
    "read_query",
    "read_talks_cam",
    "slices",
    "talks_window",
]
