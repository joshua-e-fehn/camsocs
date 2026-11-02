"""University events programme → public events (source-research §10; stage
`uni_events`).

**Permission** (decision D3a, PLAN.md, 2026-11-02). The University's events
service lives on ``webservices.admin.cam.ac.uk``, whose robots.txt is
``User-agent: *`` / ``Disallow: /``. University Information Services (which
runs the host) and the Office of External Affairs and Communications (which
runs the programme) gave us permission to read its events API and event
images, and to let the model read their text (D1 redaction, D6 noise). The
permission is recorded in `sources.policy.RECORDED_PERMISSIONS`, keyed by
path: the polite client reads ``/events/api/`` and ``/events/uploadedImages/``
despite the disallow and records ``robots_override:permission``; every other
path on the host keeps its robots.txt. Each staged reading's ``accessNote``
also says ``ai_optout_override:permission``, since its text reaches the model
only thanks to that permission.

**Which programmes.** Every run reads the programme list (``programmes.json``,
`read_programmes`) and keeps the published ones we list (`select_programmes`):
What's On (`WHATS_ON`, always while it is published) and the yearly Cambridge
Festival and Open Cambridge programmes, found by their title ("Cambridge
Festival 2027") in a year the harvest window touches — never by a hard-coded
id, and never another programme (Schools Days). Only a programme's id and
title are read: the list also names staff contacts (``primaryContact``,
``accountEnquiriesEmail``), which are never kept — the list is fetched with
``store=False``, so not even the raw cache holds it.

**Occurrences and details.** For each programme, the JSON calendar
(``calendar/events.json``, `read_calendar`) gives every occurrence already
expanded by the server — dates, times, venue and room, cost, cancellation,
image — so no recurrence rule is expanded here. The server's default window
(today to three months ahead) covers the harvest window's future; an
occurrence of the past week is simply not re-sighted, which withdraws
nothing (the sweep only withdraws events still to come), and the URL stays
the same from day to day, so the listing's sweep group does too. When the
calendar has an occurrence in the window, the programme's iCalendar export
(``calendar/events.ics``, `read_details`) adds what the JSON lacks: the
categories (section, audience and access tags) and the full description,
joined on the event's uuid (the part of a ``UID`` before its first ``:``).
When the export fails or cannot be read, the programme is skipped for the
run, with a note: read without it, its events would change their type,
description and folding and back the next day. Skipped events are simply
not re-sighted, which withdraws nothing (the sweep only withdraws events of
a listing whose newest sighting moves on). A run makes one request for the
programme list and at most two per programme (a programme with nothing in
the window costs one), a second apart at least
(the polite client's pacing, with the honest User-Agent), plus one per image
not already cached (`media.IMAGE_CACHE_TTL`).

**Organisers** (decision 2026-11-02: every public University event is
listed). An event whose title — or its iCalendar ``ORGANIZER`` name, where a
festival programme gives one — names exactly one known student group
(`match_society`: the full name or a multi-word alias of at least
`MIN_NAME_LENGTH` characters, whole words, of a `STUDENT_GROUP_TYPES`
organisation in staging) is that society's, ``secondary`` evidence. Every
other event has no organiser at all (``organisers=[]``) and ``primary``
evidence: the University lists its own event, and the site shows it as the
University's. No department, museum or college organisation is created.

**What is read.**

- ``eventType`` from the categories, as found (`CATEGORY_TYPES`: Exhibitions,
  Talks, Courses/Workshops, Music / Theatre / Film, Tour); otherwise from the
  title's words, inferred.
- An entry that is only "Available on Demand" (not "In person", no venue) is
  a recording, not a dated event: left out.
- ``price`` from the cost text (`price_from`): free when it says so and names
  no amount; the pound amounts it names as ``minPence`` / ``maxPence``.
- ``cancelled`` from the occurrence's own flag; a vague timing (``TIMES_VAGUE``)
  is posted ``status: tbc`` with inferred times.
- ``image``: the event image in its 400-pixel ``_very_large`` size (the API's
  documented sizes; the calendar names only the 50-pixel ``_tiny`` one),
  probed and later copied like every source's (`media`).
- ``sourceUrl``: the University's own page for the event.

**Long runs are folded** (`fold_runs`). An exhibition open every day would
be 90 daily events. A series is one all-day event (external id
``<uuid>/run``) when the feed puts it under Exhibitions, or it has at least
`FOLD_MIN_OCCURRENCES` occurrences in the window at a median gap of
`FOLD_MAX_MEDIAN_GAP` days or less, or the stage folded it on one of its
last `FOLD_MEMORY_FILES` runs (`folded_before`). That last rule makes a
fold stick: the calendar starts today, so a series' count in the window
shrinks as it goes on, and a run posted earlier is never withdrawn once it
has started (the sweep only withdraws events still to come), so unfolding
would show the run and its single occurrences side by side. A weekly class
stays one event per occurrence (``<uuid>/<start, UTC>``).

A run starts on the series' first day (``earliestStartDate``) when that is
less than `RUN_REACH` back (strictly inside the impossible-date check's
year, `checks.MAX_DAYS_BEHIND`). An older one starts, inferred, on the first
of the month 11 months back (`stable_start`), so a permanent exhibition's
start moves once a month, not every day. Without a usable first day, the
first occurrence listed, inferred. It ends with its last day
(``latestStartDate``) when that is within `RUN_REACH` and not before the
last occurrence listed. Otherwise, inferred: a series that runs on past the
calendar's horizon (no last day, or one beyond the reach, and its last
listed occurrence within `HORIZON_SLACK` of the programme's last listed day)
ends with the month of that occurrence (`stable_end`), so it too moves once
a month; any other ends with its last listed occurrence.
"""

from __future__ import annotations

import json
import re
import statistics
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from itertools import pairwise
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    clean_text,
    default_window,
    describe_failure,
    infer_event_type,
    london_midnight,
    london_today,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.events.ics import IcsError, list_vevents
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import EventObservation, IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.policy import PERMISSION_AI_NOTE, PERMISSION_ROBOTS_NOTE
from camsocs_pipeline.sources.websites.site import with_note
from camsocs_pipeline.staging.store import events_directory

HOST = "https://webservices.admin.cam.ac.uk"
API = f"{HOST}/events/api"
PROGRAMMES_URL = f"{API}/programmes.json"
#: The calendars' page size: far above any programme's occurrences (What's On
#: listed 916 for three months on 2026-11-02); a cut calendar is noted.
RESULT_SET_SIZE = 20_000
WHATS_ON = "11"
#: The yearly programmes listed beside What's On, by title.
SEASONAL_TITLE = re.compile(r"^(?:Cambridge Festival|Open Cambridge) (?P<year>\d{4})$")

SOURCE_TYPE = "uni_events_api"
EVENT_SOURCE = "uni_events_api"
#: The University lists its own event; a society's event is second-hand.
EVIDENCE = "primary"
SOCIETY_EVIDENCE = "secondary"
COVERS = frozenset({"description", "endsAt", "venueText", "price"})

MIN_NAME_LENGTH = 10
STUDENT_GROUP_TYPES = frozenset(
    {
        "society",
        "sports_club",
        "college_club",
        "jcr",
        "mcr",
        "college_boat_club",
        "theatre_company",
        "media",
    }
)

#: Section categories → event type, first match wins (`event_type_of`).
CATEGORY_TYPES: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"exhibitions", "exhibition"}), "exhibition"),
    (frozenset({"talks", "talk", "lectures", "lecture"}), "talk"),
    (frozenset({"courses/workshops", "workshops", "workshop", "courses"}), "workshop"),
    (frozenset({"music", "theatre", "film", "films", "performance"}), "performance"),
    (frozenset({"tour", "tours"}), "trip"),
)
ON_DEMAND = "available on demand"
IN_PERSON = "in person"

FOLD_MIN_OCCURRENCES = 5
FOLD_MAX_MEDIAN_GAP = 2
#: The stage's own last staging files whose folded runs stay folded.
FOLD_MEMORY_FILES = 7
#: How far back a run's first day, or ahead its last, is believed: strictly
#: less than `checks.MAX_DAYS_BEHIND`, so a run is never dropped at the edge.
RUN_REACH = timedelta(days=365)
#: A series whose last listed occurrence is this close to the programme's last
#: listed day runs on past the calendar's horizon.
HORIZON_SLACK = timedelta(days=14)

_TINY_IMAGE = re.compile(r"_tiny(\.(?:jpe?g|png|gif))$", re.IGNORECASE)
_POUNDS = re.compile(r"£\s*(\d{1,4}(?:,\d{3})*(?:\.\d{1,2})?)")
_FREE = re.compile(r"\bfree\b", re.IGNORECASE)


# --- programmes ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Programme:
    """A programme's id and title: the only parts of the list that are read."""

    id: str
    title: str
    published: bool


def _results(data: bytes) -> tuple[list[dict[str, Any]], int | None, int | None]:
    payload = json.loads(data)
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, dict):
        raise ValueError("no results object")
    items = results.get("list") or []
    if isinstance(items, dict):  # a list of one is sent as the item itself
        items = [items]
    total = results.get("totalResults")
    returned = results.get("returnedResults")
    return (
        [item for item in items if isinstance(item, dict)],
        total if isinstance(total, int) else None,
        returned if isinstance(returned, int) else None,
    )


def read_programmes(data: bytes) -> list[Programme]:
    """Every programme's id, title and publication state (module docstring:
    nothing else, so no staff contact is ever held)."""
    items, _total, _returned = _results(data)
    programmes: list[Programme] = []
    for item in items:
        ident, title = item.get("@id"), item.get("title")
        if ident is None or not isinstance(title, str):
            continue
        programmes.append(
            Programme(
                id=str(ident),
                title=" ".join(title.split()),
                published=item.get("@publicationState") == "PUBLISHED",
            )
        )
    return programmes


def select_programmes(programmes: Iterable[Programme], window: EventWindow) -> list[Programme]:
    """What's On and the seasonal programmes of the window's years, published
    only (module docstring), What's On first."""
    years = {window.start.astimezone(LONDON).year, window.end.astimezone(LONDON).year}
    chosen: list[Programme] = []
    for programme in programmes:
        if not programme.published:
            continue
        if programme.id == WHATS_ON:
            chosen.append(programme)
            continue
        found = SEASONAL_TITLE.match(programme.title)
        if found and int(found.group("year")) in years:
            chosen.append(programme)
    return sorted(chosen, key=lambda p: (p.id != WHATS_ON, int(p.id) if p.id.isdigit() else 0))


def calendar_url(programme: str, extension: str) -> str:
    """A programme's calendar in the server's default window (module docstring)."""
    path = f"{API}/programmes/{programme}/calendar/events.{extension}"
    return f"{path}?resultSetSize={RESULT_SET_SIZE}"


#: The What's On iCalendar feed (the public What's On page's subscribe link).
FEED_URL = calendar_url(WHATS_ON, "ics")


# --- the JSON calendar --------------------------------------------------------------------


@dataclass
class Occurrence:
    """One calendar entry: one occurrence of one event."""

    uuid: str
    title: str
    starts_at: datetime
    ends_at: datetime | None
    all_day: bool
    url: str | None = None
    vague: bool = False
    series_first: date | None = None
    series_last: date | None = None
    short_description: str | None = None
    cancelled: bool = False
    image_path: str | None = None
    venue: str | None = None
    room: str | None = None
    cost: str | None = None
    #: From the iCalendar export, where one names the organiser.
    organizer_name: str | None = None


def _day(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value.strip(), "%d/%m/%Y").date()
    except ValueError:
        return None


def _clock(value: object) -> time | None:
    if not isinstance(value, str) or not value.strip():
        return None
    for pattern in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(value.strip(), pattern).time()
        except ValueError:
            continue
    return None


def _text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return " ".join(value.split()) or None


def occurrence_of(item: dict[str, Any]) -> Occurrence | None:
    """One calendar entry, in London time; None without a uuid, title or date."""
    uuid = _text(item.get("eventUid"))
    title = _text(item.get("title"))
    first = _day(item.get("startDate"))
    if uuid is None or title is None or first is None:
        return None
    last = _day(item.get("endDate")) or first
    start_clock, end_clock = _clock(item.get("startTime")), _clock(item.get("endTime"))
    if start_clock is None:
        starts_at = london_midnight(first)
        ends_at: datetime | None = london_midnight(max(last, first) + timedelta(days=1))
        all_day = True
    else:
        starts_at = datetime.combine(first, start_clock, tzinfo=LONDON)
        ends_at = datetime.combine(last, end_clock, tzinfo=LONDON) if end_clock else None
        all_day = False
    url = _text(item.get("url"))
    return Occurrence(
        uuid=uuid,
        title=title,
        starts_at=starts_at,
        ends_at=ends_at,
        all_day=all_day,
        url=url if url and url.startswith(("http://", "https://")) else None,
        vague=str(item.get("vagueTiming") or "NOT_VAGUE") != "NOT_VAGUE",
        series_first=_day(item.get("earliestStartDate")),
        series_last=_day(item.get("latestStartDate")),
        short_description=clean_text(item.get("shortDescription")),
        cancelled=item.get("cancelled") is True,
        image_path=_text(item.get("imageUrl")),
        venue=_text(item.get("venue")),
        room=_text(item.get("roomDetails")),
        cost=_text(item.get("cost")),
    )


@dataclass
class Calendar:
    occurrences: list[Occurrence]
    #: The server held more entries than it sent.
    cut: bool = False


def read_calendar(data: bytes) -> Calendar:
    """Every readable entry of a programme's JSON calendar. Raises
    `ValueError` for anything that is not one."""
    items, total, returned = _results(data)
    occurrences = [found for item in items if (found := occurrence_of(item)) is not None]
    cut = total is not None and returned is not None and total > returned
    return Calendar(occurrences, cut)


# --- the iCalendar details ----------------------------------------------------------------


@dataclass
class Details:
    """What the iCalendar export adds to an event (module docstring)."""

    categories: list[str] = field(default_factory=list)
    description: str | None = None
    organizer_name: str | None = None


def uuid_of(uid: str) -> str:
    """The event's uuid in a feed ``UID`` (``<uuid>:<date>{<time>…}``)."""
    return uid.split(":", 1)[0].strip()


def read_details(data: bytes) -> dict[str, Details]:
    """Categories, the longest description and an organiser name per event
    uuid, over every ``VEVENT`` of the event (its siblings carry other time
    slots). Raises `IcsError` for unreadable input."""
    details: dict[str, Details] = {}
    for event in list_vevents(data):
        found = details.setdefault(uuid_of(event.uid), Details())
        for category in event.categories:
            if category not in found.categories:
                found.categories.append(category)
        if event.description and len(event.description) > len(found.description or ""):
            found.description = event.description
        found.organizer_name = found.organizer_name or event.organizer_name
    return details


# --- reading one event ----------------------------------------------------------------------


def event_type_of(categories: Sequence[str]) -> str | None:
    """The type the programme's section categories state, or None."""
    lowered = {category.strip().lower() for category in categories}
    for names, event_type in CATEGORY_TYPES:
        if lowered & names:
            return event_type
    return None


def on_demand_only(categories: Sequence[str], venue: str | None) -> bool:
    """A recording, not a dated event: "Available on Demand", not "In
    person", and no venue."""
    lowered = {category.strip().lower() for category in categories}
    return ON_DEMAND in lowered and IN_PERSON not in lowered and not venue


def price_from(cost: str | None) -> dict[str, object] | None:
    """The `price` claim of a programme's cost text (module docstring)."""
    if not cost or cost.strip().lower() in ("n/a", "na", "-", "tbc"):
        return None
    pence: list[int] = []
    for amount in _POUNDS.findall(cost):
        try:
            pence.append(round(float(amount.replace(",", "")) * 100))
        except ValueError:
            continue
    pence = [value for value in pence if 0 <= value <= 1_000_000]
    price: dict[str, object] = {
        "free": bool(_FREE.search(cost)) and not pence,
        "text": cost[:300],
    }
    if pence:
        price["minPence"] = min(pence)
        price["maxPence"] = max(pence)
    return price


def venue_text(occurrence: Occurrence) -> str | None:
    venue, room = occurrence.venue, occurrence.room
    if venue and room and room.lower() not in venue.lower():
        return f"{venue} ({room})"
    return venue or room


def image_url(path: str | None) -> str | None:
    """The 400-pixel copy of an event image the calendar names in its 50-pixel
    size; None for anything outside the host's image store."""
    if not path:
        return None
    url = urljoin(HOST + "/", path)
    parts = urlsplit(url)
    if parts.netloc != urlsplit(HOST).netloc or not parts.path.startswith(
        "/events/uploadedImages/"
    ):
        return None
    return _TINY_IMAGE.sub(r"_very_large\1", url)


class _Named(Protocol):
    @property
    def title(self) -> str: ...

    @property
    def organizer_name(self) -> str | None: ...


@dataclass(frozen=True)
class _Name:
    key: str
    pattern: re.Pattern[str]
    length: int


def society_names(index: OrgLookup) -> list[_Name]:
    names: list[_Name] = []
    for key, name in index.organisations().items():
        if index.org_type(key) not in STUDENT_GROUP_TYPES:
            continue
        cleaned = " ".join(name.split())
        if len(cleaned) < MIN_NAME_LENGTH or " " not in cleaned:
            continue
        names.append(
            _Name(key, re.compile(rf"(?<!\w){re.escape(cleaned)}(?!\w)", re.I), len(cleaned))
        )
    return names


def match_society(event: _Named, names: list[_Name]) -> str | None:
    """The one student group the event names (organiser first, then title)."""
    for text in (event.organizer_name, event.title):
        if not text:
            continue
        hits = {name.key: name.length for name in names if name.pattern.search(text)}
        if not hits:
            continue
        longest = max(hits.values())
        winners = [key for key, length in hits.items() if length == longest]
        return winners[0] if len(winners) == 1 else None
    return None


def _occurrence_id(occurrence: Occurrence) -> str:
    if occurrence.all_day:
        return f"{occurrence.uuid}/{occurrence.starts_at.astimezone(LONDON):%Y%m%d}"
    return f"{occurrence.uuid}/{occurrence.starts_at.astimezone(UTC):%Y%m%dT%H%M%SZ}"


def event_draft(
    occurrence: Occurrence,
    details: Details | None,
    *,
    org_key: str | None = None,
    org_name: str | None = None,
    image: str | None = None,
) -> EventDraft:
    """One occurrence as a draft (module docstring); organiser-less unless a
    society is named."""
    categories = details.categories if details else []
    stated = event_type_of(categories)
    inferred: set[str] = set()
    if stated is None:
        inferred.add("eventType")
    if occurrence.vague:
        inferred |= {"startsAt", "endsAt"}
    organisers = (
        [
            OrganiserObs(
                identity=IdentityHints(name=org_name or org_key, known_key=org_key),
                role="organiser",
            )
        ]
        if org_key
        else []
    )
    venue = venue_text(occurrence)
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=_occurrence_id(occurrence),
        title=occurrence.title,
        starts_at=occurrence.starts_at,
        ends_at=occurrence.ends_at,
        all_day=occurrence.all_day,
        description=(details.description if details else None) or occurrence.short_description,
        page_url=occurrence.url,
        venue=IdentityHints(name=venue) if venue else None,
        price=price_from(occurrence.cost),
        event_type=stated or infer_event_type(occurrence.title),
        image_url=image,
        cancelled=occurrence.cancelled,
        status="tbc" if occurrence.vague else "confirmed",
        organisers=organisers,
        inferred=inferred,
        covers=COVERS,
    )


def _median_gap(starts: Sequence[datetime]) -> float:
    days = sorted({start.astimezone(LONDON).date() for start in starts})
    if len(days) < 2:
        return float("inf")
    return statistics.median((b - a).days for a, b in pairwise(days))


def should_fold(
    occurrences: Sequence[Occurrence], categories: Sequence[str], *, folded: bool = False
) -> bool:
    """Whether a series is one long run (module docstring); `folded`: the
    stage folded it on a recent run (`folded_before`)."""
    if folded or event_type_of(categories) == "exhibition":
        return True
    return (
        len(occurrences) >= FOLD_MIN_OCCURRENCES
        and _median_gap([o.starts_at for o in occurrences]) <= FOLD_MAX_MEDIAN_GAP
    )


def stable_start(today: date) -> date:
    """The inferred first day of a series older than `RUN_REACH`: the first of
    the month 11 months back (module docstring)."""
    months = today.year * 12 + today.month - 1 - 11
    return date(months // 12, months % 12 + 1, 1)


def stable_end(day: date) -> date:
    """The inferred last day of a series that runs past the calendar's
    horizon: the last day of `day`'s month (module docstring)."""
    months = day.year * 12 + day.month  # the next month, 0-based
    return date(months // 12, months % 12 + 1, 1) - timedelta(days=1)


def fold_runs(
    occurrences: Sequence[Occurrence],
    every: Sequence[Occurrence],
    draft: EventDraft,
    *,
    now: datetime | None = None,
    horizon: date | None = None,
) -> EventDraft:
    """The one all-day draft of a run (module docstring). `occurrences`: the
    series' entries in the window; `every`: all the feed lists; `draft`: the
    first occurrence's draft, whose other fields the run keeps; `horizon`:
    the programme calendar's last listed day."""
    today = london_today(now)
    first_seen = min(o.starts_at.astimezone(LONDON).date() for o in every)
    last_seen = max(o.starts_at.astimezone(LONDON).date() for o in every)
    head = occurrences[0]
    inferred = set(draft.inferred) - {"startsAt", "endsAt"}
    first = head.series_first
    if first is None or first > first_seen:
        first = first_seen
        inferred.add("startsAt")
    elif first <= today - RUN_REACH:
        first = stable_start(today)
        inferred.add("startsAt")
    last = head.series_last
    if last is None or last < last_seen or last > today + RUN_REACH:
        runs_on = last is None or last > today + RUN_REACH
        near_horizon = horizon is not None and last_seen >= horizon - HORIZON_SLACK
        last = stable_end(last_seen) if runs_on and near_horizon else last_seen
        inferred.add("endsAt")
    draft.external_id = f"{head.uuid}/run"
    draft.starts_at = london_midnight(first)
    draft.ends_at = london_midnight(last + timedelta(days=1))
    draft.all_day = True
    draft.inferred = inferred
    draft.cancelled = all(o.cancelled for o in occurrences)
    return draft


# --- the stage ------------------------------------------------------------------------------


def _fetch_details(
    client: PoliteClient, programme: Programme, notes: list[str]
) -> dict[str, Details] | None:
    """The programme's iCalendar details, or None (with a note) when the
    export fails or cannot be read: the programme is then skipped this run
    (module docstring)."""
    result = client.fetch(calendar_url(programme.id, "ics"), accept="text/calendar,*/*;q=0.5")
    if not result.ok or result.content is None:
        notes.append(
            f"{programme.title}: skipped, iCalendar export not fetched — {describe_failure(result)}"
        )
        return None
    try:
        return read_details(result.content)
    except IcsError as error:
        notes.append(f"{programme.title}: skipped, unreadable iCalendar export ({error})")
        return None


def folded_before(ctx: StageContext) -> set[str]:
    """The uuids this stage staged as a folded run (``<uuid>/run``) on any of
    its last `FOLD_MEMORY_FILES` runs (module docstring)."""
    folder = ctx.staging.root / events_directory(SOURCE_TYPE)
    if not folder.is_dir():
        return set()
    recent = sorted(folder.glob("*.jsonl"))[-FOLD_MEMORY_FILES:]
    uuids: set[str] = set()
    for path in recent:
        for record in ctx.staging.read(path):
            if isinstance(record, EventObservation) and record.event_source == EVENT_SOURCE:
                uuid, _, tail = record.external_id.rpartition("/")
                if tail == "run" and uuid:
                    uuids.add(uuid)
    return uuids


def _image(client: PoliteClient, path: str | None, cache: dict[str, str | None]) -> str | None:
    url = image_url(path)
    if url is None:
        return None
    if url not in cache:
        cache[url] = url if probe_image(client, url) else None
    return cache[url]


def _with_permission(records: Sequence[EventObservation]) -> list[EventObservation]:
    """Each reading read only thanks to the recorded permission also says its
    text may reach the model for the same reason (module docstring)."""
    out: list[EventObservation] = []
    for record in records:
        fetch = record.fetch
        if fetch is not None and PERMISSION_ROBOTS_NOTE in (fetch.access_note or "").split("; "):
            record = record.model_copy(update={"fetch": with_note(fetch, PERMISSION_AI_NOTE)})
        out.append(record)
    return out


@dataclass
class _Folding:
    occurrences: int = 0
    runs: int = 0


def _programme_drafts(
    client: PoliteClient,
    programme: Programme,
    result: FetchResult,
    calendar: Calendar,
    window: EventWindow,
    names: list[_Name],
    index: OrgLookup,
    tally: Tally,
    folding: _Folding,
    images: dict[str, str | None],
    notes: list[str],
    now: datetime | None,
    folded: set[str],
) -> list[Sourced]:
    series: dict[str, list[Occurrence]] = {}
    for occurrence in calendar.occurrences:
        series.setdefault(occurrence.uuid, []).append(occurrence)
    current = {
        uuid: [o for o in found if window.overlaps(o.starts_at, o.ends_at)]
        for uuid, found in series.items()
    }
    current = {uuid: found for uuid, found in current.items() if found}
    if not current:
        return []
    details = _fetch_details(client, programme, notes)
    if details is None:
        return []
    horizon = max(o.starts_at.astimezone(LONDON).date() for o in calendar.occurrences)
    pending: list[Sourced] = []
    for uuid, found in current.items():
        found.sort(key=lambda o: o.starts_at)
        extra = details.get(uuid)
        categories = extra.categories if extra else []
        if on_demand_only(categories, found[0].venue):
            tally.drop("on demand, not a dated event", len(found))
            continue
        for occurrence in found:
            occurrence.organizer_name = extra.organizer_name if extra else None
        key = match_society(found[0], names)
        image = _image(client, found[0].image_path, images)
        org = {"org_key": key, "org_name": index.name_of(key) or key} if key else {}
        evidence = SOCIETY_EVIDENCE if key else EVIDENCE
        if should_fold(found, categories, folded=uuid in folded):
            draft = fold_runs(
                found,
                series[uuid],
                event_draft(found[0], extra, image=image, **org),
                now=now,
                horizon=horizon,
            )
            folding.occurrences += len(found)
            folding.runs += 1
            pending.append(Sourced(draft, result.url, result, evidence=evidence))
            continue
        for occurrence in found:
            draft = event_draft(occurrence, extra, image=image, **org)
            pending.append(Sourced(draft, result.url, result, evidence=evidence))
    return pending


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrgLookup.for_stage(ctx)
    names = society_names(index)
    tally = Tally()
    folding = _Folding()
    images: dict[str, str | None] = {}
    notes = ctx.report.notes
    folded = folded_before(ctx)
    pending: list[Sourced] = []
    with polite_client(ctx.settings) as client:
        listing = client.fetch(PROGRAMMES_URL, accept="application/json", store=False)
        if not listing.ok or listing.content is None:
            notes.append(f"not fetched — {describe_failure(listing)}")
            return
        try:
            programmes = select_programmes(read_programmes(listing.content), window)
        except ValueError as error:
            notes.append(f"unreadable programme list: {error}")
            return
        if not any(p.id == WHATS_ON for p in programmes):
            notes.append("What's On is not published: only seasonal programmes read")
        notes.append("programmes: " + (", ".join(p.title for p in programmes) or "none"))
        for programme in programmes:
            result = client.fetch(calendar_url(programme.id, "json"), accept="application/json")
            if not result.ok or result.content is None:
                notes.append(f"{programme.title}: not fetched — {describe_failure(result)}")
                continue
            try:
                calendar = read_calendar(result.content)
            except ValueError as error:
                notes.append(f"{programme.title}: unreadable calendar ({error})")
                continue
            if calendar.cut:
                notes.append(f"{programme.title}: the calendar was cut at {RESULT_SET_SIZE}")
            pending.extend(
                _programme_drafts(
                    client,
                    programme,
                    result,
                    calendar,
                    window,
                    names,
                    index,
                    tally,
                    folding,
                    images,
                    notes,
                    now,
                    folded,
                )
            )
    if ctx.limit is not None:
        pending = pending[: ctx.limit]
    records = observations_from(
        pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
    )
    if folding.runs:
        notes.append(f"{folding.occurrences} occurrences folded into {folding.runs} runs")
    write_staging(ctx, _with_permission(records), tally)


__all__ = [
    "CATEGORY_TYPES",
    "FEED_URL",
    "PROGRAMMES_URL",
    "Calendar",
    "Details",
    "Occurrence",
    "Programme",
    "calendar_url",
    "event_draft",
    "event_type_of",
    "fold_runs",
    "folded_before",
    "image_url",
    "match_society",
    "on_demand_only",
    "price_from",
    "read_calendar",
    "read_details",
    "read_programmes",
    "run",
    "select_programmes",
    "should_fold",
    "society_names",
    "stable_end",
    "stable_start",
]
