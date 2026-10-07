"""Identity resolution (T4): unkeyed staged observations → keyed ones.

Every harvester describes the groups it sees with `IdentityHints` and never
mints an organisation key. This module decides which observations are the
same organisation, gives each organisation one stable key, and keys
everything that refers to one (a team's club, a relationship's other end, an
event's organisers).

## Matching, in priority order

Observations of organisations ("anchors") are merged by union-find, one tier
at a time:

0. operator decisions (`crosswalk.Decisions.same`);
1. the **persisted crosswalk**: an anchor whose explicit source id or staged
   ref (``ref:<source_type>:<source_key>``) was keyed before keeps that key —
   as does a college, under its canonical key (`colleges.py`);
2. the **SU id** / SU slug; then the other source ids (a Sport slug seen on
   the A–Z and on the club page);
3. the **Instagram handle** (the dedup key at University level, LB §8.1);
4. the **website** (site identity, `names.site_identity`; an own email domain counts);
5. the **normalised name** (`names.py` signatures: qualifiers stripped, "(CU)"
   handled, known aliases, college inside the signature) within compatible
   level and college.

A merge is refused (`identity.conflict`) across type families, levels or
colleges, and between two entries one source lists separately (two SU ids,
three Sport "Lacrosse" slugs). Refusals are what the **quarantine** is for:

- a strong or same-name link refused over level or college: the weaker group
  (no key yet / lower source priority) is **held** — not written, so it is not
  loaded — until an operator decides (``pipeline/resolve-decisions.json``)
  or the sources agree; this is how a college boat club is never merged into
  CUBC and a club on two college lists never becomes one row by itself;
- two separately listed entries sharing an Instagram or a name, two
  already-loaded keys that now look alike, a club with the same name on
  several college lists: **review** (both kept);
- a reference (relationship target, event organiser, team's parent) that
  matches nothing: **dropped** from the resolved copy (a team is held), and
  retried next run. A reference to a *counterpart* (a college, a company, a
  department; `families.COUNTERPART_TYPES`) creates that counterpart instead.

The report is written each run to ``var/reports/quarantine.json`` by the
stage; everything is retried each run because resolve re-reads all staging.

## Keys

A group keeps its crosswalk key; otherwise the crosswalk is consulted once
more by Instagram, website and name; otherwise a key is minted with
`keys.org_key` from the best-ranked member's name (`SOURCE_PRIORITY`),
prefixed with its college for a college-level group whose name lacks it
("Boat Club" on Jesus's list → ``org-jesus-college-boat-club``). A minted key
that is taken (this run, or by another group in the crosswalk) gets a suffix:
level, then a source id, then a number. The crosswalk then records the key
with every identifier of its members, which is what keeps it stable.

## Derived claims (added to the resolved copies)

- ``collegeKeys`` from a harvester's ``college_hint``, once the college has a
  key (its anchor exists this run or in the crosswalk);
- ``categories: ["sport"]`` for an observation stating a Sports Service
  registration (data-model §5: "a deterministic rule assigns `sport` to
  sportsService-registered clubs").
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.keys import org_key, session_key, slugify, team_key, venue_key
from camsocs_pipeline.models.observation import (
    EventObservation,
    FieldObs,
    IdentityHints,
    Observation,
)
from camsocs_pipeline.resolve.colleges import BY_ID as COLLEGES_BY_ID
from camsocs_pipeline.resolve.crosswalk import Crosswalk, CrosswalkEntry, Decisions
from camsocs_pipeline.resolve.families import COUNTERPART_TYPES, default_level
from camsocs_pipeline.resolve.identity import (
    DISTINCT_KINDS,
    Identity,
    Profile,
    conflict,
    ident,
    identity_of,
)
from camsocs_pipeline.resolve.names import fold, name_parts

Record = Observation | EventObservation

#: Which source names a group best (lower is better) — decides the key's
#: name and which side is held when two must not merge. `manual` is an
#: operator's own statement.
SOURCE_PRIORITY: dict[str, int] = {
    "manual": 0,
    "su_profile": 1,
    "su_directory": 2,
    "proctors_register": 3,
    "sport_az": 4,
    "sport_club_page": 5,
    "sport_guide_pdf": 6,
    "camdram": 7,
    "cucbc": 8,
    "college_list": 9,
    "society_website": 10,
    "linktree": 11,
}
DEFAULT_PRIORITY = 20

#: At most this many review items of the "similar name" kind per run.
MAX_SIMILAR = 200

#: Tokens that say what a group does, not which one it is: a name made only of
#: these on several college lists is that college's own club, not a shared one.
_GENERIC_WORDS = """
boat rowing football association rugby hockey cricket netball tennis squash badminton
basketball volleyball swimming athletics cycling golf lacrosse ultimate frisbee pool darts
chess music musical choir chapel orchestra jazz band drama dramatic players film art arts
book christian union debating history law medical science politics economics mathematical
maths men women mixed first second team rfc afc fc bc jcr mcr ents may ball students
"""
GENERIC_TOKENS = frozenset(_GENERIC_WORDS.split())


# --- the report ------------------------------------------------------------------------


class QuarantineItem(BaseModel):
    kind: Literal["held", "dropped_reference", "review"]
    reason: str
    #: Observation refs (``<source_type>:<source_key>``), as `Decisions` takes them.
    refs: list[str] = Field(default_factory=list)
    names: list[str] = Field(default_factory=list)
    keys: list[str] = Field(default_factory=list)
    detail: str | None = None


class QuarantineReport(BaseModel):
    run_key: str | None = None
    generated_at: str
    counts: dict[str, int] = Field(default_factory=dict)
    held: list[QuarantineItem] = Field(default_factory=list)
    dropped_references: list[QuarantineItem] = Field(default_factory=list)
    review: list[QuarantineItem] = Field(default_factory=list)


@dataclass
class Resolution:
    """What `Resolver.run` produced."""

    #: Keyed copies (counterparts first, then organisations, then the rest).
    records: list[Record]
    crosswalk: Crosswalk
    report: QuarantineReport
    #: Unkeyed records that were held back, by ref (not written).
    held_refs: set[str] = field(default_factory=set)


# --- internals ---------------------------------------------------------------------------


def ref_of(record: Record) -> str:
    return f"{record.source_type}:{record.source_key}"


def priority_of(record: Record) -> int:
    return SOURCE_PRIORITY.get(record.source_type, DEFAULT_PRIORITY)


def _values(record: Observation, name: str) -> list[Any]:
    return [obs.value for obs in record.fields if obs.field == name and obs.value is not None]


def observation_identity(record: Observation) -> Identity:
    """`identity_of` for an organisation observation, with what its own fields
    say about the group: website, a single Instagram, aliases and short name."""
    websites = [value for value in _values(record, "website") if isinstance(value, str)]
    instagram = [
        item["url"]
        for value in _values(record, "socials")
        if isinstance(value, list)
        for item in value
        if isinstance(item, dict) and item.get("platform") == "instagram" and item.get("url")
    ]
    if len(instagram) > 1:
        # Several Instagram accounts listed: none is certainly the group's own.
        instagram = []
    extra = [
        alias
        for value in _values(record, "aliases")
        for alias in (value if isinstance(value, list) else [])
        if isinstance(alias, str)
    ]
    extra += [value for value in _values(record, "shortName") if isinstance(value, str)]
    hints = record.identity
    if extra:
        hints = hints.model_copy(update={"aliases": [*hints.aliases, *extra]})
    return identity_of(hints, websites=websites, instagram=instagram)


@dataclass
class _Anchor:
    index: int
    record: Observation
    ref: str
    priority: int
    identity: Identity


@dataclass
class _Group:
    members: list[int]
    keys: set[str]
    profile: Profile
    refs: set[str]
    #: (priority, ref) of the best-ranked member.
    rank: tuple[int, str]


@dataclass
class _Conflict:
    tier: str
    value: str
    a: int
    b: int
    category: str
    reason: str


def _evidence_of(fields: Iterable[FieldObs]) -> str:
    return "primary" if any(f.evidence == "primary" for f in fields) else "secondary"


class Resolver:
    """One resolution run over staged records. See the module docstring."""

    def __init__(
        self,
        crosswalk: Crosswalk,
        decisions: Decisions | None = None,
        *,
        run_key: str | None = None,
    ) -> None:
        self.crosswalk = crosswalk
        self.decisions = decisions or Decisions()
        self.run_key = run_key
        self.anchors: list[_Anchor] = []
        self._parent: list[int] = []
        self._groups: dict[int, _Group] = {}
        self._conflicts: list[_Conflict] = []
        self._held: dict[int, QuarantineItem] = {}
        self._key_of: dict[int, str] = {}
        self._taken: dict[str, int] = {}
        self._counterparts: list[Observation] = []
        self._counterpart_keys: set[str] = set()
        self._venues: dict[str, str] = {}
        self._held_roots: dict[int, QuarantineItem] = {}
        self.report = QuarantineReport(run_key=run_key, generated_at=datetime.now(UTC).isoformat())
        self.counts: dict[str, int] = defaultdict(int)
        distinct = {frozenset(pair) for pair in self.decisions.distinct if len(pair) == 2}
        self._distinct_pairs = distinct

    # -- public ------------------------------------------------------------------

    def run(self, records: Iterable[Record]) -> Resolution:
        pending: list[Record] = []
        for record in records:
            if isinstance(record, Observation) and record.entity_key is not None:
                self.counts["already_keyed"] += 1
                continue
            if isinstance(record, EventObservation) and record.is_keyed:
                # Loaded from its own directory as it is; a second, keyed copy
                # here would post the event twice (its venue stays text).
                self.counts["already_keyed"] += 1
                continue
            pending.append(record)

        organisations = [
            r for r in pending if isinstance(r, Observation) and r.entity_type == "organisation"
        ]
        self._build_anchors(organisations)
        self._link()
        self._decide_holds()
        self._assign_keys()
        self._record_crosswalk()

        keyed_orgs = self._keyed_anchors()
        venues = self._resolve_venues(
            [r for r in pending if isinstance(r, Observation) and r.entity_type == "venue"]
        )
        others: list[Record] = []
        for record in pending:
            if isinstance(record, EventObservation):
                others.append(self._keyed_event(record))
            elif record.entity_type in ("team", "session"):
                child = self._keyed_child(record)
                if child is not None:
                    others.append(child)
        for record in keyed_orgs:
            self._key_relationships(record)

        self._review_shared_clubs()
        self._review_similar_names()
        self._finish_counts()
        held_refs = {ref for item in self.report.held for ref in item.refs}
        return Resolution(
            records=[*self.take_counterparts(), *keyed_orgs, *venues, *others],
            crosswalk=self.crosswalk,
            report=self.report,
            held_refs=held_refs,
        )

    # -- anchors and union-find -------------------------------------------------

    def _build_anchors(self, records: list[Observation]) -> None:
        ordered = sorted(records, key=lambda r: (priority_of(r), ref_of(r)))
        for index, record in enumerate(ordered):
            identity = observation_identity(record)
            anchor = _Anchor(index, record, ref_of(record), priority_of(record), identity)
            self.anchors.append(anchor)
            self._parent.append(index)
            self._groups[index] = _Group(
                members=[index],
                keys=set(),
                profile=Profile.of(identity),
                refs={anchor.ref},
                rank=(anchor.priority, anchor.ref),
            )

    def _find(self, index: int) -> int:
        while self._parent[index] != index:
            self._parent[index] = self._parent[self._parent[index]]
            index = self._parent[index]
        return index

    def _problem(self, a: _Group, b: _Group) -> tuple[str, str] | None:
        for ref_a in a.refs:
            for ref_b in b.refs:
                if frozenset((ref_a, ref_b)) in self._distinct_pairs:
                    return "decision", "operator decided these are distinct"
        if a.keys and b.keys and a.keys != b.keys:
            return "keys", f"already loaded as {', '.join(sorted(a.keys | b.keys))}"
        return conflict(a.profile, b.profile)

    def _union(self, a: int, b: int, tier: str, value: str, *, override: bool = False) -> bool:
        root_a, root_b = self._find(a), self._find(b)
        if root_a == root_b:
            return True
        group_a, group_b = self._groups[root_a], self._groups[root_b]
        if not override:
            problem = self._problem(group_a, group_b)
            if problem is not None:
                self._conflicts.append(_Conflict(tier, value, a, b, *problem))
                return False
        if len(group_a.members) < len(group_b.members):
            root_a, root_b = root_b, root_a
            group_a, group_b = group_b, group_a
        self._parent[root_b] = root_a
        group_a.members += group_b.members
        group_a.keys |= group_b.keys
        group_a.profile = group_a.profile.merged(group_b.profile)
        group_a.refs |= group_b.refs
        group_a.rank = min(group_a.rank, group_b.rank)
        del self._groups[root_b]
        return True

    def _link_tier(self, tier: str, values_of) -> None:
        index: dict[str, list[int]] = defaultdict(list)
        for anchor in self.anchors:
            if anchor.index in self._held:
                continue
            for value in values_of(anchor):
                index[value].append(anchor.index)
        for value in sorted(index):
            members = index[value]
            first = members[0]
            for other in members[1:]:
                if self._union(first, other, tier, value):
                    self.counts[f"merged_by_{tier}"] += 1

    def _link(self) -> None:
        by_ref = {anchor.ref: anchor.index for anchor in self.anchors}
        # 0. Operator decisions.
        for group in self.decisions.same:
            members = [by_ref[ref] for ref in group if ref in by_ref]
            for other in members[1:]:
                self._union(members[0], other, "decision", "same", override=True)

        # 1. The persisted crosswalk (and canonical college keys, known keys).
        for anchor in self.anchors:
            identity = anchor.identity
            keys: set[str] = set()
            if identity.known_key:
                keys.add(identity.known_key)
            if identity.college:
                keys.add(COLLEGES_BY_ID[identity.college].key)
            keys |= self.crosswalk.keys_for(identity.explicit | {ident("ref", anchor.ref)})
            if len(keys) > 1 and not identity.known_key and not identity.college:
                self._held[anchor.index] = QuarantineItem(
                    kind="held",
                    reason="identifiers belong to different known organisations",
                    refs=[anchor.ref],
                    names=[identity.name],
                    keys=sorted(keys),
                )
                continue
            if identity.known_key:
                keys = {identity.known_key}
            elif identity.college:
                keys = {COLLEGES_BY_ID[identity.college].key}
            self._groups[self._find(anchor.index)].keys |= keys
        self._link_tier("crosswalk", lambda a: sorted(self._groups[self._find(a.index)].keys))

        # 2–5. Source ids, Instagram, website, name.
        su_kinds = ("su", "su_slug")
        other_kinds = tuple(kind for kind in DISTINCT_KINDS if kind not in su_kinds)
        self._link_tier(
            "su_id",
            lambda a: sorted(v for kind in su_kinds for v in a.identity.explicit_of(kind)),
        )
        self._link_tier(
            "source_id",
            lambda a: sorted(v for kind in other_kinds for v in a.identity.explicit_of(kind)),
        )
        self._link_tier(
            "instagram", lambda a: sorted(v for v in a.identity.strong if v.startswith("ig:"))
        )
        self._link_tier(
            "website", lambda a: sorted(v for v in a.identity.strong if v.startswith("site:"))
        )
        self._link_tier("name", lambda a: sorted(a.identity.signatures))

    # -- holds -----------------------------------------------------------------------

    def _group_names(self, group: _Group) -> list[str]:
        return sorted({self.anchors[i].identity.name for i in group.members})

    def _decide_holds(self) -> None:
        held_roots: dict[int, QuarantineItem] = {}
        for item_index, item in list(self._held.items()):
            held_roots[self._find(item_index)] = item
        for found in self._conflicts:
            if found.category in ("family", "decision"):
                continue
            root_a, root_b = self._find(found.a), self._find(found.b)
            if root_a == root_b or root_a in held_roots or root_b in held_roots:
                continue
            group_a, group_b = self._groups[root_a], self._groups[root_b]
            detail = f"{found.tier} match on {found.value}"
            if found.category in ("distinct", "keys") or (group_a.keys and group_b.keys):
                self.report.review.append(
                    QuarantineItem(
                        kind="review",
                        reason=f"kept apart: {found.reason}",
                        refs=sorted(group_a.refs | group_b.refs),
                        names=sorted({*self._group_names(group_a), *self._group_names(group_b)}),
                        keys=sorted(group_a.keys | group_b.keys),
                        detail=detail,
                    )
                )
                continue
            # level / college: hold the weaker side until someone decides.
            if group_a.keys and not group_b.keys:
                loser, winner = root_b, root_a
            elif group_b.keys and not group_a.keys:
                loser, winner = root_a, root_b
            else:
                loser, winner = (
                    (root_b, root_a) if group_a.rank <= group_b.rank else (root_a, root_b)
                )
            held_roots[loser] = QuarantineItem(
                kind="held",
                reason=f"looks like another organisation but {found.reason}",
                refs=sorted(self._groups[loser].refs),
                names=self._group_names(self._groups[loser]),
                keys=sorted(self._groups[winner].keys),
                detail=(
                    f"{detail}; kept: {', '.join(self._group_names(self._groups[winner]))} "
                    f"({', '.join(sorted(self._groups[winner].refs))}). Decide in "
                    "pipeline/resolve-decisions.json (same / distinct)."
                ),
            )
        self._held_roots = held_roots
        self.report.held.extend(held_roots.values())

    # -- keys ------------------------------------------------------------------------

    def _live_roots(self) -> list[int]:
        roots = [root for root in self._groups if root not in self._held_roots]
        return sorted(roots, key=lambda r: (not self._groups[r].keys, self._groups[r].rank))

    def _soft_match(self, group: _Group) -> tuple[str | None, list[str]]:
        """A key from the crosswalk for a group none of whose explicit ids is
        known: by Instagram / website, then name."""
        strong = {v for i in group.members for v in self.anchors[i].identity.strong}
        signatures = {v for i in group.members for v in self.anchors[i].identity.signatures}
        for candidates in (
            self.crosswalk.keys_for(strong),
            self.crosswalk.keys_for_signatures(signatures),
        ):
            usable = sorted(
                key
                for key in candidates
                if key not in self._taken and self.crosswalk.compatible(key, group.profile)
            )
            if len(usable) == 1:
                return usable[0], []
            if len(usable) > 1:
                return None, usable
        return None, []

    def _best(self, group: _Group) -> _Anchor:
        return min((self.anchors[i] for i in group.members), key=lambda a: (a.priority, a.ref))

    def _qualified_name(self, group: _Group, anchor: _Anchor) -> str:
        """The best member's name, with its college in front when the group
        belongs to exactly one college and the name does not say which."""
        name = anchor.identity.name
        college_sets = group.profile.college_sets
        hinted = {a.identity.hint_college for a in map(self.anchors.__getitem__, group.members)}
        hinted.discard(None)
        if len(college_sets) == 1 and hinted:
            (colleges,) = college_sets
            if len(colleges) == 1:
                (college,) = colleges
                if college not in name_parts(name).colleges:
                    return f"{COLLEGES_BY_ID[college].name} {name}"
        return name

    def _mint(self, base_names: list[str], suffixes: list[str]) -> str | None:
        bases: list[str] = []
        for name in base_names:
            try:
                bases.append(org_key(name))
            except ValueError:
                continue
        if not bases:
            return None
        candidates = [*bases]
        for suffix in suffixes:
            try:
                candidates.append(f"{bases[0]}-{slugify(suffix)}")
            except ValueError:
                continue
        candidates += [f"{bases[0]}-{number}" for number in range(2, 10)]
        for candidate in candidates:
            if candidate not in self._taken and candidate not in self.crosswalk:
                return candidate
        return None

    def _assign_keys(self) -> None:
        for root in self._live_roots():
            group = self._groups[root]
            key: str | None = None
            if group.keys:
                key = sorted(group.keys)[0]
                if len(group.keys) > 1:
                    self.report.review.append(
                        QuarantineItem(
                            kind="review",
                            reason="merged by decision; these keys are now one organisation",
                            refs=sorted(group.refs),
                            names=self._group_names(group),
                            keys=sorted(group.keys),
                            detail=f"kept {key}; remove the others with ingest/purge:removeEntity",
                        )
                    )
                if key in self._taken:
                    self._hold_group(root, f"its key {key} is used by another group this run")
                    continue
                self.counts["keys_kept"] += 1
            else:
                key, candidates = self._soft_match(group)
                if key is not None:
                    self.counts["keys_kept"] += 1
                else:
                    best = self._best(group)
                    names = [self._qualified_name(group, best), best.identity.name]
                    names += [self.anchors[i].identity.name for i in group.members]
                    suffixes = [*sorted(group.profile.levels)]
                    suffixes += [value.split(":", 1)[1] for value in sorted(best.identity.explicit)]
                    key = self._mint(names, suffixes)
                    if key is None:
                        self._hold_group(root, "no usable key could be minted from its names")
                        continue
                    self.counts["keys_minted"] += 1
                    if candidates:
                        self.report.review.append(
                            QuarantineItem(
                                kind="review",
                                reason="new key minted, but known organisations look alike",
                                refs=sorted(group.refs),
                                names=self._group_names(group),
                                keys=[key, *candidates],
                            )
                        )
                    elif org_key_safe(best.identity.name) in self.crosswalk and key != (
                        org_key_safe(best.identity.name)
                    ):
                        self.report.review.append(
                            QuarantineItem(
                                kind="review",
                                reason="its name's key belongs to another known organisation",
                                refs=sorted(group.refs),
                                names=self._group_names(group),
                                keys=[key, org_key_safe(best.identity.name) or ""],
                            )
                        )
            self._taken[key] = root
            for member in group.members:
                self._key_of[member] = key

    def _hold_group(self, root: int, reason: str) -> None:
        group = self._groups[root]
        item = QuarantineItem(
            kind="held",
            reason=reason,
            refs=sorted(group.refs),
            names=self._group_names(group),
            keys=sorted(group.keys),
        )
        self._held_roots[root] = item
        self.report.held.append(item)

    def _record_crosswalk(self) -> None:
        for key, root in self._taken.items():
            group = self._groups[root]
            members = [self.anchors[i] for i in group.members]
            best = self._best(group)
            colleges: set[str] = set()
            if len(group.profile.college_sets) == 1:
                (colleges_set,) = group.profile.college_sets
                colleges = set(colleges_set)
            levels = sorted(group.profile.levels)
            families = sorted(group.profile.families)
            self.crosswalk.upsert(
                CrosswalkEntry(
                    key=key,
                    name=best.identity.name,
                    level=levels[0] if len(levels) == 1 else None,
                    family=families[0] if len(families) == 1 else None,
                    colleges=sorted(colleges),
                    ids=sorted(
                        {
                            *(v for a in members for v in a.identity.ids),
                            *(ident("ref", a.ref) for a in members),
                        }
                    ),
                    signatures=sorted({s for a in members for s in a.identity.signatures}),
                    is_counterpart=any(
                        a.record.identity.org_type in COUNTERPART_TYPES for a in members
                    ),
                    last_seen_run=self.run_key,
                )
            )

    # -- keyed copies --------------------------------------------------------------

    def _keyed_anchors(self) -> list[Observation]:
        out: list[Observation] = []
        for anchor in self.anchors:
            key = self._key_of.get(anchor.index)
            if key is None:
                continue
            record = anchor.record.model_copy(deep=True)
            record.entity_key = key
            record.identity.known_key = key
            record.fields.extend(self._derived_claims(anchor, key))
            out.append(record)
            self.counts["organisations"] += 1
        return out

    def _college_key(self, college_id: str | None) -> str | None:
        if college_id is None:
            return None
        key = COLLEGES_BY_ID[college_id].key
        return key if key in self._taken or key in self.crosswalk else None

    def _derived_claims(self, anchor: _Anchor, key: str) -> list[FieldObs]:
        record = anchor.record
        present = {obs.field for obs in record.fields}
        evidence = _evidence_of(record.fields)
        derived: list[FieldObs] = []
        if anchor.identity.hint_college and "collegeKeys" not in present:
            college_key = self._college_key(anchor.identity.hint_college)
            if college_key and college_key != key:
                derived.append(
                    parser_field(
                        "collegeKeys",
                        [college_key],
                        extractor="resolve.college_hint",
                        evidence=evidence,
                        value_raw=record.identity.college_hint,
                    )
                )
                self.counts["college_keys"] += 1
            elif college_key is None:
                self.counts["college_keys_waiting"] += 1
        if "categories" not in present:
            for obs in record.fields:
                if (
                    obs.field == "registrations.sportsService"
                    and isinstance(obs.value, dict)
                    and obs.value.get("registered") is True
                ):
                    derived.append(
                        parser_field(
                            "categories",
                            ["sport"],
                            extractor="rule.sports_service_category",
                            evidence=obs.evidence,
                        )
                    )
                    self.counts["sport_category_rule"] += 1
                    break
        return derived

    # -- references ------------------------------------------------------------------

    def reference_key(self, hints: IdentityHints, referrer: Record | None) -> str | None:
        """The key of the organisation `hints` refer to, looked up in the
        crosswalk (complete after `run`). A counterpart (`COUNTERPART_TYPES`,
        or a college) that is not known yet is created from `referrer`'s
        page (`take_counterparts`). None when unknown or ambiguous."""
        if hints.known_key:
            return hints.known_key
        identity = identity_of(hints)
        if identity.college:
            key = COLLEGES_BY_ID[identity.college].key
            if key in self.crosswalk or key in self._taken:
                return key
            return self._create_counterpart(hints, identity, referrer, key)
        found = self.crosswalk.match(identity)
        if found.key is not None:
            return found.key
        if not found.candidates and hints.org_type in COUNTERPART_TYPES:
            return self._create_counterpart(hints, identity, referrer, None)
        return None

    def take_counterparts(self) -> list[Observation]:
        """Counterpart observations created since the last call."""
        created, self._counterparts = self._counterparts, []
        return created

    def _create_counterpart(
        self,
        hints: IdentityHints,
        identity: Identity,
        referrer: Record | None,
        key: str | None,
    ) -> str | None:
        if referrer is None:
            return None
        org_type = hints.org_type or ("college" if identity.college else None)
        name = COLLEGES_BY_ID[identity.college].name if identity.college else hints.name
        if key is None:
            key = self._mint([name], [org_type or ""])
            if key is None:
                return None
        if key in self._counterpart_keys:
            return key
        self._counterpart_keys.add(key)
        self._taken.setdefault(key, -1)
        level = hints.level or (default_level(org_type) if org_type else None)
        # What another organisation's page says about this one: secondary.
        values: dict[str, Any] = {"name": name, "isCounterpart": True}
        if org_type:
            values["orgType"] = org_type
        if level:
            values["level"] = level
        fields = [
            parser_field(field, value, extractor="resolve.counterpart", evidence="secondary")
            for field, value in values.items()
        ]
        counterpart = Observation(
            source_type=referrer.source_type,
            source_key=f"{referrer.source_key}#{key}",
            source_url=referrer.source_url,
            retrieved_at=referrer.retrieved_at,
            content_sha256=referrer.content_sha256,
            entity_type="organisation",
            identity=hints.model_copy(update={"known_key": key, "name": name}),
            entity_key=key,
            fields=fields,
        )
        self._counterparts.append(counterpart)
        self.crosswalk.upsert(
            CrosswalkEntry(
                key=key,
                name=name,
                level=level,
                family=identity.family or ("college" if identity.college else None),
                colleges=sorted(identity.colleges),
                ids=sorted(identity.ids),
                signatures=sorted(identity.signatures),
                is_counterpart=True,
                last_seen_run=self.run_key,
            )
        )
        self.counts["counterparts_created"] += 1
        return key

    def _drop(self, referrer: Record, hints: IdentityHints, what: str) -> None:
        self.report.dropped_references.append(
            QuarantineItem(
                kind="dropped_reference",
                reason=f"{what} matches no known organisation (or several)",
                refs=[ref_of(referrer)],
                names=[hints.name],
            )
        )
        self.counts["references_dropped"] += 1

    def _key_relationships(self, record: Observation) -> None:
        kept = []
        for relationship in record.relationships:
            key = self.reference_key(relationship.to_identity, record)
            if key is None or key == record.entity_key:
                self._drop(record, relationship.to_identity, f"{relationship.type} target")
                continue
            relationship.to_identity.known_key = key
            kept.append(relationship)
        record.relationships = kept

    def _keyed_child(self, record: Observation) -> Observation | None:
        assert record.parent is not None  # Observation validates it
        parent_key = self.reference_key(record.parent, record)
        if parent_key is None:
            self.report.held.append(
                QuarantineItem(
                    kind="held",
                    reason=f"the {record.entity_type}'s organisation matches no known organisation",
                    refs=[ref_of(record)],
                    names=[record.parent.name, record.identity.name],
                )
            )
            self.counts["children_held"] += 1
            return None
        copy = record.model_copy(deep=True)
        copy.parent.known_key = parent_key  # type: ignore[union-attr]
        values = {obs.field: obs.value for obs in record.fields if obs.value is not None}
        try:
            if record.entity_type == "team":
                key = team_key(parent_key, str(values.get("name") or record.identity.name))
            else:
                day = values.get("dayOfWeek")
                key = session_key(
                    parent_key,
                    str(values.get("title") or record.identity.name),
                    day if isinstance(day, int) else None,
                    values.get("startTime") if isinstance(values.get("startTime"), str) else None,
                )
        except ValueError as error:
            self.report.held.append(
                QuarantineItem(
                    kind="held", reason=f"no key: {error}", refs=[ref_of(record)], names=[]
                )
            )
            return None
        copy.entity_key = key
        copy.identity.known_key = key
        self.counts[f"{record.entity_type}s"] += 1
        return copy

    def _resolve_venues(self, records: list[Observation]) -> list[Observation]:
        out: list[Observation] = []
        ordered = sorted(records, key=lambda r: (priority_of(r), ref_of(r)))
        for record in ordered:
            names = [record.identity.name, *record.identity.aliases]
            key = next(
                (self._venues[fold(name)] for name in names if fold(name) in self._venues), None
            )
            if key is None:
                try:
                    key = venue_key(record.identity.name)
                except ValueError:
                    continue
            for name in names:
                self._venues.setdefault(fold(name), key)
            copy = record.model_copy(deep=True)
            copy.entity_key = key
            copy.identity.known_key = key
            out.append(copy)
            self.counts["venues"] += 1
        return out

    def _keyed_event(self, record: EventObservation) -> EventObservation:
        copy = record.model_copy(deep=True)
        kept = []
        for organiser in copy.organisers:
            key = self.reference_key(organiser.identity, record)
            if key is None:
                self._drop(record, organiser.identity, f"event {organiser.role}")
                continue
            organiser.identity.known_key = key
            kept.append(organiser)
        copy.organisers = kept
        if copy.venue is not None and copy.venue.known_key is None:
            names = [copy.venue.name, *copy.venue.aliases]
            copy.venue.known_key = next(
                (self._venues[fold(name)] for name in names if fold(name) in self._venues), None
            )
        self.counts["events"] += 1
        return copy

    # -- review hints ---------------------------------------------------------------

    def _review_shared_clubs(self) -> None:
        """The same distinctive name on several colleges' lists: probably one
        club shared between them (LB §1.5) — kept apart until decided."""
        by_core: dict[str, dict[str, list[_Anchor]]] = defaultdict(lambda: defaultdict(list))
        for anchor in self.anchors:
            if anchor.index not in self._key_of or not anchor.identity.hint_college:
                continue
            core = anchor.identity.core_signature
            if core and set(core.split()) - GENERIC_TOKENS:
                by_core[core][anchor.identity.hint_college].append(anchor)
        for core, colleges in sorted(by_core.items()):
            if 2 <= len(colleges) <= 6:
                members = [a for group in colleges.values() for a in group]
                self.report.review.append(
                    QuarantineItem(
                        kind="review",
                        reason="same name on several colleges' lists: one shared club?",
                        refs=sorted(a.ref for a in members),
                        names=sorted({a.identity.name for a in members}),
                        keys=sorted({self._key_of[a.index] for a in members}),
                        detail=(
                            f"{core!r} at {', '.join(sorted(colleges))}; if one club, add the "
                            "refs as a 'same' group to pipeline/resolve-decisions.json"
                        ),
                    )
                )

    def _review_similar_names(self) -> None:
        """Different signatures, mostly the same words, compatible groups:
        a likely duplicate the rules did not merge (or an acronym of one)."""
        groups: list[tuple[str, frozenset[str], Profile, set[str], set[str]]] = []
        for key, root in self._taken.items():
            if root < 0:
                continue
            group = self._groups[root]
            words: set[str] = set()
            acronyms: set[str] = set()
            for i in group.members:
                identity = self.anchors[i].identity
                for signature in identity.signatures:
                    words |= set(signature.split())
                acronyms |= set(identity.acronyms)
            groups.append((key, frozenset(words), group.profile, group.refs, acronyms))
        frequency: dict[str, int] = defaultdict(int)
        for _key, words, *_ in groups:
            for word in words:
                frequency[word] += 1
        blocks: dict[str, list[int]] = defaultdict(list)
        for position, (_key, words, *_rest) in enumerate(groups):
            for word in words:
                if frequency[word] <= 25:
                    blocks[word].append(position)
        seen: set[tuple[int, int]] = set()
        found = 0
        for word in sorted(blocks):
            for i, first in enumerate(blocks[word]):
                for second in blocks[word][i + 1 :]:
                    pair = (first, second)
                    if pair in seen:
                        continue
                    seen.add(pair)
                    a, b = groups[first], groups[second]
                    union = a[1] | b[1]
                    if not union or conflict(a[2], b[2]) is not None:
                        continue
                    similarity = len(a[1] & b[1]) / len(union)
                    smaller = min(a[1], b[1], key=len)
                    contained = smaller < max(a[1], b[1], key=len) and bool(
                        smaller - GENERIC_TOKENS
                    )
                    if (0.6 <= similarity < 1.0) or contained:
                        found += 1
                        if found <= MAX_SIMILAR:
                            self.report.review.append(
                                QuarantineItem(
                                    kind="review",
                                    reason="similar names, not merged",
                                    refs=sorted(a[3] | b[3]),
                                    names=sorted(
                                        {
                                            self.crosswalk.entries[a[0]].name,
                                            self.crosswalk.entries[b[0]].name,
                                        }
                                    ),
                                    keys=[a[0], b[0]],
                                    detail=f"word overlap {similarity:.2f}",
                                )
                            )
        # Acronyms: "CUE" alone vs "Cambridge University Entrepreneurs".
        single_words = {next(iter(g[1])): g for g in groups if len(g[1]) == 1}
        for key, _words, profile, refs, acronyms in groups:
            for initials in sorted(acronyms):
                other = single_words.get(initials)
                if other and other[0] != key and conflict(profile, other[2]) is None:
                    self.report.review.append(
                        QuarantineItem(
                            kind="review",
                            reason="one name is the other's acronym",
                            refs=sorted(refs | other[3]),
                            names=sorted(
                                {
                                    self.crosswalk.entries[key].name,
                                    self.crosswalk.entries[other[0]].name,
                                }
                            ),
                            keys=[key, other[0]],
                        )
                    )

    def _finish_counts(self) -> None:
        self.counts["anchors"] = len(self.anchors)
        self.counts["held"] = len(self.report.held)
        self.counts["review"] = len(self.report.review)
        self.counts["dropped_references"] = len(self.report.dropped_references)
        self.report.counts = dict(sorted(self.counts.items()))


def org_key_safe(name: str) -> str | None:
    try:
        return org_key(name)
    except ValueError:
        return None


def resolve_records(
    records: Iterable[Record],
    *,
    crosswalk: Crosswalk | None = None,
    decisions: Decisions | None = None,
    run_key: str | None = None,
) -> Resolution:
    """Resolve `records` against `crosswalk` (updated in place)."""
    return Resolver(
        crosswalk if crosswalk is not None else Crosswalk(), decisions, run_key=run_key
    ).run(records)


__all__ = [
    "SOURCE_PRIORITY",
    "QuarantineItem",
    "QuarantineReport",
    "Resolution",
    "Resolver",
    "observation_identity",
    "ref_of",
    "resolve_records",
]
