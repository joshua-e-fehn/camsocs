"""What every department-site parser shares: the read context, dates written
out in words, detail pages, talks.cam ids, and the one way a parsed item
becomes a `TalkRecord` (spec §3).

**Times.** A time a site gives without a zone (``2026-11-05T13:00:00`` in
JSON-LD, "5 November 2026 * 1:00pm" on a card) is Cambridge time,
Europe/London. An explicit offset or ``Z`` keeps its instant. A date with no
time is an all-day talk from 00:00 London to 00:00 the day after its last day.

**Dates in words** (`parse_when`): "5 November 2026 * 1:00pm to 2:00pm",
"Monday, 2 November, 2026 - 13:05 to 13:55", "Nov 3rd 2026 — 14:00 to 15:00",
"November 18, 2026 at 4:00 pm - 5:00 pm", "02/11/2026 13:00" (UK order),
"3 Nov 26 - 10:00" (a two-digit year) and ISO dates. A date without a year
("12 November") is read only when the caller gives the day the page was
read, and lands within ten months after it (or two months before: a listing
still showing last week's talk).

**Detail pages.** A parser that follows links from a listing fetches at most
`DETAIL_CAP` of them per source per run, on the listing's own host only,
through the polite client (robots.txt holds; a disallowed page is skipped).
A detail page read within `DETAIL_FRESH` (just under three days) is reused
from the cache and does not count against the cap, so a verify run followed
by a sweep does not read every page twice, and each daily run spends the cap
on pages the last two runs did not read. Past the cap, a cached copy younger
than `DETAIL_STALE` is used. So a feed of up to three caps is covered over
successive runs; a detail page's own change (an abstract, an exact time)
shows within three days, while the listing itself is read every run.

**talks.cam ids.** A department page that links a talk on talks.cam
(``talks.cam.ac.uk/talk/index/<id>``) gives that id to `TalkRecord.talks_cam_id`
for the cross-source dedupe; so does a mirror's own URL (the UIS ucam_talks
module's ``/talk/<id>``, Computer Science's ``/seminars/list/<id>``,
`mirrored_talks_cam_id`). Only the link is read; talks.cam itself is never
fetched here.

**Errors.** A listing or feed that cannot be read raises `SourceError`: the
source was not read completely, so the caller must not sweep it. A detail page
that cannot be read only loses that talk's extra fields (`SourceRead.notes`).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from html import unescape
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

from camsocs_pipeline.events.common import LONDON, EventWindow, clean_text, london_midnight
from camsocs_pipeline.events.talks_cam import parse_speakers
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.talks.model import Speaker, TalkRecord
from camsocs_pipeline.talks.registry import Department, DepartmentSource
from camsocs_pipeline.talks.sites.filters import (
    is_cancelled,
    is_elsewhere,
    is_online,
    is_talk,
    talk_kind,
)

#: Detail pages read per source per run, at most.
DETAIL_CAP = 40
#: A detail page read this recently is taken from the cache. Longer than two
#: daily runs, so a run spends the cap on pages the last two did not read:
#: a feed of up to three caps is covered every three days.
DETAIL_FRESH = timedelta(hours=70)
#: Past the cap, a cached copy younger than this is still used.
DETAIL_STALE = timedelta(days=7)
#: Listing pages followed through ``rel="next"`` / ``?page=N``, at most.
MAX_PAGES = 8

_TALKS_CAM_LINK = re.compile(r"talks\.cam\.ac\.uk/talk/index/(\d+)")
#: The UIS ucam_talks module's pages, ``/talk/<talks.cam talk id>``.
UCAM_TALK_PATH = re.compile(r"^/(?:research/)?talk/(\d+)/?$")
#: Computer Science's seminar list mirrors talks.cam: ``/seminars/list/<talk id>``.
_CST_MIRROR = re.compile(r"^/seminars/list/(\d+)/?$")


class SourceError(RuntimeError):
    """The source's listing or feed could not be read (not swept)."""


class Window(Protocol):
    start: datetime
    end: datetime


class Client(Protocol):
    def fetch(self, url: str, **kwargs: Any) -> FetchResult: ...


# --- the read --------------------------------------------------------------------------


@dataclass
class SourceRead:
    """What one source gave this run (the verify report reads it too)."""

    records: list[TalkRecord] = field(default_factory=list)
    pages: int = 0
    details: int = 0
    #: Items left out: not a talk, outside the window, no date.
    dropped: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    #: The listing shape a parser recognised (`drupal_uis`: tailwind,
    #: ucam_talks, views; `json_api`: tribe, cjbs, dated_array), if any.
    shape: str | None = None
    #: The listing says it has nothing ("No events found", "0 results").
    says_empty: bool = False

    def drop(self, reason: str) -> None:
        self.dropped[reason] = self.dropped.get(reason, 0) + 1


@dataclass
class SiteContext:
    """One source of one department, read once."""

    dept: Department
    source: DepartmentSource
    index: int
    client: Client
    window: EventWindow
    source_type: str
    read: SourceRead = field(default_factory=SourceRead)
    _details_left: int = DETAIL_CAP
    #: The listing's hosts: the source URL's, and any its pages redirected to
    #: (``zoo.cam.ac.uk`` → ``www.zoo.cam.ac.uk``); detail pages stay on them.
    _hosts: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self._hosts.add(urlsplit(self.source.url).netloc.lower())

    @property
    def scope(self) -> str:
        """The sweep scope (spec §3 ``source``)."""
        return f"{self.dept.key}#{self.index}"

    @property
    def require_keyword(self) -> bool:
        return requires_talk_keyword(self.dept)

    def get(self, url: str, *, accept: str | None = None) -> FetchResult:
        """The listing or feed itself: a failure raises `SourceError`."""
        kwargs: dict[str, Any] = {"accept": accept} if accept else {}
        result = self.client.fetch(url, **kwargs)
        if not result.ok:
            detail = f" ({result.detail})" if result.detail else ""
            status = f" {result.status}" if result.status else ""
            raise SourceError(f"{result.outcome}{status}{detail}: {url}")
        self.read.pages += 1
        if result.final_url:
            self._hosts.add(urlsplit(result.final_url).netloc.lower())
        return result

    def detail(self, url: str) -> FetchResult | None:
        """A detail page on the listing's host; None when it is not read
        (another host, robots, a failed fetch, the cap reached with no recent
        copy in the cache; module docstring)."""
        if urlsplit(url).netloc.lower() not in self._hosts:
            return None
        if self._details_left <= 0:
            result = _recent_copy(self.client, url)
            if result is None:
                self.read.drop("detail cap reached")
                return None
        else:
            result = self.client.fetch(url, fresh_for=DETAIL_FRESH)
            if not result.from_cache:
                self._details_left -= 1
        if not result.ok:
            self.read.notes.append(f"detail {result.outcome} {result.status or ''}: {url}".strip())
            return None
        self.read.details += 1
        return result

    def looks_like_a_talk(self, item: ParsedTalk) -> bool:
        """The talk filter on what a listing shows (title, labels, series),
        before any detail page is read for the item."""
        labels = [*item.categories, *([item.series] if item.series else [])]
        return is_talk(item.title, labels, require_keyword=self.require_keyword)

    def keep(self, item: ParsedTalk, result: FetchResult) -> TalkRecord | None:
        """`item` as a record, or None (and a drop reason) when it is not an
        upcoming talk in the window."""
        if not item.title.strip():
            self.read.drop("no title")
            return None
        if not self.window.overlaps(item.starts_at, item.ends_at):
            self.read.drop("outside the window")
            return None
        if not self.looks_like_a_talk(item):
            self.read.drop("not a talk")
            return None
        if is_elsewhere(item.venue):
            self.read.drop("not in Cambridge")
            return None
        record = item.record(self, retrieved_at(result))
        self.read.records.append(record)
        return record


# --- one parsed item -------------------------------------------------------------------


@dataclass
class ParsedTalk:
    """One item as a parser read it, before the talk filter."""

    external_id: str
    url: str
    source_url: str
    title: str
    starts_at: datetime
    ends_at: datetime | None = None
    all_day: bool = False
    speakers: list[dict[str, str]] = field(default_factory=list)
    series: str | None = None
    venue: str | None = None
    abstract: str | None = None
    categories: list[str] = field(default_factory=list)
    online: bool | None = None
    cancelled: bool | None = None
    talks_cam_id: int | None = None

    def record(self, ctx: SiteContext, retrieved: datetime) -> TalkRecord:
        title = single_line(self.title) or "Untitled talk"
        series = single_line(self.series) or series_of(title)
        venue = single_line(self.venue)
        cancelled = (
            self.cancelled if self.cancelled is not None else is_cancelled(title, self.abstract)
        )
        online = self.online if self.online is not None else is_online(venue)
        return TalkRecord(
            source_type=ctx.source_type,
            source=ctx.scope,
            external_id=self.external_id,
            url=self.url,
            source_url=self.source_url,
            title=title,
            starts_at=self.starts_at,
            ends_at=self.ends_at if self.ends_at and self.ends_at > self.starts_at else None,
            all_day=self.all_day,
            retrieved_at=retrieved,
            speakers=[Speaker(s["name"], s.get("affiliation")) for s in self.speakers],
            series=series,
            department_keys=[ctx.dept.key],
            venue=venue,
            online=online,
            kind=talk_kind(title, self.categories),
            cancelled=cancelled,
            abstract=clean_text(self.abstract),
            talks_cam_id=self.talks_cam_id,
        )


# --- department rules ------------------------------------------------------------------

#: Departments whose listings are mostly not talks (museums, gardens,
#: galleries, colleges, the library, festivals, careers): an item is kept only
#: when its title names a talk (`filters.TALK_WORDS`).
_MIXED_LISTING = re.compile(
    r"\b(museum|garden|gallery|kettle'?s yard|college|hall|library|festival|alumni|careers|"
    r"enterprise|union|trust|church|postdoc)\b",
    re.IGNORECASE,
)


#: ...unless the unit is itself a talks programme ("Intellectual Forum, Jesus College").
_TALKS_PROGRAMME = re.compile(r"\b(?:forum|lecture series|lectures)\b", re.IGNORECASE)


def requires_talk_keyword(dept: Department) -> bool:
    return (
        dept.school == "other"
        and bool(_MIXED_LISTING.search(dept.name))
        and not _TALKS_PROGRAMME.search(dept.name)
    )


# --- small helpers ---------------------------------------------------------------------

_SAYS_EMPTY = re.compile(
    r"\bno (?:upcoming |current |future )?events?"
    r"(?: (?:were )?found| scheduled| to (?:show|display))?\b"
    r"|\b0 results\b|\bthere are (?:currently )?no (?:upcoming |current |future )?events\b"
    r"|\bnothing (?:is )?scheduled\b",
    re.IGNORECASE,
)


def says_empty(html: str) -> bool:
    """Whether a listing page says it lists nothing (verify reads it)."""
    return bool(_SAYS_EMPTY.search(clean_text(html) or ""))


def _recent_copy(client: Client, url: str) -> FetchResult | None:
    """The cached copy of `url` if it is younger than `DETAIL_STALE`."""
    cached = getattr(client, "cached", None)
    result = cached(url) if callable(cached) else None
    if result is None or not result.ok:
        return None
    age = datetime.now(UTC) - retrieved_at(result)
    return result if age < DETAIL_STALE else None


def retrieved_at(result: FetchResult) -> datetime:
    moment = datetime.fromisoformat(result.fetched_at)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def single_line(text: str | None) -> str | None:
    value = clean_text(text)
    if value is None:
        return None
    return " ".join(value.split()) or None


def canonical(url: str, base: str | None = None) -> str:
    """`url` made absolute, without its fragment (a stable external id)."""
    absolute = urljoin(base, url) if base else url
    parts = urlsplit(absolute)
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, parts.query, ""))


def talks_cam_id(*texts: str | None) -> int | None:
    """The first talks.cam talk id linked in `texts` (HTML or plain)."""
    for text in texts:
        match = _TALKS_CAM_LINK.search(text or "")
        if match:
            return int(match.group(1))
    return None


def mirrored_talks_cam_id(url: str) -> int | None:
    """The talks.cam talk id a mirror page's own URL carries (module docstring)."""
    parts = urlsplit(url)
    if parts.netloc.endswith(("cst.cam.ac.uk", "cl.cam.ac.uk")):
        match = _CST_MIRROR.match(parts.path)
        if match:
            return int(match.group(1))
    match = UCAM_TALK_PATH.match(parts.path)
    return int(match.group(1)) if match else None


_SERIES_PREFIX = re.compile(
    r"^(?P<series>[^:]{3,120}?\b(?:seminars?|series|lectures?|colloqui(?:um|a)|club|group|"
    r"lunch|forum|workshop|symposium|talks?|discussions?))\s*:\s+\S",
    re.IGNORECASE,
)


def series_of(title: str) -> str | None:
    """ "Zoology Department Seminar: The internet of animals" → the series."""
    match = _SERIES_PREFIX.match(title)
    return match["series"].strip() if match else None


def speakers_from(text: str | None) -> list[dict[str, str]]:
    """``Name (Affiliation); Name`` (the talks.cam convention) or
    ``Name - Affiliation`` / ``Name, Affiliation`` for one speaker."""
    value = single_line(text)
    if not value:
        return []
    if "(" in value or ";" in value:
        return parse_speakers(value)
    for separator in (" - ", " – ", " — ", ", "):
        if separator in value:
            name, _, affiliation = value.partition(separator)
            if 1 <= len(name.split()) <= 6:
                return [{"name": name.strip(), "affiliation": affiliation.strip()}]
    return parse_speakers(value) if len(value.split()) <= 8 else []


_SPEAKER_LINE = re.compile(r"(?im)^\s*speakers?\s*:\s*(?P<who>.{3,200}?)\s*$")


def speaker_line(text: str | None) -> list[dict[str, str]]:
    """A labelled ``Speaker: …`` line in a detail page's text."""
    match = _SPEAKER_LINE.search(clean_text(text) or "")
    return speakers_from(match["who"]) if match else []


# --- dates in words --------------------------------------------------------------------

_MONTH_NAMES = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
_MONTH = (
    r"(?P<mon>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
)
_ORD = r"(?:st|nd|rd|th)?"
_DATE_PATTERNS = (
    # 5 November 2026 · 2 November, 2026 · 5th of Nov 2026
    re.compile(rf"\b(?P<d>\d{{1,2}}){_ORD}\s+(?:of\s+)?{_MONTH},?\s*(?P<y>(?:19|20)\d\d)\b", re.I),
    # November 18, 2026 · Nov 3rd 2026
    re.compile(rf"\b{_MONTH}\s+(?P<d>\d{{1,2}}){_ORD},?\s+(?P<y>(?:19|20)\d\d)\b", re.I),
    # 02/11/2026 (UK order) · 2026-11-02
    re.compile(r"\b(?P<d>\d{1,2})/(?P<m>\d{1,2})/(?P<y>(?:19|20)\d\d)\b"),
    re.compile(r"\b(?P<y>(?:19|20)\d\d)-(?P<m>\d\d)-(?P<d>\d\d)\b"),
    # 3 Nov 26 (Land Economy): a two-digit year, never a time ("2 Nov 10:00")
    re.compile(rf"\b(?P<d>\d{{1,2}}){_ORD}\s+{_MONTH}\s+(?P<yy>\d\d)\b(?![:.]\d)", re.I),
)
_YEARLESS = (
    re.compile(rf"\b(?P<d>\d{{1,2}}){_ORD}\s+(?:of\s+)?{_MONTH}\b", re.I),
    re.compile(rf"\b{_MONTH}\s+(?P<d>\d{{1,2}}){_ORD}\b", re.I),
)
#: A clock time, never inside a number or a decimal ("2026", "3.125"); a
#: letter may touch it ("Event Time2:00pm": labels run into values). `s` is
#: the separator, ":" or ".".
_CLOCK = (
    r"(?<![\d.:])(?P<h{n}>\d{{1,2}})(?!\d)(?:(?P<s{n}>[:.])(?P<m{n}>\d\d)(?!\d))?"
    r"\s*(?P<a{n}>[ap]\.?m\.?)?"
)
_TIME_RANGE = re.compile(
    _CLOCK.format(n=1) + r"\s*(?:-|–|—|to|until)\s*" + _CLOCK.format(n=2), re.IGNORECASE
)
_ONE_TIME = re.compile(_CLOCK.format(n=1), re.IGNORECASE)
_NOON = re.compile(r"\b12\s*noon\b|\bnoon\b|\bmidday\b", re.IGNORECASE)
#: A room's number, never a time: "Room 2.14", "Seminar Room 12.30", "LT1",
#: "Lecture Theatre 1", "MR2", "Room G.01", "Floor 3".
_ROOM_NUMBER = re.compile(
    # A word start, or a capital run into a label ("Event LocationRoom 2.14").
    r"(?:\b|(?<=[a-z])(?=(?-i:[A-Z])))(?:room|rm|theatre|theater|lt|lr|mr|floor|level)\.?\s*(?:[a-z]\.?)?\d+(?:[.:]\d+)*[a-z]?\b",
    re.IGNORECASE,
)


def _month(name: str | None, number: str | None) -> int | None:
    if number:
        value = int(number)
        return value if 1 <= value <= 12 else None
    lowered = (name or "").lower().rstrip(".")
    for i, full in enumerate(_MONTH_NAMES, start=1):
        if full.startswith(lowered[:3]):
            return i
    return None


def _dates(text: str, today: date | None) -> tuple[list[date], str]:
    """The dates in `text` (in order) and the text with them blanked out."""
    spans: list[tuple[int, int, date]] = []
    for pattern in _DATE_PATTERNS:
        for match in pattern.finditer(text):
            if any(s <= match.start() < e for s, e, _ in spans):
                continue
            month = _month(match.groupdict().get("mon"), match.groupdict().get("m"))
            groups = match.groupdict()
            year = int(groups["y"]) if groups.get("y") else 2000 + int(groups.get("yy") or 0)
            try:
                found = date(year, month or 0, int(match["d"]))
            except (TypeError, ValueError):
                continue
            spans.append((match.start(), match.end(), found))
    if not spans and today is not None:
        for pattern in _YEARLESS:
            for match in pattern.finditer(text):
                if any(s <= match.start() < e for s, e, _ in spans):
                    continue
                month = _month(match["mon"], None)
                found_day = _nearest_year(int(match["d"]), month, today)
                if found_day is not None:
                    spans.append((match.start(), match.end(), found_day))
    spans.sort()
    blanked = text
    for start, end, _ in spans:
        blanked = blanked[:start] + " " * (end - start) + blanked[end:]
    return [d for _, _, d in spans], blanked


def _nearest_year(day: int, month: int | None, today: date) -> date | None:
    if month is None:
        return None
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if today - timedelta(days=62) <= candidate <= today + timedelta(days=305):
            return candidate
    return None


#: An hour written without am/pm or a leading zero below this is in the
#: afternoon: no talk starts at 1.30 in the night ("1.30", "2:15 - 3:00").
_AFTERNOON_BELOW = 7


def _clock(hour: str, minute: str | None, marker: str | None) -> time | None:
    h, m = int(hour), int(minute or 0)
    meridiem = (marker or "").lower().replace(".", "")
    if meridiem == "pm" and h < 12:
        h += 12
    elif meridiem == "am" and h == 12:
        h = 0
    elif not meridiem and minute and len(hour) == 1 and 1 <= h < _AFTERNOON_BELOW:
        h += 12
    return time(h, m) if 0 <= h < 24 and 0 <= m < 60 else None


def _times(text: str) -> list[time]:
    """Clock times: "1:00pm to 2:00pm", "13:05 to 13:55", "4.15pm", "6 - 8pm"
    (a start without am/pm shares the end's unless that puts it after the
    end), "12 noon". A lone time needs minutes or am/pm; one with am/pm or a
    colon wins over a bare "h.mm", which must also be on a five-minute mark
    ("Python 3.12" is no time). Room numbers ("Room 2.14", "LT1") are never
    times (`_ROOM_NUMBER`)."""
    text = _ROOM_NUMBER.sub(lambda m: " " * len(m.group(0)), text)
    span = _TIME_RANGE.search(text)
    if span and (span["m1"] or span["a1"] or span["m2"] or span["a2"]):
        end = _clock(span["h2"], span["m2"], span["a2"])
        start = _clock(span["h1"], span["m1"], span["a1"] or span["a2"])
        if not span["a1"] and span["a2"] and start and end and start >= end:
            other = "am" if span["a2"].lower().startswith("p") else "pm"
            flipped = _clock(span["h1"], span["m1"], other)
            if flipped and flipped < end:
                start = flipped
        if not span["a2"] and start and end and end <= start and end.hour < 12:
            later = end.replace(hour=end.hour + 12)
            end = later if later > start else end  # "6.30 - 8.00": 18:30 to 20:00
        return [t for t in (start, end) if t is not None]
    marked = [m for m in _ONE_TIME.finditer(text) if m["a1"] or m["s1"] == ":"]
    bare = [
        m
        for m in _ONE_TIME.finditer(text)
        if m["s1"] == "." and not m["a1"] and int(m["m1"]) % 5 == 0
    ]
    for match in [*marked, *bare]:
        single = _clock(match["h1"], match["m1"], match["a1"])
        if single is not None:
            return [single]
    if _NOON.search(text):
        return [time(12, 0)]
    return []


def parse_when(
    text: str | None, *, today: date | None = None
) -> tuple[datetime, datetime | None, bool] | None:
    """``(start, end, all_day)`` from a date line written out (module docstring)."""
    if not text:
        return None
    flat = " ".join(unescape(text).split())
    dates, rest = _dates(flat, today)
    if not dates:
        return None
    first, last = dates[0], dates[-1] if dates[-1] >= dates[0] else dates[0]
    times = _times(rest)
    if not times:
        return london_midnight(first), london_midnight(last + timedelta(days=1)), True
    start = datetime.combine(first, times[0], tzinfo=LONDON)
    end = None
    if len(times) > 1:
        end = datetime.combine(last, times[1], tzinfo=LONDON)
        if end <= start and last == first:
            end = None
    return start, end, False


def parse_iso(value: Any) -> tuple[datetime, bool] | None:
    """``(aware moment, date_only)`` from an ISO 8601 date or date-time; a
    naive time is London time."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if len(text) == 10:
            return london_midnight(date.fromisoformat(text)), True
        moment = datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T", 1))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=LONDON)
    return moment, False


def london_day(moment: datetime) -> date:
    return moment.astimezone(LONDON).date()


def first(values: Iterable[str | None]) -> str | None:
    return next((v for v in values if v and v.strip()), None)


def unique(items: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(items))
