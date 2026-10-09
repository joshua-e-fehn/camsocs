"""What every events stage shares: the clock, the window, the draft and the
one way a draft becomes a staged `EventObservation`.

**Times.** Parsers produce timezone-aware datetimes; `build_event_observation`
stores them as epoch milliseconds (UTC instants, data-model §0 rule 6). A time a
source gives without a zone is Cambridge time (`LONDON`). All-day events start
at 00:00 London on their first day and end at 00:00 London after their last
(exclusive), so `termWeekLabel` (derived on the server from `startsAt`) lands on
the right day.

**The window** (`EventWindow`): from 7 days ago to 70 days ahead, London
midnights. Every stage keeps only events that overlap it, and expands
recurrences only inside it. The look-back keeps a just-past event current (a
late cancellation); the horizon covers the rest of a term from its first week.

**Fields.** `EventDraft` holds what one source says about one event. The
builder turns each value into a claim with `claims.parser_field` (parsers only:
no event text reaches an LLM here). A field the source *could* state but did
not (``covers``) becomes a ``missing`` claim, so a page that drops a booking
link retracts it (data-model §1 rule 1). Values a rule guessed rather than read
(``inferred``: an event type from keywords, a date from a fixed calendar, a
re-read timezone) are claimed as ``inferred``.

**Organisers.** Hints are resolved with `resolve.lookup.OrgLookup.reference_key`; an organiser
nobody can match yet goes to ``unresolved_organisers`` instead of holding the
event back (`models.observation.EventObservation`).

**Personal addresses.** A CRSid-shaped address on cam.ac.uk (the server's
`personal_crsid` rule) names a person and never reaches a public field, so it
is replaced by ``[personal email withheld]`` in titles, descriptions and venue
text; role addresses (``president@soc.org``, ``soc-x@lists.cam.ac.uk``) stay.

**Content hashes.** Event observations carry no ``content_sha256``: a feed or
diary changes for unrelated reasons (a DTSTAMP of "now", a shifted window), and
the claim fingerprint would then change every run. Without it, re-posting the
same value from the same URL is a no-op that only bumps ``lastSeenAt``.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from html import unescape
from typing import Protocol
from zoneinfo import ZoneInfo

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.claims import epoch_ms, missing_field, parser_field
from camsocs_pipeline.config import Settings
from camsocs_pipeline.events.checks import CheckResult, check_draft
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import (
    EventObservation,
    FetchInfo,
    FieldObs,
    IdentityHints,
    OrganiserObs,
)
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.links import is_crsid_address
from camsocs_pipeline.staging.store import Record, events_directory

LONDON = ZoneInfo("Europe/London")

LOOKBACK_DAYS = 7
HORIZON_DAYS = 70

#: Server-side limits (webapp/convex/lib/fields.ts EVENT_SPECS).
TITLE_MAX = 300
DESCRIPTION_MAX = 20_000
VENUE_TEXT_MAX = 300
EXTERNAL_ID_MAX = 500

_ROLE_RANK = {"organiser": 0, "co_host": 1, "sponsor": 2}


# --- clock and window ------------------------------------------------------------------


def london_midnight(day: date) -> datetime:
    return datetime.combine(day, time(0, 0), tzinfo=LONDON)


def london_today(now: datetime | None = None) -> date:
    return (now or datetime.now(UTC)).astimezone(LONDON).date()


@dataclass(frozen=True)
class EventWindow:
    """``[start, end)``, both aware."""

    start: datetime
    end: datetime

    def overlaps(self, starts_at: datetime, ends_at: datetime | None = None) -> bool:
        last = ends_at if ends_at is not None and ends_at > starts_at else starts_at
        return starts_at < self.end and last >= self.start

    def months(self) -> list[tuple[int, int]]:
        """Every (year, month) the window touches, for month-based feeds."""
        months: list[tuple[int, int]] = []
        cursor = date(self.start.astimezone(LONDON).year, self.start.astimezone(LONDON).month, 1)
        last = self.end.astimezone(LONDON).date()
        while cursor <= last:
            months.append((cursor.year, cursor.month))
            cursor = date(cursor.year + cursor.month // 12, cursor.month % 12 + 1, 1)
        return months


def default_window(
    now: datetime | None = None,
    *,
    lookback_days: int = LOOKBACK_DAYS,
    horizon_days: int = HORIZON_DAYS,
) -> EventWindow:
    today = london_today(now)
    return EventWindow(
        start=london_midnight(today - timedelta(days=lookback_days)),
        end=london_midnight(today + timedelta(days=horizon_days)),
    )


# --- fetching ---------------------------------------------------------------------------


def polite_client(settings: Settings, *, min_interval: float | None = None) -> PoliteClient:
    """The crawler every events stage fetches through (robots, pacing, cache)."""
    interval = settings.min_host_interval
    if min_interval is not None:
        interval = max(interval, min_interval)
    return PoliteClient(
        user_agent=settings.require_user_agent(),
        cache_dir=settings.cache_dir,
        min_interval=interval,
    )


def fetched_at(result: FetchResult) -> datetime:
    moment = datetime.fromisoformat(result.fetched_at)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def fetch_info(result: FetchResult, *, crawl_delay: bool = False) -> FetchInfo:
    """The `sources` row facts of a fetch. ``crawl_delay``: the host's
    robots.txt sets a Crawl-delay we honoured (talks.cam, CUCBC)."""
    return FetchInfo(
        http_status=result.status,
        robots_verdict="crawl_delay" if crawl_delay else "allowed",
        robots_checked_at=fetched_at(result),
        access_note=result.detail if result.outcome not in ("fetched", "unchanged") else None,
    )


def describe_failure(result: FetchResult) -> str:
    detail = f" ({result.detail})" if result.detail else ""
    status = f" {result.status}" if result.status else ""
    return f"{result.outcome}{status}{detail}: {result.url}"


# --- text -------------------------------------------------------------------------------

_HTML_TAG = re.compile(r"<(?:[a-zA-Z][a-zA-Z0-9]*|/[a-zA-Z][a-zA-Z0-9]*)(?:\s[^<>]*)?/?>")
_BLOCK_TAGS = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6])\b[^>]*>", re.IGNORECASE)
_SPACES = re.compile(r"[ \t\u00a0]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def clean_text(text: str | None, *, max_length: int | None = None) -> str | None:
    """Plain text from a feed's free text: HTML (if any) to text, entities
    decoded, runs of spaces collapsed, paragraph breaks kept. None if empty."""
    if text is None:
        return None
    value = str(text)
    if _HTML_TAG.search(value):
        value = _BLOCK_TAGS.sub("\n", value)
        value = LexborHTMLParser(f"<body>{value}</body>").body.text(separator="")  # type: ignore[union-attr]
    value = unescape(value).replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in value.split("\n")]
    value = _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()
    if not value:
        return None
    if max_length is not None and len(value) > max_length:
        value = value[: max_length - 1].rstrip() + "…"
    return value


_EMAIL = re.compile(r"(?<![\w.+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
WITHHELD = "[personal email withheld]"


def is_personal_crsid(local: str, domain: str) -> bool:
    """The server's `classifyEmail` rule for `personal_crsid`
    (`links.is_crsid_address`): a CRSid-shaped address on cam.ac.uk or a
    subdomain (not lists.cam.ac.uk), SRCF or cantab."""
    return is_crsid_address(local, domain)


def redact_personal_emails(text: str | None) -> str | None:
    """Replaces personal CRSid addresses in free text: they name a person and
    never appear in a public field (AGENTS.md), even inside a description."""
    if not text:
        return text
    return _EMAIL.sub(
        lambda m: WITHHELD if is_personal_crsid(m.group(1), m.group(2)) else m.group(0), text
    )


def single_line(text: str | None, *, max_length: int) -> str | None:
    value = clean_text(text)
    if value is None:
        return None
    value = " ".join(value.split())
    return value[:max_length].rstrip() or None


#: Keyword → event type, first match wins (`infer_event_type`). Whole words,
#: case-insensitive, over the title only (descriptions mention everything).
_TYPE_KEYWORDS: tuple[tuple[str, str], ...] = (
    (r"workshop|masterclass|hackathon|tutorial|bootcamp", "workshop"),
    (r"careers?|recruitment|internship|employer|networking", "careers"),
    (r"formal|banquet|ball|gala dinner|garden party", "formal"),
    (r"talk|lecture|seminar|colloquium|panel|q\s*&\s*a|in conversation|debate|symposium", "talk"),
    (r"concert|recital|performance|gig|screening|play|musical|opera|show", "performance"),
    (r"tournament|competition|regatta|race|championship|cuppers|varsity|quiz", "competition"),
    (r"training|practice|rehearsal|session", "training"),
    (r"social|party|drinks|mixer|meet ?(?:&|and) ?greet|welcome|pub|crawl|bop|picnic", "social"),
    (r"trip|excursion|tour|hike|visit", "trip"),
    (r"service|evensong|mass|prayer|worship|eucharist", "worship"),
    (r"fair|freshers'? fair|fayre", "fair"),
    (r"agm|egm|meeting|general meeting|committee", "meeting"),
)


def infer_event_type(title: str, default: str = "other") -> str:
    """An event type from title keywords, else `default`. Either way a guess,
    not something the source states: callers claim it as ``inferred``
    (a source's own type field, where it has one, is read instead)."""
    lowered = title.lower()
    for pattern, event_type in _TYPE_KEYWORDS:
        if re.search(rf"\b(?:{pattern})\b", lowered):
            return event_type
    return default


# --- the draft --------------------------------------------------------------------------


@dataclass
class EventDraft:
    """One event as one source states it, before it becomes claims."""

    event_source: str
    external_id: str
    title: str
    starts_at: datetime
    ends_at: datetime | None = None
    all_day: bool = False
    description: str | None = None
    #: The event's own page (→ the `sourceUrl` field); defaults to the fetched URL.
    page_url: str | None = None
    #: A named venue; with a `known_key` it becomes `venueKey`, else `venueText`.
    venue: IdentityHints | None = None
    speakers: list[dict[str, str]] = field(default_factory=list)
    price: dict[str, object] | None = None
    booking_url: str | None = None
    signup_required: bool | None = None
    event_type: str = "other"
    #: An image URL already checked with `media.probe_image`.
    image_url: str | None = None
    cancelled: bool | None = None
    status: str = "confirmed"
    visibility: str = "public"
    organisers: list[OrganiserObs] = field(default_factory=list)
    #: Fields a rule guessed rather than read: claimed as ``inferred``.
    inferred: set[str] = field(default_factory=set)
    #: Optional fields this source can state: absent → a ``missing`` claim.
    covers: frozenset[str] = frozenset()
    #: Set by `check_draft`: the text points to a "link in bio".
    link_in_bio: bool = False

    def key(self) -> str:
        return event_key(self.event_source, self.external_id)


def merge_drafts(drafts: Iterable[EventDraft]) -> list[EventDraft]:
    """One draft per (source, externalId): the same UID in two feeds, or a talk
    on two lists, is one event with the union of their organisers."""
    merged: dict[tuple[str, str], EventDraft] = {}
    for draft in drafts:
        identity = (draft.event_source, draft.external_id)
        existing = merged.get(identity)
        if existing is None:
            merged[identity] = draft
            continue
        names = {(o.identity.known_key or o.identity.name, o.role) for o in existing.organisers}
        for organiser in draft.organisers:
            if (
                organiser.identity.known_key or organiser.identity.name,
                organiser.role,
            ) not in names:
                existing.organisers.append(organiser)
    return list(merged.values())


@dataclass
class Tally:
    """What a stage staged and why it left events out — the stage notes."""

    staged: int = 0
    venues: int = 0
    resolved_organisers: int = 0
    unresolved_organisers: int = 0
    link_in_bio: int = 0
    dropped: dict[str, int] = field(default_factory=dict)

    def drop(self, reason: str, count: int = 1) -> None:
        self.dropped[reason] = self.dropped.get(reason, 0) + count

    def notes(self) -> list[str]:
        notes = [
            f"staged {self.staged} events"
            + (f", {self.venues} venues" if self.venues else "")
            + f"; organisers {self.resolved_organisers} resolved, "
            f"{self.unresolved_organisers} unresolved"
        ]
        if self.link_in_bio:
            notes.append(f"{self.link_in_bio} point to a 'link in bio' (bookingUrl not published)")
        if self.dropped:
            notes.append(
                "left out: " + ", ".join(f"{n} {why}" for why, n in sorted(self.dropped.items()))
            )
        return notes


def finalise(
    drafts: Iterable[EventDraft], window: EventWindow, tally: Tally, *, now: datetime | None = None
) -> list[EventDraft]:
    """De-duplicates, sanity-checks and windows the drafts."""
    kept: list[EventDraft] = []
    for draft in merge_drafts(drafts):
        result: CheckResult = check_draft(draft, window, now=now)
        if not result.keep:
            tally.drop(result.reason or "rejected")
            continue
        if draft.link_in_bio:
            tally.link_in_bio += 1
        kept.append(draft)
    return kept


# --- draft → staged observation -------------------------------------------------------------


class _Resolver(Protocol):
    """The slice of `resolve.lookup.OrgLookup` the builder needs."""

    def resolve(self, hints: IdentityHints) -> str | None: ...

    def resolve_venue(self, name: str) -> str | None: ...


def _resolve_organisers(
    organisers: Sequence[OrganiserObs], index: _Resolver | None
) -> tuple[list[OrganiserObs], list[OrganiserObs]]:
    best: dict[str, OrganiserObs] = {}
    unresolved: list[OrganiserObs] = []
    for organiser in organisers:
        key = organiser.identity.known_key
        if key is None and index is not None:
            key = index.resolve(organiser.identity)
        if key is None:
            unresolved.append(organiser)
            continue
        resolved = OrganiserObs(
            identity=organiser.identity.model_copy(update={"known_key": key}), role=organiser.role
        )
        current = best.get(key)
        if current is None or _ROLE_RANK[resolved.role] < _ROLE_RANK[current.role]:
            best[key] = resolved
    return list(best.values()), unresolved


def build_event_observation(
    draft: EventDraft,
    *,
    source_type: str,
    source_url: str,
    retrieved_at: datetime,
    evidence: str,
    fetch: FetchInfo | None = None,
    index: _Resolver | None = None,
    extractor: str | None = None,
) -> EventObservation:
    """The staged observation of one checked draft (see the module docstring)."""
    prefix = extractor or draft.event_source
    fields: list[FieldObs] = []

    def put(name: str, value: object) -> None:
        if value is None or value == [] or value == "":
            if name in draft.covers:
                fields.append(
                    missing_field(
                        name, "not_found", extractor=f"{prefix}.{name}", evidence=evidence
                    )
                )
            return
        fields.append(
            parser_field(
                name,
                value,
                extractor=f"{prefix}.{name}",
                evidence=evidence,
                inferred=name in draft.inferred,
            )
        )

    put("title", single_line(redact_personal_emails(draft.title), max_length=TITLE_MAX))
    put("startsAt", epoch_ms(draft.starts_at))
    put("endsAt", epoch_ms(draft.ends_at) if draft.ends_at is not None else None)
    put("allDay", draft.all_day)
    put(
        "description",
        clean_text(redact_personal_emails(draft.description), max_length=DESCRIPTION_MAX),
    )
    if draft.page_url:
        put("sourceUrl", draft.page_url)
    put("speakers", draft.speakers or None)
    put("price", draft.price)
    if draft.booking_url is None and draft.link_in_bio:
        fields.append(
            missing_field(
                "bookingUrl", "not_published", extractor=f"{prefix}.bookingUrl", evidence=evidence
            )
        )
    else:
        put("bookingUrl", draft.booking_url)
    put("signupRequired", draft.signup_required)
    put("eventType", draft.event_type)
    put("image", {"sourceUrl": draft.image_url} if draft.image_url else None)
    put("cancelled", draft.cancelled)
    put("status", draft.status)

    venue = draft.venue
    if venue is not None:
        name = single_line(redact_personal_emails(venue.name), max_length=VENUE_TEXT_MAX)
        if name is None:
            venue = None
        else:
            key = venue.known_key or (index.resolve_venue(name) if index is not None else None)
            venue = venue.model_copy(update={"name": name, "known_key": key})
    if venue is None and "venueText" in draft.covers:
        fields.append(
            missing_field("venueText", "not_found", extractor=f"{prefix}.venue", evidence=evidence)
        )

    organisers, unresolved = _resolve_organisers(draft.organisers, index)
    return EventObservation(
        source_type=source_type,
        source_key=draft.external_id[:EXTERNAL_ID_MAX],
        source_url=source_url,
        retrieved_at=retrieved_at,
        fetch=fetch,
        fields=fields,
        event_source=draft.event_source,
        external_id=draft.external_id[:EXTERNAL_ID_MAX],
        visibility=draft.visibility,
        organisers=organisers,
        unresolved_organisers=unresolved,
        venue=venue,
    )


@dataclass
class Sourced:
    """A draft and the fetch it came from."""

    draft: EventDraft
    source_url: str
    result: FetchResult
    #: Overrides the stage's source type (a feed stage reading ICS and Luma).
    source_type: str | None = None
    evidence: str | None = None


def observations_from(
    pending: Sequence[Sourced],
    window: EventWindow,
    tally: Tally,
    *,
    source_type: str,
    evidence: str,
    index: _Resolver | None,
    crawl_delay: bool = False,
    now: datetime | None = None,
) -> list[EventObservation]:
    """Checks, de-duplicates (first source wins, organisers merged) and builds
    the staged observations of a stage's drafts."""
    first: dict[tuple[str, str], Sourced] = {}
    for item in pending:
        first.setdefault((item.draft.event_source, item.draft.external_id), item)
    observations: list[EventObservation] = []
    for draft in finalise([item.draft for item in pending], window, tally, now=now):
        origin = first[(draft.event_source, draft.external_id)]
        observations.append(
            build_event_observation(
                draft,
                source_type=origin.source_type or source_type,
                source_url=origin.source_url,
                retrieved_at=fetched_at(origin.result),
                evidence=origin.evidence or evidence,
                fetch=fetch_info(origin.result, crawl_delay=crawl_delay),
                index=index,
            )
        )
    return observations


def count_organisers(observations: Iterable[EventObservation], tally: Tally) -> None:
    for observation in observations:
        tally.resolved_organisers += len(observation.organisers)
        tally.unresolved_organisers += len(observation.unresolved_organisers)


def write_staging(ctx: StageContext, records: Sequence[Record], tally: Tally) -> None:
    """Writes the stage's records to ``<source_type>.events`` (one directory
    per source type among them) and adds the stage notes."""
    events = [r for r in records if isinstance(r, EventObservation)]
    tally.staged += len(events)
    count_organisers(events, tally)
    by_type: dict[str, list[Record]] = {}
    for record in records:
        by_type.setdefault(record.source_type, []).append(record)
    for source_type, subset in sorted(by_type.items()):
        ctx.staging.write(events_directory(source_type), ctx.run.run_key, subset)
    ctx.report.notes.extend(tally.notes())


__all__ = [
    "DESCRIPTION_MAX",
    "LONDON",
    "TITLE_MAX",
    "VENUE_TEXT_MAX",
    "EventDraft",
    "EventWindow",
    "Sourced",
    "Tally",
    "build_event_observation",
    "clean_text",
    "default_window",
    "describe_failure",
    "fetch_info",
    "fetched_at",
    "finalise",
    "infer_event_type",
    "london_midnight",
    "london_today",
    "merge_drafts",
    "observations_from",
    "polite_client",
    "redact_personal_emails",
    "single_line",
    "write_staging",
]
