"""Coverage of the staged data, offline: how many listed organisations have a
value for each field, and how many of those values are found rather than
inferred — the numbers a harvest is judged by, from `var/staging` alone (no
Convex read).

It reads what `load` would post — the latest file of every staging
directory's parts — and approximates the server's resolution (data-model
§1): a field has a value when any claim carries one; it is *found* when one
of those claims would be stored ``found`` (or ``manual`` / owner), by the
same rule (`claims.stored_status`). "Listed" means not a counterpart and
not defunct (the directory's default view).

``camsocs coverage`` prints it, with the size of the latest quarantine
(``var/reports/quarantine.json``).
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from camsocs_pipeline.claims import stored_status
from camsocs_pipeline.models.observation import Observation
from camsocs_pipeline.staging.store import StagingStore, is_events_directory

#: The fields reported, in order.
COVERAGE_FIELDS = (
    "orgType",
    "level",
    "collegeKeys",
    "categories",
    "activityTypes",
    "audiences",
    "languages",
    "tags",
    "shortDescription",
    "description",
    "howToJoin",
    "membership",
    "website",
    "email",
    "socials",
    "logo",
)
_FOUND = frozenset({"found", "manual", "owner_confirmed"})


@dataclass
class Coverage:
    organisations: int = 0
    counterparts: int = 0
    defunct: int = 0
    listed: int = 0
    #: Listed organisations with neither an orgType nor a level value.
    untyped: int = 0
    with_value: dict[str, int] = field(default_factory=dict)
    found: dict[str, int] = field(default_factory=dict)
    #: Listed organisations by orgType value ("-" for none).
    org_types: dict[str, int] = field(default_factory=dict)

    def share(self, name: str) -> float:
        return self.with_value.get(name, 0) / self.listed if self.listed else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "organisations": self.organisations,
            "counterparts": self.counterparts,
            "defunct": self.defunct,
            "listed": self.listed,
            "untyped": self.untyped,
            "with_value": self.with_value,
            "found": self.found,
            "org_types": self.org_types,
        }


def coverage(records: Iterable[object]) -> Coverage:
    """Coverage of the keyed organisation observations in `records`."""
    values: dict[str, dict[str, list[Any]]] = defaultdict(lambda: defaultdict(list))
    statuses: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for record in records:
        if (
            not isinstance(record, Observation)
            or record.entity_type != "organisation"
            or not record.entity_key
        ):
            continue
        org = record.entity_key
        values[org]  # every keyed organisation counts, even one with no value
        for obs in record.fields:
            if obs.value is None:
                continue
            values[org][obs.field].append(obs.value)
            statuses[org][obs.field].add(stored_status(obs))
    out = Coverage(organisations=len(values))
    with_value: dict[str, int] = defaultdict(int)
    found: dict[str, int] = defaultdict(int)
    org_types: dict[str, int] = defaultdict(int)
    for org, fields in values.items():
        if True in fields.get("isCounterpart", []):
            out.counterparts += 1
            continue
        if True in fields.get("defunct", []):
            out.defunct += 1
            continue
        out.listed += 1
        if not fields.get("orgType") and not fields.get("level"):
            out.untyped += 1
        types = sorted({v for v in fields.get("orgType", []) if isinstance(v, str)})
        org_types["/".join(types) or "-"] += 1
        for name in COVERAGE_FIELDS:
            if fields.get(name):
                with_value[name] += 1
                if statuses[org][name] & _FOUND:
                    found[name] += 1
    out.with_value = {name: with_value.get(name, 0) for name in COVERAGE_FIELDS}
    out.found = {name: found.get(name, 0) for name in COVERAGE_FIELDS}
    out.org_types = dict(sorted(org_types.items(), key=lambda item: (-item[1], item[0])))
    return out


def staged_coverage(staging: StagingStore) -> Coverage:
    """`coverage` of what `load` would post from `staging`."""
    return coverage(
        record
        for name in staging.directories()
        if not is_events_directory(name)
        for record in staging.read_latest(name)
    )


def quarantine_counts(path: Path) -> dict[str, int] | None:
    """``held`` / ``review`` / ``dropped_references`` of a quarantine report."""
    if not path.exists():
        return None
    report = json.loads(path.read_text(encoding="utf-8"))
    return {name: len(report.get(name) or []) for name in ("held", "review", "dropped_references")}


def format_coverage(current: Coverage, before: Coverage | None = None) -> list[str]:
    """A plain-text table; with `before`, the two side by side."""

    def cell(cov: Coverage, name: str) -> str:
        count = cov.with_value.get(name, 0)
        share = f"{cov.share(name):.0%}"
        return f"{count:>4} {share:>4} ({cov.found.get(name, 0)} found)"

    lines: list[str] = []
    header = f"{'':<18}"
    if before is not None:
        header += f"{'before':<26}"
    header += "now"
    lines.append(header)
    for label, attr in (
        ("listed", "listed"),
        ("counterparts", "counterparts"),
        ("defunct", "defunct"),
        ("no type or level", "untyped"),
    ):
        row = f"{label:<18}"
        if before is not None:
            row += f"{getattr(before, attr):<26}"
        lines.append(row + str(getattr(current, attr)))
    for name in COVERAGE_FIELDS:
        row = f"{name:<18}"
        if before is not None:
            row += f"{cell(before, name):<26}"
        lines.append(row + cell(current, name))
    return lines


__all__ = [
    "COVERAGE_FIELDS",
    "Coverage",
    "coverage",
    "format_coverage",
    "quarantine_counts",
    "staged_coverage",
]
