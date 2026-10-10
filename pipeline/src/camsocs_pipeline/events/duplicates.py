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
- at least one resolved organiser in common — or, for a structured listing
  that names no organiser (a Camdram show without a society), a society's
  own page or card listing an event of the same name at the same minute;
- the same Europe/London calendar date;
- similar titles (`extract.dedupe.similar_titles`: one title's words contain
  the other's, or they share at least half) — or, with an organiser in common
  and the very same start, one distinctive word in common ("Seminar 2:
  Ethics in Modelling" on a termcard is "Seminar: Financial Mathematics and
  Modelling" on the events page, Tuesday 16:00) — or, for a card's or post's
  one-day all-day row and a timed reading of a card or post, one naming the
  other in its title or description (the term card's "Cinema ItaSoc",
  described "The Last One for the Road", and the film's poster at 20:15;
  `extract.dedupe.named_in`, review 2026-10-10);
- when both are timed, starts at most `MAX_START_GAP` (30 minutes) apart; an
  all-day reading matches any time that day. A feed's time and a page's time
  exactly one hour apart in British Summer Time are one event too: the
  page's reader took the feed's UTC for local time, or the other way round;
  the feed's time stands (`BST_SLIP`).

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
is a representation of "no time given", not a competing start, and a reading
whose title is unlike the primary's (matched by its start or by naming it)
adds no `title` to compete with the primary's. Their organisers are added
(`merge`), never replacing the primary's set.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from camsocs_pipeline.extract.dedupe import named_in, similar_titles, title_tokens
from camsocs_pipeline.keys import event_key
from camsocs_pipeline.models.observation import EventObservation, FieldObs

LONDON = ZoneInfo("Europe/London")

#: Two timed readings of one event start at most this far apart.
MAX_START_GAP = timedelta(minutes=30)
#: A feed's and a page's times this far apart in British Summer Time.
BST_SLIP = timedelta(hours=1)
#: Listings whose entry may name no organiser (a Camdram show without a society).
_LISTINGS = frozenset({"camdram", "talks_cam", "su_whatson", "cucbc"})
#: A society's own page or card.
_OWN_PAGES = frozenset({"website", "termcard"})
#: Feeds whose times are instants (UTC or zoned), as read by a parser.
_FEEDS = frozenset({"google_calendar", "ics", "luma"})
#: Words too common in event titles to make two titles one.
_GENERIC_TITLE_WORDS = frozenset(
    {
        "seminar",
        "talk",
        "lecture",
        "event",
        "social",
        "meeting",
        "session",
        "workshop",
        "night",
        "evening",
        "week",
        "term",
        "michaelmas",
        "lent",
        "easter",
        "freshers",
        "welcome",
        "drinks",
        "training",
        "series",
    }
)

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
    if title is None or starts is None:
        return None
    if not organisers and record.event_source not in _LISTINGS:
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


def bst_slip(primary: _Reading, other: _Reading) -> bool:
    """A feed's time and a page's exactly an hour apart in British Summer
    Time (module docstring): one event, the feed's time stands."""
    sources = {primary.record.event_source, other.record.event_source}
    if not (sources & _FEEDS and sources & _OWN_PAGES):
        return False
    if primary.all_day or other.all_day:
        return False
    offset = primary.starts_at.astimezone(LONDON).utcoffset()
    return offset == BST_SLIP and abs(primary.starts_at - other.starts_at) == BST_SLIP


def _distinctive(title: str) -> frozenset[str]:
    return frozenset(
        word for word in title_tokens(title) if word not in _GENERIC_TITLE_WORDS and len(word) > 2
    )


#: Sources whose readings are rows of a card or a post, read by a model.
_CARD_SOURCES = frozenset({"termcard", "instagram_api"})


def _description(record: EventObservation) -> str:
    obs = _field(record, "description")
    return obs.value if obs is not None and isinstance(obs.value, str) else ""


def _one_evening(a: _Reading, b: _Reading) -> bool:
    """A card's one-day all-day row and a timed card or poster reading that
    name one thing differently (module docstring)."""
    if a.all_day == b.all_day:
        return False
    if not {a.record.event_source, b.record.event_source} <= _CARD_SOURCES:
        return False
    whole_day = a if a.all_day else b
    ends = _field(whole_day.record, "endsAt")
    if ends is not None and isinstance(ends.value, int):
        last = datetime.fromtimestamp(ends.value / 1000 - 1, tz=UTC).astimezone(LONDON).date()
        if last != whole_day.day:
            return False  # a run of days, not one evening
    return named_in(a.title, b.title, _description(b.record)) or named_in(
        b.title, a.title, _description(a.record)
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
    if primary.day != other.day:
        return False
    timed = not primary.all_day and not other.all_day
    gap = abs(primary.starts_at - other.starts_at)
    slip = bst_slip(primary, other)
    if timed and gap > MAX_START_GAP and not slip:
        return False
    same_start = timed and (gap < timedelta(minutes=1) or slip)
    if primary.organisers & other.organisers:
        if similar_titles(primary.title, other.title):
            return True
        if _one_evening(primary, other):
            return True
        return same_start and bool(_distinctive(primary.title) & _distinctive(other.title))
    if primary.organisers and other.organisers:
        return False
    # One side names no organiser: a structured listing's entry (a Camdram
    # show without a society) and a society's own page listing the same name
    # at the same minute.
    listing, page = (primary, other) if not primary.organisers else (other, primary)
    if listing.organisers or listing.record.event_source not in _LISTINGS:
        return False
    if page.record.event_source not in _OWN_PAGES:
        return False
    left, right = title_tokens(primary.title), title_tokens(other.title)
    return same_start and bool(left and right) and (left <= right or right <= left)


@dataclass
class Duplicates:
    """`find_duplicates`' answer: which reading is folded into which event."""

    #: (source, externalId) of a duplicate reading → its primary's.
    primary_of: dict[EventId, EventId] = field(default_factory=dict)
    #: Readings whose timing does not join their primary's: another
    #: granularity (all-day vs timed), or an hour's BST slip.
    coarser: set[EventId] = field(default_factory=set)
    #: Readings whose title is not like their primary's (the term card's row
    #: "Cinema ItaSoc" of the film's poster): the primary's title stands, they
    #: add none to compete with it.
    untitled: set[EventId] = field(default_factory=set)

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
            if not similar_titles(match.title, reading.title):
                result.untitled.add(reading.id)
            if match.all_day != reading.all_day or bst_slip(match, reading):
                # A start of another granularity, or an hour's slip: the
                # primary's timing stands, this reading adds none.
                result.coarser.add(reading.id)
    return result


def as_duplicate(record: EventObservation, duplicates: Duplicates) -> EventObservation:
    """The fields a duplicate reading contributes to its primary's event:
    no timing of another granularity, no title unlike the primary's."""
    dropped: set[str] = set()
    if identity(record) in duplicates.coarser:
        dropped |= _TIMING
    if identity(record) in duplicates.untitled:
        dropped.add("title")
    if not dropped:
        return record
    return record.model_copy(
        update={"fields": [f for f in record.fields if f.field not in dropped]}
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
