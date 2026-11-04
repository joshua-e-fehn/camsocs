"""Is this LLM-extracted event already known from another source?

An event key is `evt-<sha1(source:externalId)>`, so the same evening listed
on Camdram, in a termcard and in an Instagram caption would be three rows.
The LLM stages (`inbox`, `instagram`, `termcards`) therefore drop an event
when another source already has it: same organiser, same start minute, and a
similar title (`similar_titles`). The other sources' events are read from the
latest staging file of every directory, which is where the event-feed stages
(T6) and the earlier LLM stages write them.

Precedence follows stage order: deterministic feeds run first and always win;
then `instagram`, then `termcards`. `inbox` (cam_only) defers to every staged
source, and `instagram` / `termcards` ignore staged list-mail events, so a
public event is never hidden behind a cam_only copy.

`match_record` names the staged reading that has the event, so `instagram`
and `termcards`, which read the same posts and cards again every run, can
keep the pair (`ShadowedReading`): a reading posted under its own key before
the other source listed the evening is retired to it at load (ENG-47). A
mail is read once, so `inbox` never drops a reading it posted before.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable

from camsocs_pipeline.extract.evidence import normalise_text
from camsocs_pipeline.models.observation import EventObservation, ShadowedReading
from camsocs_pipeline.staging.store import Record, StagingStore

#: Words that say nothing about which event it is.
_STOPWORDS = frozenset(
    {"the", "a", "an", "and", "of", "with", "for", "at", "in", "on", "to", "our", "x", "&", "-"}
)
_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def title_tokens(title: str) -> frozenset[str]:
    return frozenset(
        word for word in _WORD.findall(normalise_text(title)) if word not in _STOPWORDS
    )


def similar_titles(a: str, b: str) -> bool:
    """Same event name, give or take wording: one token set contains the other
    ("Pub Quiz" / "CUGS Pub Quiz"), or they share at least half their tokens."""
    left, right = title_tokens(a), title_tokens(b)
    if not left or not right:
        return False
    if left <= right or right <= left:
        return True
    return len(left & right) / len(left | right) >= 0.5


def named_in(title: str, other_title: str, other_description: str) -> bool:
    """Whether `title` (two words or more, stop words aside) is in another
    reading's title or description: a term card's "Cinema ItaSoc" row,
    described "The Last One for the Road", and the film's own poster "THE
    LAST ONE FOR THE ROAD" (review 2026-10-10)."""
    words = title_tokens(title)
    if len(words) < 2:
        return False
    return words <= title_tokens(other_title) or words <= title_tokens(other_description)


def _value(record: EventObservation, name: str) -> object:
    for obs_field in record.fields:
        if obs_field.field == name and obs_field.value is not None:
            return obs_field.value
    return None


#: A reading's identity: (event source, external id), as `keys.event_key` takes it.
EventId = tuple[str, str]
#: A known title and the reading it came from (None when added without one).
_Known = tuple[str, EventId | None]


class EventIndex:
    """Known events by (organiser, start minute) → titles."""

    def __init__(self) -> None:
        self._titles: dict[tuple[str | None, int], list[_Known]] = defaultdict(list)
        self._by_minute: dict[int, list[_Known]] = defaultdict(list)

    def add(
        self,
        org_keys: Iterable[str | None],
        starts_at: int,
        title: str,
        identity: EventId | None = None,
    ) -> None:
        minute = starts_at // 60_000
        for org_key in org_keys:
            self._titles[(org_key, minute)].append((title, identity))
        self._by_minute[minute].append((title, identity))

    def add_record(self, record: EventObservation) -> None:
        starts_at, title = _value(record, "startsAt"), _value(record, "title")
        if not isinstance(starts_at, int) or not isinstance(title, str):
            return
        orgs = [o.identity.known_key for o in record.organisers if o.identity.known_key]
        self.add(orgs or [None], starts_at, title, (record.event_source, record.external_id))

    @classmethod
    def from_records(cls, records: Iterable[Record]) -> EventIndex:
        index = cls()
        for record in records:
            if isinstance(record, EventObservation):
                index.add_record(record)
        return index

    @classmethod
    def from_staging(cls, store: StagingStore, *, exclude: Iterable[str] = ()) -> EventIndex:
        """Events from every staging directory except `exclude` (the calling
        stage's own, whose previous output must not shadow this run's)."""
        skip = set(exclude)
        return cls.from_records(
            record
            for name in store.directories()
            if name not in skip
            for record in store.read_latest(name)
        )

    def _match(self, org_key: str | None, starts_at: int, title: str) -> _Known | None:
        minute = starts_at // 60_000
        candidates = (
            self._titles.get((org_key, minute), [])
            if org_key is not None
            else self._by_minute.get(minute, [])
        )
        return next((known for known in candidates if similar_titles(title, known[0])), None)

    def is_duplicate(self, org_key: str | None, starts_at: int, title: str) -> bool:
        return self._match(org_key, starts_at, title) is not None

    def match_record(self, record: EventObservation) -> _Known | None:
        """The first known title (and its reading) this record duplicates."""
        starts_at, title = _value(record, "startsAt"), _value(record, "title")
        if not isinstance(starts_at, int) or not isinstance(title, str):
            return None
        orgs = [o.identity.known_key for o in record.organisers if o.identity.known_key]
        return next(
            (
                known
                for org in (orgs or [None])
                if (known := self._match(org, starts_at, title)) is not None
            ),
            None,
        )

    def is_duplicate_record(self, record: EventObservation) -> bool:
        return self.match_record(record) is not None

    def shadowed(self, record: EventObservation) -> ShadowedReading | None:
        """The pair to keep when `record` is dropped as a duplicate of a staged
        reading (ENG-47), or None when it is no duplicate, or the reading that
        has it is not known (added without one)."""
        known = self.match_record(record)
        if known is None or known[1] is None:
            return None
        by_source, by_external_id = known[1]
        organisers = [o.identity.known_key for o in record.organisers if o.identity.known_key]
        return ShadowedReading(
            event_source=record.event_source,
            external_id=record.external_id,
            organiser=organisers[0] if organisers else None,
            by_source=by_source,
            by_external_id=by_external_id,
        )


__all__ = [
    "EventId",
    "EventIndex",
    "named_in",
    "similar_titles",
    "title_tokens",
]
