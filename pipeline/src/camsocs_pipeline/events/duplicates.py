"""One event, several sources: cross-source de-duplication at load time.

An event key is ``evt-<sha1(source:externalId)>``, so the same evening listed
on Camdram, on the society's website and in its Google Calendar would be
three rows. The LLM stages already drop an event another staged source has
(`extract.dedupe`), but deterministic sources overlap too (a show on Camdram
and on SU What's On; a society's Google and Luma calendars), and the website
stage reads pages whose events the feeds may also carry. `find_duplicates`
runs over everything `load` is about to post and decides which observations
describe one event.

**Same event** — all of:

- the same visibility (a ``cam_only`` mail copy never merges into a public
  event: the strictest reading would hide it, data-model §1 rule 3);
- not two entries of one listing (the same source and source URL: one feed,
  one page): the listing itself says they are two events;
- at least one resolved organiser in common (no organiser, no merge);
- the same Europe/London calendar date;
- similar titles (`extract.dedupe.similar_titles`: one title's words contain
  the other's, or they share at least half);
- when both are timed, starts at most `MAX_START_GAP` (30 minutes) apart; an
  all-day reading matches any time that day.

**Which reading is primary** — the higher-evidence one (`rank`): a timed
reading before an all-day one; a start the source states before an inferred
one; a parser before an LLM; primary evidence before secondary; then the
source order in `SOURCE_ORDER` (structured listings first) and the key, so the
choice is stable from run to run. Clusters are built greedily in that order
and every reading is compared with a cluster's primary only, so two timed
performances on one day (a matinee and an evening) never fold into one event
through an all-day reading that matches both.

**What the others become** — additional claims on the primary's event
(`claims.claims_for_event(duplicate_of=…)`): their own provenance (source URL,
method, quote) on the primary's key, without the identity claims (`source`,
`externalId`, `sourceUrl`), so the event keeps its listing and sweep group
(data-model §2). A reading whose timing is coarser or finer than the
primary's (all-day vs timed) adds no `startsAt` / `endsAt` / `allDay`: midnight
is a representation of "no time given", not a competing start. Their
organisers are added (`merge`), never replacing the primary's set.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from camsocs_pipeline.extract.dedupe import similar_titles
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import EventObservation, FieldObs

LONDON = ZoneInfo("Europe/London")

#: Two timed readings of one event start at most this far apart.
MAX_START_GAP = timedelta(minutes=30)

#: Structured listings first, then the readings an LLM made.
SOURCE_ORDER: tuple[str, ...] = (
    "manual",
    "camdram",
    "talks_cam",
    "cucbc",
    "su_whatson",
    "google_calendar",
    "ics",
    "luma",
    "playwaze",
    "uni_events_api",
    "website",
    "termcard",
    "instagram_api",
    "mailing_list",
)
_TIMING = frozenset({"startsAt", "endsAt", "allDay"})
#: Claims only the primary makes: the event's identity and listing.
IDENTITY_FIELDS = frozenset({"sourceUrl"})

EventId = tuple[str, str]


def identity(record: EventObservation) -> EventId:
    return (record.event_source, record.external_id)


@dataclass(frozen=True)
class _Reading:
    record: EventObservation
    title: str
    starts_at: datetime
    all_day: bool
    organisers: frozenset[str]

    @property
    def id(self) -> EventId:
        return identity(self.record)

    @property
    def day(self) -> object:
        return self.starts_at.astimezone(LONDON).date()


def _field(record: EventObservation, name: str) -> FieldObs | None:
    for obs in record.fields:
        if obs.field == name and obs.value is not None:
            return obs
    return None


def _reading(record: EventObservation) -> _Reading | None:
    title, starts = _field(record, "title"), _field(record, "startsAt")
    organisers = frozenset(o.identity.known_key for o in record.organisers if o.identity.known_key)
    if title is None or starts is None or not organisers:
        return None
    if not isinstance(title.value, str) or not isinstance(starts.value, int):
        return None
    all_day = _field(record, "allDay")
    return _Reading(
        record=record,
        title=title.value,
        starts_at=datetime.fromtimestamp(starts.value / 1000, tz=UTC),
        all_day=bool(all_day.value) if all_day is not None else False,
        organisers=organisers,
    )


def _stated(obs: FieldObs | None) -> bool:
    """A value the source states (not a rule's or a model's guess)."""
    if obs is None or obs.status == "inferred":
        return False
    return obs.method != "llm" or obs.quote_check in ("exact", "normalised")


def rank(reading: _Reading) -> tuple:
    """Sort key, best first (module docstring)."""
    record = reading.record
    starts = _field(record, "startsAt")
    order = (
        SOURCE_ORDER.index(record.event_source)
        if record.event_source in SOURCE_ORDER
        else len(SOURCE_ORDER)
    )
    return (
        reading.all_day,
        not _stated(starts),
        starts is not None and starts.method == "llm",
        starts is not None and starts.evidence != "primary",
        order,
        event_key(*reading.id),
    )


def same_event(primary: _Reading, other: _Reading) -> bool:
    """The match rules in the module docstring (`other` against a primary)."""
    if primary.record.visibility != other.record.visibility:
        return False
    if (
        primary.record.event_source == other.record.event_source
        and primary.record.source_url == other.record.source_url
    ):
        return False
    if not primary.organisers & other.organisers:
        return False
    if primary.day != other.day:
        return False
    timed = not primary.all_day and not other.all_day
    if timed and abs(primary.starts_at - other.starts_at) > MAX_START_GAP:
        return False
    return similar_titles(primary.title, other.title)


@dataclass
class Duplicates:
    """`find_duplicates`' answer: which reading is folded into which event."""

    #: (source, externalId) of a duplicate reading → its primary's.
    primary_of: dict[EventId, EventId] = field(default_factory=dict)
    #: Readings whose timing granularity differs from their primary's.
    coarser: set[EventId] = field(default_factory=set)

    def __len__(self) -> int:
        return len(self.primary_of)

    def notes(self) -> list[str]:
        if not self.primary_of:
            return []
        pairs: dict[tuple[str, str], int] = defaultdict(int)
        for duplicate, primary in self.primary_of.items():
            pairs[(duplicate[0], primary[0])] += 1
        return [
            f"{len(self.primary_of)} event readings merged into another source's event: "
            + ", ".join(f"{n} {dup} → {prim}" for (dup, prim), n in sorted(pairs.items()))
        ]


def find_duplicates(records: Iterable[object]) -> Duplicates:
    """Which event observations describe an event another one already lists."""
    readings = [
        reading
        for record in records
        if isinstance(record, EventObservation) and (reading := _reading(record)) is not None
    ]
    buckets: dict[tuple[object, str], list[_Reading]] = defaultdict(list)
    for reading in readings:
        buckets[(reading.day, reading.record.visibility)].append(reading)
    result = Duplicates()
    for bucket in buckets.values():
        if len(bucket) < 2:
            continue
        primaries: list[_Reading] = []
        seen: set[EventId] = set()
        for reading in sorted(bucket, key=rank):
            if reading.id in seen:
                continue
            seen.add(reading.id)
            match = next((p for p in primaries if same_event(p, reading)), None)
            if match is None:
                primaries.append(reading)
                continue
            result.primary_of[reading.id] = match.id
            if match.all_day != reading.all_day:
                result.coarser.add(reading.id)
    return result


def as_duplicate(record: EventObservation, duplicates: Duplicates) -> EventObservation:
    """The fields a duplicate reading contributes to its primary's event."""
    if identity(record) not in duplicates.coarser:
        return record
    return record.model_copy(
        update={"fields": [f for f in record.fields if f.field not in _TIMING]}
    )


def primaries_first(records: Sequence[object], duplicates: Duplicates) -> list[object]:
    """Every record, the duplicate readings after all others: a primary's
    claims create its event and its organiser set is replaced before a
    duplicate's organisers are added."""
    head = [
        r
        for r in records
        if not (isinstance(r, EventObservation) and identity(r) in duplicates.primary_of)
    ]
    tail = [
        r
        for r in records
        if isinstance(r, EventObservation) and identity(r) in duplicates.primary_of
    ]
    return [*head, *tail]


__all__ = [
    "IDENTITY_FIELDS",
    "MAX_START_GAP",
    "SOURCE_ORDER",
    "Duplicates",
    "as_duplicate",
    "find_duplicates",
    "identity",
    "primaries_first",
    "rank",
    "same_event",
]
