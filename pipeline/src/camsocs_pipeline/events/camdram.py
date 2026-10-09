"""Camdram diary → performance events (source-research §5; stage `camdram_events`).

Re-verified 2026-10-07: robots.txt is ``User-agent: *`` with nothing disallowed;
the API page asks consumers for an API key ("unauthenticated API requests …
are subjected to very low rate limits and long response delays").

**Requests.** ``/diary.json?end=<window end>`` (Camdram starts the diary at the
current week's Sunday; default length 8 weeks, so ``end`` sets ~10), then
``/venues.json`` once, then ``/shows/<slug>.json`` per show in the diary (its
``societies[]``, description, booking link and image). With ``CAMDRAM_API_KEY``
the key goes in a Bearer header and requests are 1 s apart; without one they
are `UNAUTHENTICATED_INTERVAL` apart and show JSON is reused from the cache for
`SHOW_TTL`.

**Events.** A diary performance is a *run*: ``start_at`` (an instant) daily
until ``repeat_until`` at the same London wall-clock time. Each night becomes
one event, external id ``show:<show id>/performance:<run id>/<YYYY-MM-DD>``;
the **series** is the show — every night shares the ``show:<id>/`` prefix and
the show page as `sourceUrl`. A run longer than `MAX_EXPANDED_RUN` days (a film
or an exhibition listed for months) is one all-day event from its first to its
last day, external id ``show:<id>/performance:<run id>``. Non-show diary events
(``_type: event``) become one event per date, ``event:<id>/<date>``.

**Organisers.** The show's ``societies[]`` in display order: the first is the
``organiser``, the rest ``co_host`` (shows are often co-funded; the
eventOrganisers route turns co-hosts into ``co_hosted`` relationship edges).
Each is an identity hint with its Camdram id and slug, resolved against
staging and the crosswalk (`resolve.lookup.OrgLookup`).

**Venues.** A performance's ``venue`` object becomes a `venues` row
(``ven-<slug(name)>``, with address and coordinates from ``/venues.json``) and
the event's `venueKey`; a free-text ``other_venue`` becomes `venueText`.

**Images.** The show image (``/media/cache/preview/<filename>``) is fetched and
checked at harvest time and stored by `load` (`camsocs_pipeline.media`).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    default_window,
    describe_failure,
    fetched_at,
    london_midnight,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.keys import venue_key
from camsocs_pipeline.media import probe_image
from camsocs_pipeline.models.observation import IdentityHints, Observation, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup
from camsocs_pipeline.sources.base import FetchResult, PoliteClient

logger = logging.getLogger(__name__)

BASE = "https://www.camdram.net"
DIARY_URL = f"{BASE}/diary.json"
VENUES_URL = f"{BASE}/venues.json"

UNAUTHENTICATED_INTERVAL = 2.0
SHOW_TTL = timedelta(hours=20)
MAX_EXPANDED_RUN = 21

#: `other_venue` values that name no place.
_NOT_A_VENUE = frozenset({"", "n/a", "na", "not applicable", "tbc", "tba", "cambridge", "online"})

SOURCE_TYPE = "camdram"
EVENT_SOURCE = "camdram"
EVIDENCE = "primary"
COVERS = frozenset({"description", "bookingUrl", "venueText", "image"})


# --- parsing ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class CamdramVenue:
    id: int | None
    name: str
    slug: str | None = None
    short_name: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None


@dataclass(frozen=True)
class Society:
    name: str
    id: int | None = None
    slug: str | None = None


@dataclass
class Show:
    id: int
    slug: str
    name: str
    description: str | None = None
    societies: list[Society] = field(default_factory=list)
    booking_url: str | None = None
    image_filename: str | None = None
    category: str | None = None


@dataclass
class Performance:
    """One diary run."""

    id: int
    start_at: datetime
    repeat_until: date | None
    show_id: int
    show_slug: str
    show_name: str
    venue: CamdramVenue | None = None
    other_venue: str | None = None


@dataclass
class DiaryEvent:
    """A non-show diary entry (a society event)."""

    id: int
    name: str
    description: str | None
    dates: list[tuple[datetime, datetime | None]]
    societies: list[Society]


@dataclass
class Diary:
    performances: list[Performance] = field(default_factory=list)
    events: list[DiaryEvent] = field(default_factory=list)
    skipped: int = 0


def _instant(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=LONDON)


def _day(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _venue(data: Any) -> CamdramVenue | None:
    if not isinstance(data, dict) or not _text(data.get("name")):
        return None
    lat, lng = data.get("latitude"), data.get("longitude")
    return CamdramVenue(
        id=_int(data.get("id")),
        name=_text(data.get("name")) or "",
        slug=_text(data.get("slug")),
        short_name=_text(data.get("short_name")),
        address=_text(data.get("address")),
        lat=float(lat) if isinstance(lat, int | float) and not isinstance(lat, bool) else None,
        lng=float(lng) if isinstance(lng, int | float) and not isinstance(lng, bool) else None,
    )


def _societies(entries: Any, order: Any = None) -> list[Society]:
    societies: list[Society] = []
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict) and _text(entry.get("name")):
            societies.append(
                Society(
                    name=_text(entry.get("name")) or "",
                    id=_int(entry.get("id")),
                    slug=_text(entry.get("slug")),
                )
            )
    if isinstance(order, list) and order:
        rank = {society_id: n for n, society_id in enumerate(order)}
        societies.sort(key=lambda s: rank.get(s.id, len(rank)))
    return societies


def parse_diary(data: bytes) -> Diary:
    payload = json.loads(data)
    diary = Diary()
    for entry in payload.get("events", []) if isinstance(payload, dict) else []:
        if not isinstance(entry, dict):
            diary.skipped += 1
            continue
        kind = entry.get("_type")
        if kind == "performance":
            show = entry.get("show") or {}
            start = _instant(entry.get("start_at"))
            show_id, slug = _int(show.get("id")), _text(show.get("slug"))
            if start is None or show_id is None or slug is None or _int(entry.get("id")) is None:
                diary.skipped += 1
                continue
            diary.performances.append(
                Performance(
                    id=entry["id"],
                    start_at=start,
                    repeat_until=_day(entry.get("repeat_until")),
                    show_id=show_id,
                    show_slug=slug,
                    show_name=_text(show.get("name")) or slug,
                    venue=_venue(entry.get("venue")),
                    other_venue=_text(entry.get("other_venue")),
                )
            )
        elif kind == "event":
            dates = []
            for item in entry.get("dates") or [entry]:
                start = _instant(item.get("start_at")) if isinstance(item, dict) else None
                if start is not None:
                    dates.append((start, _instant(item.get("end_at"))))
            if not dates or _int(entry.get("id")) is None or not _text(entry.get("name")):
                diary.skipped += 1
                continue
            diary.events.append(
                DiaryEvent(
                    id=entry["id"],
                    name=_text(entry.get("name")) or "",
                    description=_text(entry.get("description")),
                    dates=dates,
                    societies=_societies(
                        entry.get("societies"), entry.get("societies_display_list")
                    ),
                )
            )
        else:
            diary.skipped += 1
    return diary


def parse_show(data: bytes) -> Show | None:
    payload = json.loads(data)
    if not isinstance(payload, dict) or _int(payload.get("id")) is None:
        return None
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    booking = _text(payload.get("online_booking_url"))
    return Show(
        id=payload["id"],
        slug=_text(payload.get("slug")) or "",
        name=_text(payload.get("name")) or "",
        description=_text(payload.get("description")),
        societies=_societies(payload.get("societies"), payload.get("societies_display_list")),
        booking_url=booking if booking and booking.startswith(("http://", "https://")) else None,
        image_filename=_text(image.get("filename")),
        category=_text(payload.get("category")),
    )


def parse_venues(data: bytes) -> dict[str, CamdramVenue]:
    payload = json.loads(data)
    venues: dict[str, CamdramVenue] = {}
    for entry in payload if isinstance(payload, list) else []:
        venue = _venue(entry)
        if venue is not None and venue.slug:
            venues[venue.slug] = venue
    return venues


# --- drafts ------------------------------------------------------------------------------------


def show_url(slug: str) -> str:
    return f"{BASE}/shows/{slug}.json"


def show_page(slug: str) -> str:
    return f"{BASE}/shows/{slug}"


def image_url(filename: str) -> str:
    return f"{BASE}/media/cache/preview/{filename}"


def nights(performance: Performance) -> list[datetime]:
    """Every night of a run at the run's London wall-clock time; one entry
    for a run longer than `MAX_EXPANDED_RUN` days (see the module docstring)."""
    first = performance.start_at.astimezone(LONDON)
    last_day = performance.repeat_until or first.date()
    if last_day < first.date():
        last_day = first.date()
    span = (last_day - first.date()).days
    if span > MAX_EXPANDED_RUN:
        return [first]
    return [
        datetime.combine(first.date() + timedelta(days=n), first.time(), tzinfo=LONDON)
        for n in range(span + 1)
    ]


def _organisers(societies: list[Society]) -> list[OrganiserObs]:
    return [
        OrganiserObs(
            identity=IdentityHints(name=s.name, camdram_id=s.id, camdram_slug=s.slug),
            role="organiser" if n == 0 else "co_host",
        )
        for n, s in enumerate(societies)
    ]


def _venue_hint(performance: Performance) -> IdentityHints | None:
    if performance.venue is not None:
        return IdentityHints(
            name=performance.venue.name, known_key=venue_key(performance.venue.name)
        )
    other = performance.other_venue
    if other and other.strip().lower() not in _NOT_A_VENUE:
        return IdentityHints(name=other)
    return None


def performance_drafts(
    performance: Performance, show: Show | None, *, image: str | None = None
) -> list[EventDraft]:
    starts = nights(performance)
    long_run = len(starts) == 1 and (
        performance.repeat_until is not None
        and (performance.repeat_until - performance.start_at.astimezone(LONDON).date()).days
        > MAX_EXPANDED_RUN
    )
    drafts: list[EventDraft] = []
    for start in starts:
        external_id = f"show:{performance.show_id}/performance:{performance.id}"
        ends_at, all_day = None, False
        if long_run and performance.repeat_until is not None:
            # A daily time over months means nothing: the run as whole days.
            start = london_midnight(start.date())
            ends_at = london_midnight(performance.repeat_until + timedelta(days=1))
            all_day = True
        else:
            external_id += f"/{start.date().isoformat()}"
        drafts.append(
            EventDraft(
                event_source=EVENT_SOURCE,
                external_id=external_id,
                title=(show.name if show and show.name else performance.show_name),
                starts_at=start,
                ends_at=ends_at,
                all_day=all_day,
                description=show.description if show else None,
                page_url=show_page(performance.show_slug),
                venue=_venue_hint(performance),
                booking_url=show.booking_url if show else None,
                event_type="performance",
                image_url=image,
                organisers=_organisers(show.societies) if show else [],
                covers=COVERS if show else frozenset({"venueText"}),
            )
        )
    return drafts


def diary_event_drafts(event: DiaryEvent) -> list[EventDraft]:
    return [
        EventDraft(
            event_source=EVENT_SOURCE,
            external_id=f"event:{event.id}/{start.astimezone(LONDON).date().isoformat()}",
            title=event.name,
            starts_at=start,
            ends_at=end,
            description=event.description,
            event_type="other",
            organisers=_organisers(event.societies),
            covers=frozenset({"description"}),
        )
        for start, end in event.dates
    ]


def venue_observation(venue: CamdramVenue, retrieved_at: datetime) -> Observation:
    fields = [
        parser_field("name", venue.name, extractor="camdram.venue.name", evidence="secondary")
    ]
    if venue.short_name and venue.short_name.lower() != venue.name.lower():
        fields.append(
            parser_field(
                "aliases",
                [venue.short_name],
                extractor="camdram.venue.aliases",
                evidence="secondary",
            )
        )
    for name, value in (("address", venue.address), ("lat", venue.lat), ("lng", venue.lng)):
        if value is not None:
            fields.append(
                parser_field(name, value, extractor=f"camdram.venue.{name}", evidence="secondary")
            )
    return Observation(
        source_type=SOURCE_TYPE,
        source_key=f"venue:{venue.slug or venue.name}",
        source_url=VENUES_URL,
        retrieved_at=retrieved_at,
        entity_type="venue",
        identity=IdentityHints(
            name=venue.name, aliases=[venue.short_name] if venue.short_name else []
        ),
        entity_key=venue_key(venue.name),
        fields=fields,
    )


# --- the stage ---------------------------------------------------------------------------------


def _headers(ctx: StageContext) -> dict[str, str] | None:
    key = ctx.settings.camdram_api_key.get_secret_value()
    return {"Authorization": f"Bearer {key}"} if key else None


def _get(client: PoliteClient, url: str, headers: dict[str, str] | None, **kw: Any) -> FetchResult:
    return client.fetch(url, accept="application/json", headers=headers, **kw)


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    headers = _headers(ctx)
    interval = None if headers else UNAUTHENTICATED_INTERVAL
    index = OrgLookup.for_stage(ctx)
    tally = Tally()
    end_day = window.end.astimezone(LONDON).date().isoformat()
    with polite_client(ctx.settings, min_interval=interval) as client:
        diary_result = _get(client, f"{DIARY_URL}?end={end_day}", headers)
        if not diary_result.ok or diary_result.content is None:
            raise RuntimeError(f"Camdram diary not fetched: {describe_failure(diary_result)}")
        diary = parse_diary(diary_result.content)
        diary_at = fetched_at(diary_result)

        venues: dict[str, CamdramVenue] = {}
        venues_result = _get(client, VENUES_URL, headers, fresh_for=SHOW_TTL)
        venues_at = diary_at
        if venues_result.ok and venues_result.content is not None:
            venues = parse_venues(venues_result.content)
            venues_at = fetched_at(venues_result)
        else:
            ctx.report.notes.append(f"venues not fetched: {describe_failure(venues_result)}")

        slugs = list(dict.fromkeys(p.show_slug for p in diary.performances))
        if ctx.limit is not None:
            slugs = slugs[: ctx.limit]
        shows: dict[str, tuple[Show | None, FetchResult]] = {}
        for slug in slugs:
            result = _get(client, show_url(slug), headers, fresh_for=SHOW_TTL)
            show = parse_show(result.content) if result.ok and result.content else None
            if show is None:
                tally.drop("show JSON unavailable (diary data only)")
            shows[slug] = (show, result)

        pending: list[Sourced] = []
        used_venues: dict[str, CamdramVenue] = {}
        images: dict[str, str | None] = {}
        for performance in diary.performances:
            if performance.show_slug not in shows:
                continue  # beyond --limit
            show, result = shows[performance.show_slug]
            image = None
            if show is not None and show.image_filename:
                url = image_url(show.image_filename)
                if url not in images:
                    images[url] = url if probe_image(client, url) else None
                image = images[url]
            if performance.venue is not None:
                detailed = venues.get(performance.venue.slug or "") or performance.venue
                used_venues[venue_key(detailed.name)] = detailed
            source_url, origin = (
                (show_url(show.slug), result) if show else (DIARY_URL, diary_result)
            )
            pending.extend(
                Sourced(draft, source_url, origin)
                for draft in performance_drafts(performance, show, image=image)
            )
        for event in diary.events:
            pending.extend(
                Sourced(draft, DIARY_URL, diary_result) for draft in diary_event_drafts(event)
            )
        records = observations_from(
            pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
        )
        venue_records = [venue_observation(v, venues_at) for v in used_venues.values()]
        tally.venues = len(venue_records)
    if diary.skipped:
        tally.drop("unreadable diary entries", diary.skipped)
    show_count = len({p.show_slug for p in diary.performances})
    ctx.report.notes.append(
        f"diary: {len(diary.performances)} runs of {show_count} shows, "
        f"{len(diary.events)} society events; {len(shows)} show pages read"
    )
    write_staging(ctx, [*venue_records, *records], tally)


__all__ = [
    "Diary",
    "Performance",
    "Show",
    "diary_event_drafts",
    "nights",
    "parse_diary",
    "parse_show",
    "parse_venues",
    "performance_drafts",
    "run",
    "venue_observation",
]
