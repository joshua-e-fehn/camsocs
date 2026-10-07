"""The persisted crosswalk: which identifiers belong to which organisation key.

Keys must not change between runs: a renamed society, or one whose SU id is
seen for the first time next to a Camdram slug seen last month, keeps the key
it was loaded under. The resolver therefore looks every identity up here
*first* (priority 1 of T4), and writes back what it resolved — so after a
resolve run the crosswalk knows every key there is, and later stages
(enrichment's counterparts) match against it with `Crosswalk.match`.

Two copies, merged at the start of each run:

- **local** — ``var/state/crosswalk.json`` (gitignored): every key this
  machine minted, with the identifiers it was minted for;
- **remote** — Convex, read through ``POST /api/pipeline/crosswalk``
  (`convex/ingest/orgInternal.ts` ``crosswalk``): every organisation row
  with its ``orgInternal`` source identifiers — what a fresh machine (or the
  VPS) starts from. Until that route is deployed the read answers 404 and the
  local copy is used alone.

**Identifier strings** (`identity.ident`): ``su:<id>``, ``su_slug:<slug>``,
``proctors:<folded name>``, ``sport:<slug>``, ``camdram:<id>``,
``camdram_slug:<slug>``, ``cucbc:<folded club>``, ``ref:<source_type>:<source_key>``
(one staged observation), ``ig:<handle>``, ``site:<identity>``. Names are
matched through the stored signatures (`names.py`).

**Decisions** (`Decisions`, ``pipeline/resolve-decisions.json``, committed):
what an operator decided about a quarantined match, by observation ref —
``same`` groups are merged whatever the rules say, ``distinct`` pairs are
never merged. The quarantine report (``var/reports/quarantine.json``) prints
the refs to copy.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from camsocs_pipeline.config import PIPELINE_DIR
from camsocs_pipeline.models.observation import IdentityHints
from camsocs_pipeline.models.wire import CrosswalkRow
from camsocs_pipeline.resolve.colleges import BY_ID as COLLEGES_BY_ID
from camsocs_pipeline.resolve.colleges import BY_KEY as COLLEGES_BY_KEY
from camsocs_pipeline.resolve.families import COUNTERPART_TYPES
from camsocs_pipeline.resolve.identity import (
    DISTINCT_KINDS,
    Identity,
    Profile,
    conflict,
    ident,
    identity_of,
)

logger = logging.getLogger(__name__)

#: Operator decisions, committed (see `Decisions`).
DECISIONS_PATH = PIPELINE_DIR / "resolve-decisions.json"


def var_dir(staging_dir: Path) -> Path:
    """The ``var/`` directory next to staging (``var/staging`` by default)."""
    return staging_dir.parent


def crosswalk_path(staging_dir: Path) -> Path:
    """``var/state/crosswalk.json`` — the local crosswalk cache (gitignored)."""
    return var_dir(staging_dir) / "state" / "crosswalk.json"


def quarantine_path(staging_dir: Path) -> Path:
    """``var/reports/quarantine.json`` — the latest resolve run's quarantine."""
    return var_dir(staging_dir) / "reports" / "quarantine.json"


class CrosswalkEntry(BaseModel):
    """What one key was minted for."""

    key: str
    name: str
    level: str | None = None
    #: Org-type family (`families.family_of`), None when no source said.
    family: str | None = None
    colleges: list[str] = Field(default_factory=list)
    #: Identifier strings (see module docstring).
    ids: list[str] = Field(default_factory=list)
    #: Name signatures (`names.NameParts.signature`).
    signatures: list[str] = Field(default_factory=list)
    is_counterpart: bool = False
    last_seen_run: str | None = None

    @property
    def profile(self) -> Profile:
        explicit = frozenset(
            identifier for identifier in self.ids if identifier.split(":", 1)[0] in DISTINCT_KINDS
        )
        return Profile(
            levels=frozenset({self.level} if self.level else ()),
            families=frozenset({self.family} if self.family else ()),
            college_sets=frozenset({frozenset(self.colleges)} if self.colleges else ()),
            explicit=explicit,
        )


@dataclass
class Match:
    """A lookup's answer: the key, how it was found, or the candidates that
    made it ambiguous."""

    key: str | None = None
    via: str | None = None
    candidates: list[str] = field(default_factory=list)


class Crosswalk:
    """The key ↔ identifier index (see module docstring)."""

    def __init__(self, entries: list[CrosswalkEntry] | None = None) -> None:
        self.entries: dict[str, CrosswalkEntry] = {}
        self._by_id: dict[str, set[str]] = {}
        self._by_signature: dict[str, set[str]] = {}
        for entry in entries or []:
            self.upsert(entry)

    # -- persistence -----------------------------------------------------------

    @classmethod
    def load(cls, path: Path) -> Crosswalk:
        if not path.exists():
            return cls()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return cls([CrosswalkEntry.model_validate(row) for row in raw.get("entries", [])])
        except (OSError, ValueError) as error:
            # Losing the cache costs a wider match, never a wrong one: Convex
            # still holds every key (merge_remote).
            logger.warning("Could not read %s (%s) — starting from an empty crosswalk", path, error)
            return cls()

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "saved_at": datetime.now(UTC).isoformat(),
            "entries": [
                self.entries[key].model_dump(exclude_none=True) for key in sorted(self.entries)
            ],
        }
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", "utf-8")
        temporary.replace(path)

    # -- index -------------------------------------------------------------------

    def upsert(self, entry: CrosswalkEntry) -> None:
        """Add or widen an entry: ids, signatures and colleges accumulate."""
        current = self.entries.get(entry.key)
        if current is not None:
            entry = CrosswalkEntry(
                key=entry.key,
                name=entry.name or current.name,
                level=entry.level or current.level,
                family=entry.family or current.family,
                colleges=sorted({*current.colleges, *entry.colleges}),
                ids=sorted({*current.ids, *entry.ids}),
                signatures=sorted({*current.signatures, *entry.signatures}),
                is_counterpart=entry.is_counterpart or current.is_counterpart,
                last_seen_run=entry.last_seen_run or current.last_seen_run,
            )
        self.entries[entry.key] = entry
        for identifier in entry.ids:
            self._by_id.setdefault(identifier, set()).add(entry.key)
        for signature in entry.signatures:
            self._by_signature.setdefault(signature, set()).add(entry.key)

    def keys_for(self, identifiers: frozenset[str] | set[str] | list[str]) -> set[str]:
        found: set[str] = set()
        for identifier in identifiers:
            found |= self._by_id.get(identifier, set())
        return found

    def keys_for_signatures(self, signatures: frozenset[str] | set[str]) -> set[str]:
        found: set[str] = set()
        for signature in signatures:
            found |= self._by_signature.get(signature, set())
        return found

    def __contains__(self, key: object) -> bool:
        return key in self.entries

    def __len__(self) -> int:
        return len(self.entries)

    # -- matching ----------------------------------------------------------------

    def compatible(self, key: str, profile: Profile) -> bool:
        return conflict(self.entries[key].profile, profile) is None

    def match(
        self,
        identity: Identity,
        *,
        refs: frozenset[str] = frozenset(),
        exclude: set[str] | frozenset[str] = frozenset(),
        names: bool = True,
    ) -> Match:
        """The one key `identity` belongs to, by priority: its own known key,
        a college's canonical key, explicit ids (and `refs`), Instagram /
        website, then name signature. Each step needs exactly one compatible
        candidate; several make the answer ambiguous (no key)."""
        if identity.known_key:
            return Match(identity.known_key, "known_key")
        if identity.college:
            return Match(COLLEGES_BY_ID[identity.college].key, "college")
        profile = Profile.of(identity)
        steps: list[tuple[str, set[str]]] = [
            ("explicit id", self.keys_for(identity.explicit | refs)),
            ("instagram/website", self.keys_for(identity.strong)),
        ]
        if names:
            steps.append(("name", self.keys_for_signatures(identity.signatures)))
        for via, keys in steps:
            candidates = sorted(
                key for key in keys - set(exclude) if key in self and self.compatible(key, profile)
            )
            if len(candidates) == 1:
                return Match(candidates[0], via)
            if len(candidates) > 1:
                return Match(None, via, candidates)
        return Match()

    def add_resolved(self, records: list[Any], *, run_key: str | None = None) -> int:
        """Register keyed organisation observations (a resolve stage's output),
        so a later stage of a dry run — which saves no crosswalk — still sees
        every key. Returns how many keys were new."""
        added = 0
        for record in records:
            key = getattr(record, "entity_key", None)
            if getattr(record, "entity_type", None) != "organisation" or not key:
                continue
            if key not in self.entries:
                added += 1
            identity = identity_of(record.identity.model_copy(update={"known_key": None}))
            self.upsert(
                CrosswalkEntry(
                    key=key,
                    name=identity.name,
                    level=identity.level,
                    family=identity.family,
                    colleges=sorted(identity.colleges),
                    ids=sorted(identity.ids),
                    signatures=sorted(identity.signatures),
                    is_counterpart=record.identity.org_type in COUNTERPART_TYPES,
                    last_seen_run=run_key,
                )
            )
        return added

    # -- the Convex copy -------------------------------------------------------

    def merge_remote(self, rows: list[CrosswalkRow]) -> int:
        """Merge the Convex crosswalk (`ConvexLoader.crosswalk`). Returns how
        many keys were new here."""
        added = 0
        for row in rows:
            if not row.org_key.startswith("org-") or not row.name:
                continue
            if row.org_key not in self.entries:
                added += 1
            colleges = [
                COLLEGES_BY_KEY[college].name
                for college in row.college_keys
                if college in COLLEGES_BY_KEY
            ]
            hints = IdentityHints(
                name=row.name,
                aliases=[*row.aliases, *([row.short_name] if row.short_name else [])],
                org_type=row.org_type,
                level=row.level,
                college_hint=colleges[0] if len(colleges) == 1 else None,
                su_id=_text(row.su_org_id),
                su_slug=_text(row.su_slug),
                proctors_name=_text(row.proctors_name),
                sport_slug=_text(row.sport_slug),
                camdram_id=row.camdram_id,
                camdram_slug=_text(row.camdram_slug),
                cucbc_club=_text(row.cucbc_club),
                instagram_handle=_text(row.instagram_handle),
                website_domain=_text(row.website_domain),
            )
            identity = identity_of(hints)
            self.upsert(
                CrosswalkEntry(
                    key=row.org_key,
                    name=identity.name,
                    level=identity.level,
                    family=identity.family,
                    colleges=sorted(identity.colleges),
                    ids=sorted(identity.ids),
                    signatures=sorted(identity.signatures),
                    is_counterpart=row.is_counterpart,
                )
            )
        return added


def _text(value: Any) -> str | None:
    return str(value) if value not in (None, "") else None


class Decisions(BaseModel):
    """Operator decisions on quarantined matches, by observation ref
    (``<source_type>:<source_key>``, as the quarantine report prints them)."""

    #: Each group is one organisation, whatever the matching rules say.
    same: list[list[str]] = Field(default_factory=list)
    #: Each pair is two organisations, whatever the matching rules say.
    distinct: list[list[str]] = Field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> Decisions:
        if not path.exists():
            return cls()
        return cls.model_validate_json(path.read_text(encoding="utf-8"))


__all__ = [
    "DECISIONS_PATH",
    "Crosswalk",
    "CrosswalkEntry",
    "Decisions",
    "Match",
    "crosswalk_path",
    "ident",
    "quarantine_path",
]
