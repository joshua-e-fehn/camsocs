"""Is this LLM-extracted event already known from another source?

An event key is `evt-<sha1(source:externalId)>`, so the same evening listed
on Camdram, in a termcard and in an Instagram caption would be three rows.
The LLM stages (`inbox`, `instagram`, `termcards`) therefore drop an event
when another source already has it: same organiser, same start minute, and a
similar title (`similar_titles`). The other sources' events are read from the
latest staging file of every directory, which is where the event-feed stages
(T6) and the earlier LLM stages write them.

Precedence follows stage order: deterministic feeds run first and always win;
then `inbox` (cam_only), `instagram`, `termcards`. A public event is never
hidden behind a cam_only copy because `inbox` defers to every staged source.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable

from camsocs_pipeline.extract.evidence import normalise_text
from camsocs_pipeline.models.observation import EventObservation
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


def _value(record: EventObservation, name: str) -> object:
    for obs_field in record.fields:
        if obs_field.field == name and obs_field.value is not None:
            return obs_field.value
    return None


class EventIndex:
    """Known events by (organiser, start minute) → titles."""

    def __init__(self) -> None:
        self._titles: dict[tuple[str | None, int], list[str]] = defaultdict(list)
        self._by_minute: dict[int, list[str]] = defaultdict(list)

    def add(self, org_keys: Iterable[str | None], starts_at: int, title: str) -> None:
        minute = starts_at // 60_000
        for org_key in org_keys:
            self._titles[(org_key, minute)].append(title)
        self._by_minute[minute].append(title)

    def add_record(self, record: EventObservation) -> None:
        starts_at, title = _value(record, "startsAt"), _value(record, "title")
        if not isinstance(starts_at, int) or not isinstance(title, str):
            return
        orgs = [o.identity.known_key for o in record.organisers if o.identity.known_key]
        self.add(orgs or [None], starts_at, title)

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

    def is_duplicate(self, org_key: str | None, starts_at: int, title: str) -> bool:
        minute = starts_at // 60_000
        candidates = (
            self._titles.get((org_key, minute), [])
            if org_key is not None
            else self._by_minute.get(minute, [])
        )
        return any(similar_titles(title, known) for known in candidates)

    def is_duplicate_record(self, record: EventObservation) -> bool:
        starts_at, title = _value(record, "startsAt"), _value(record, "title")
        if not isinstance(starts_at, int) or not isinstance(title, str):
            return False
        orgs = [o.identity.known_key for o in record.organisers if o.identity.known_key]
        return any(self.is_duplicate(org, starts_at, title) for org in (orgs or [None]))


__all__ = ["EventIndex", "similar_titles", "title_tokens"]
