"""What the pipeline knows about one organisation, gathered for classifying it.

`profiles_from` folds every keyed organisation observation in staging (the
resolver's ``_resolved``, enrichment, Camdram, CUCBC, colleges — but never the
classify stage's own previous output) into one `OrgProfile` per key: its
records, the values sources already claim, its registrations, its names and
the texts a model may quote from.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from camsocs_pipeline.models.observation import FieldObs, Observation

#: Fields the classify stage fills (orgType, level and collegeKeys only for
#: registered societies; the rest for every listed organisation).
CLASSIFIED_FIELDS = (
    "orgType",
    "level",
    "collegeKeys",
    "categories",
    "activityTypes",
    "audiences",
    "languages",
    "tags",
)

#: Source types whose text is the organisation's own words, quotable as
#: evidence (an SU profile, a Camdram or Sport page), best first.
TEXT_SOURCES = ("su_profile", "camdram", "sport_club_page")
#: Records that only name the organisation (registers), best first.
NAME_SOURCES = ("su_directory", "proctors_register", "sport_az", "cucbc")
#: Text per record a model reads at most.
TEXT_LIMIT = 1_500


@dataclass
class OrgProfile:
    key: str
    records: list[Observation] = field(default_factory=list)
    #: field → (record, claim) for every claim with a value.
    values: dict[str, list[tuple[Observation, FieldObs]]] = field(
        default_factory=lambda: defaultdict(list)
    )

    # -- what sources say ------------------------------------------------------------

    def has(self, name: str) -> bool:
        """Whether any source claims a value for the field."""
        return bool(self.values.get(name))

    def first(self, name: str) -> Any:
        found = self.values.get(name)
        return found[0][1].value if found else None

    def all_values(self, name: str) -> list[Any]:
        return [obs.value for _record, obs in self.values.get(name, [])]

    @property
    def counterpart(self) -> bool:
        return True in self.all_values("isCounterpart")

    @property
    def defunct(self) -> bool:
        return True in self.all_values("defunct")

    def registered(self, register: str) -> bool:
        """``su``, ``proctors``, ``sportsService``, ``camdram``, ``cucbc``."""
        return any(
            isinstance(value, dict) and value.get("registered") is True
            for value in self.all_values(f"registrations.{register}")
        )

    def record(self, *source_types: str) -> Observation | None:
        """The first record of the first source type given that has one."""
        for source_type in source_types:
            for record in self.records:
                if record.source_type == source_type:
                    return record
        return None

    @property
    def name(self) -> str:
        best = self.record(*NAME_SOURCES, *TEXT_SOURCES)
        return (best or self.records[0]).identity.name

    @property
    def names(self) -> list[str]:
        """Every name sources give, best source first, without repeats."""
        ordered = sorted(self.records, key=lambda r: _rank(r.source_type))
        out: list[str] = []
        for record in ordered:
            for value in [record.identity.name, *record.identity.aliases]:
                if value and value not in out:
                    out.append(value)
        for value in self.all_values("name") + self.all_values("shortName"):
            if isinstance(value, str) and value not in out:
                out.append(value)
        return out

    @property
    def su_category(self) -> str | None:
        value = self.first("suCategory")
        return value if isinstance(value, str) else None

    @property
    def org_types(self) -> set[str]:
        return {v for v in self.all_values("orgType") if isinstance(v, str)}

    # -- what a model may read --------------------------------------------------------

    def texts(self) -> list[tuple[Observation, str]]:
        """``(record, text)`` a model may quote: a page's name and the
        descriptions it publishes (as harvested, CRSids and invites already
        withheld), then the registers' names. Never a value a model wrote."""
        out: list[tuple[Observation, str]] = []
        for source_type in TEXT_SOURCES:
            record = self.record(source_type)
            if record is None:
                continue
            parts = [record.identity.name]
            for obs in record.fields:
                if (
                    obs.field in ("shortDescription", "description")
                    and obs.method == "parser"
                    and isinstance(obs.value, str)
                ):
                    parts.append(obs.value)
            text = "\n".join(dict.fromkeys(part.strip() for part in parts if part.strip()))
            if len(parts) > 1:
                out.append((record, text[:TEXT_LIMIT]))
        for source_type in NAME_SOURCES:
            record = self.record(source_type)
            if record is not None and all(record is not r for r, _ in out):
                out.append((record, record.identity.name))
        return out


def _rank(source_type: str) -> int:
    order = (*NAME_SOURCES, *TEXT_SOURCES)
    return order.index(source_type) if source_type in order else len(order)


def profiles_from(records: Iterable[object]) -> dict[str, OrgProfile]:
    """One profile per keyed organisation (module docstring)."""
    profiles: dict[str, OrgProfile] = {}
    for record in records:
        if (
            not isinstance(record, Observation)
            or record.entity_type != "organisation"
            or not record.entity_key
        ):
            continue
        profile = profiles.setdefault(record.entity_key, OrgProfile(record.entity_key))
        profile.records.append(record)
        for obs in record.fields:
            if obs.value is not None:
                profile.values[obs.field].append((record, obs))
    return profiles


__all__ = [
    "CLASSIFIED_FIELDS",
    "NAME_SOURCES",
    "TEXT_SOURCES",
    "OrgProfile",
    "profiles_from",
]
