"""What one organisation's site reading produces: the target, the pages
fetched, the observations per page, the counts — shared by the enricher
(`enrich.py`) and the LLM answer's mapping (`mapping.py`)."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime

from camsocs_pipeline.models.observation import (
    FetchInfo,
    FieldObs,
    IdentityHints,
    Observation,
    RelObs,
)
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.links import host_of, name_tokens
from camsocs_pipeline.sources.websites.page import Page

#: An organisation's own website or Linktree is its own channel.
EVIDENCE = "primary"


@dataclass
class Target:
    """One resolved organisation to enrich."""

    key: str
    name: str
    aliases: list[str] = field(default_factory=list)
    org_type: str | None = None
    level: str | None = None
    college: str | None = None
    su_category: str | None = None
    sport_registered: bool = False
    instagram: str | None = None
    website: str | None = None
    linktree: str | None = None

    @property
    def words(self) -> set[str]:
        return name_tokens(self.name, *self.aliases)


@dataclass
class Fetched:
    kind: str
    result: FetchResult
    page: Page | None = None

    @property
    def url(self) -> str:
        return self.result.final_url or self.result.url


def fetch_info(result: FetchResult) -> FetchInfo:
    """The page's `sources` row. A page read only because the society purpose
    overrode robots.txt (`sources/policy.py`) is ``disallowed`` with the
    override in its access note."""
    if result.outcome == "disallowed_by_robots":
        return FetchInfo(robots_verdict="disallowed", access_note=result.detail)
    notes = [result.override] if result.override else []
    if result.outcome not in ("fetched", "unchanged"):
        notes.append(result.detail or result.outcome)
    return FetchInfo(
        http_status=result.status,
        robots_verdict="disallowed" if result.override else "allowed",
        access_note="; ".join(notes) or None,
    )


def when(result: FetchResult) -> datetime:
    try:
        return datetime.fromisoformat(result.fetched_at)
    except ValueError:
        return datetime.now(UTC)


@dataclass
class PartnerMention:
    """A sponsor / partner named on a page, waiting for its key (the stage
    keys them on one thread: the resolver is not thread-safe)."""

    record: Observation
    relationship: RelObs
    quote: str
    page_text: str


@dataclass
class Stats:
    pages: int = 0
    llm_calls: int = 0
    llm_cached: int = 0
    llm_seconds: float = 0.0
    llm_failed: int = 0
    llm_skipped_robots: int = 0
    fields_found: int = 0
    fields_inferred: int = 0
    fields_missing: int = 0
    people: int = 0
    sessions: int = 0
    partners: int = 0
    unreachable: int = 0
    disallowed: int = 0
    not_about: int = 0
    by_field: Counter = field(default_factory=Counter)

    def add(self, other: Stats) -> None:
        for name, value in vars(other).items():
            if name == "by_field":
                self.by_field.update(value)
            else:
                setattr(self, name, getattr(self, name) + value)


@dataclass
class TargetResult:
    target: Target
    website: list[Observation] = field(default_factory=list)
    linktree: list[Observation] = field(default_factory=list)
    partners: list[PartnerMention] = field(default_factory=list)
    stats: Stats = field(default_factory=Stats)
    notes: list[str] = field(default_factory=list)


class SiteRecords:
    """The observations of one site: one per page read, in reading order."""

    def __init__(self, target: Target, source_type: str) -> None:
        self.target = target
        self.source_type = source_type
        self.records: list[Observation] = []
        self.by_url: dict[str, Observation] = {}
        self.texts: dict[str, str] = {}

    def page(self, fetched: Fetched) -> Observation:
        url = fetched.url
        if url not in self.by_url:
            record = Observation(
                source_type=self.source_type,
                source_key=url,
                source_url=url,
                retrieved_at=when(fetched.result),
                content_sha256=fetched.result.content_sha256,
                fetch=fetch_info(fetched.result),
                entity_type="organisation",
                identity=IdentityHints(name=self.target.name, known_key=self.target.key),
                entity_key=self.target.key,
            )
            self.by_url[url] = record
            self.records.append(record)
            self.texts[url] = fetched.page.text if fetched.page else ""
        return self.by_url[url]

    def add(self, url: str, obs: FieldObs) -> None:
        record = self.by_url[url]
        if any(existing.field == obs.field for existing in record.fields):
            return  # one claim per field per page: the server keeps only one
        record.fields.append(obs)


def count_field(stats: Stats, obs: FieldObs) -> None:
    if obs.value is None:
        stats.fields_missing += 1
        return
    inferred = obs.status == "inferred" or (
        obs.method == "llm" and obs.quote_check not in ("exact", "normalised")
    )
    if inferred:
        stats.fields_inferred += 1
    else:
        stats.fields_found += 1
    stats.by_field[obs.field] += 1


__all__ = [
    "EVIDENCE",
    "Fetched",
    "PartnerMention",
    "SiteRecords",
    "Stats",
    "Target",
    "TargetResult",
    "count_field",
    "fetch_info",
    "host_of",
    "when",
]
