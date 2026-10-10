"""The suppression list: what accepted removals and objections took off the
site (webapp/convex/lib/suppressions.ts; docs/compliance/retention.md R8).

The broker accepts a removal or objection in the dashboard; Convex stores it
and serves the list at ``POST /api/pipeline/suppressions``. Every
`ConvexLoader.post_observations` reads it once per run and calls
`apply_suppressions` on the load plan **before anything is posted**, so a run
never re-publishes what was removed. (Convex refuses what slips through; this
is the first layer, not the only one.)

Six scopes:

- **organisation** — nothing about the listing is posted: no claims, no feed
  identifiers, no edges, no broker inferences, no source rows owned by it; it
  is dropped from event organiser sets, and an event whose every organiser it
  was is not posted at all;
- **field** — no value claim for that field of that listing (negative
  claims still go: they say nothing);
- **contact** — an address, known only as the sha256 of its trimmed,
  lower-cased form. An ``email`` claim with it is dropped, it is taken out of
  ``roleEmails`` and a mailing list's ``address``, and cut out of free text
  (``[address removed]``), on every listing;
- **person** — a broker ``people`` key is never posted again;
- **event** — an event key: none of its claims or organisers is posted;
- **name** — a person's name, known only as the sha256 of its normalised
  words (`name_hash`, the same as webapp/convex/lib/suppressions.ts): cut out
  of every text posted (``[name removed]``), and a speaker of that name is
  not posted.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from camsocs_pipeline.models.wire import SuppressionList

if TYPE_CHECKING:
    from camsocs_pipeline.pipeline.load import LoadPlan

#: The same token as webapp/convex/lib/suppressions.ts `ADDRESS`.
ADDRESS = re.compile(r"""[^\s@<>()\[\]\\,;:"'`]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+""", re.IGNORECASE)

REDACTED = "[address removed]"
NAME_REDACTED = "[name removed]"
#: A run of letters (webapp/convex/lib/suppressions.ts `NAME_WORD`).
NAME_WORD = re.compile(r"[^\W\d_]+")
#: Words in a suppressed name, at most (`MAX_NAME_WORDS`).
MAX_NAME_WORDS = 5


def contact_hash(address: str) -> str:
    """sha256 of the trimmed, lower-cased address — how Convex stores it."""
    return hashlib.sha256(address.strip().lower().encode("utf-8")).hexdigest()


def _fold(word: str) -> str:
    """A word as names are compared: accents dropped, lower case, a–z only."""
    decomposed = unicodedata.normalize("NFKD", word)
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z]", "", plain.lower())


def name_words(name: str) -> list[str]:
    return [word for word in (_fold(m.group(0)) for m in NAME_WORD.finditer(name)) if word]


def name_hash(name: str) -> str:
    """sha256 of a name's normalised words — how Convex stores a name."""
    return hashlib.sha256(" ".join(name_words(name)).encode("utf-8")).hexdigest()


def name_spans(text: str, hashes: frozenset[str]) -> list[tuple[int, int]]:
    """Spans of `text` spelling a suppressed name: runs of two to
    `MAX_NAME_WORDS` words that begin and end with a capital."""
    if not hashes:
        return []
    words = [
        (_fold(m.group(0)), m.group(0)[0] != m.group(0)[0].lower(), m.start(), m.end())
        for m in NAME_WORD.finditer(text)
    ]
    spans: list[tuple[int, int]] = []
    for first in range(len(words)):
        if not words[first][1]:
            continue
        for size in range(2, MAX_NAME_WORDS + 1):
            run = words[first : first + size]
            if len(run) < size or not run[-1][1]:
                continue
            joined = " ".join(word for word, *_rest in run)
            if hashlib.sha256(joined.encode("utf-8")).hexdigest() in hashes:
                spans.append((run[0][2], run[-1][3]))
    return spans


@dataclass(frozen=True)
class Suppressions:
    organisations: frozenset[str] = frozenset()
    #: (org key, field).
    fields: frozenset[tuple[str, str]] = frozenset()
    contact_hashes: frozenset[str] = frozenset()
    people: frozenset[str] = frozenset()
    events: frozenset[str] = frozenset()
    name_hashes: frozenset[str] = frozenset()

    @classmethod
    def from_wire(cls, body: SuppressionList) -> Suppressions:
        return cls(
            organisations=frozenset(body.organisations),
            fields=frozenset((item.org_key, item.field) for item in body.fields),
            contact_hashes=frozenset(body.contact_hashes),
            people=frozenset(body.people),
            events=frozenset(body.events),
            name_hashes=frozenset(body.name_hashes),
        )

    @property
    def empty(self) -> bool:
        return not (
            self.organisations
            or self.fields
            or self.contact_hashes
            or self.people
            or self.events
            or self.name_hashes
        )

    def __len__(self) -> int:
        return (
            len(self.organisations)
            + len(self.fields)
            + len(self.contact_hashes)
            + len(self.people)
            + len(self.events)
            + len(self.name_hashes)
        )

    def suppressed_address(self, address: str) -> bool:
        return bool(self.contact_hashes) and contact_hash(address) in self.contact_hashes

    def names(self, text: str) -> bool:
        """Whether `text` names a person who objected."""
        return bool(name_spans(text, self.name_hashes))

    def redact(self, text: str) -> str:
        """`text` with every suppressed address and name cut out."""
        if self.contact_hashes:
            text = ADDRESS.sub(
                lambda match: (
                    REDACTED if self.suppressed_address(match.group(0)) else match.group(0)
                ),
                text,
            )
        spans = name_spans(text, self.name_hashes)
        if not spans:
            return text
        out, position = [], 0
        for start, end in sorted(spans):
            if start < position:
                continue
            out.append(text[position:start] + NAME_REDACTED)
            position = end
        return "".join(out) + text[position:]


#: Marks a value `strip_addresses` dropped entirely.
_DROP = object()


def strip_addresses(field_name: str, value: Any, suppressions: Suppressions) -> Any:
    """`value` without suppressed addresses or names, or `_DROP` when nothing
    is left of it (an ``email`` that was the address; ``roleEmails`` that
    were all it; ``speakers`` that were all the person)."""
    if (not suppressions.contact_hashes and not suppressions.name_hashes) or value is None:
        return value
    if field_name == "speakers" and isinstance(value, list) and suppressions.name_hashes:
        kept = [
            item
            for item in value
            if not (
                isinstance(item, dict)
                and isinstance(item.get("name"), str)
                and suppressions.names(item["name"])
            )
        ]
        if not kept:
            return _DROP
        value = kept
    if field_name == "email" and isinstance(value, str):
        return _DROP if suppressions.suppressed_address(value) else value
    if field_name == "roleEmails" and isinstance(value, list):
        kept = [
            item
            for item in value
            if not (
                isinstance(item, dict)
                and isinstance(item.get("email"), str)
                and suppressions.suppressed_address(item["email"])
            )
        ]
        return kept if kept else _DROP
    if field_name == "mailingList" and isinstance(value, dict):
        address = value.get("address")
        if isinstance(address, str) and suppressions.suppressed_address(address):
            rest = {key: item for key, item in value.items() if key != "address"}
            return rest if rest else _DROP
        return value
    return _redact_deep(value, suppressions)


def _redact_deep(value: Any, suppressions: Suppressions) -> Any:
    if isinstance(value, str):
        return suppressions.redact(value)
    if isinstance(value, list):
        return [_redact_deep(item, suppressions) for item in value]
    if isinstance(value, dict):
        return {key: _redact_deep(item, suppressions) for key, item in value.items()}
    return value


@dataclass
class SuppressionReport:
    """What `apply_suppressions` held back, by kind."""

    counts: Counter[str] = field(default_factory=Counter)

    def __bool__(self) -> bool:
        return sum(self.counts.values()) > 0

    def __str__(self) -> str:
        if not self:
            return "nothing suppressed"
        return "held back by the suppression list: " + ", ".join(
            f"{count} {name}" for name, count in sorted(self.counts.items())
        )


def apply_suppressions(plan: LoadPlan, suppressions: Suppressions) -> SuppressionReport:
    """Removes from `plan`, in place, everything `suppressions` forbids
    (module docstring). Returns what it held back."""
    report = SuppressionReport()
    if suppressions.empty:
        return report
    gone = suppressions.organisations

    # Teams and sessions of a suppressed organisation (their `orgKey` claim
    # names it) go with it.
    child_entities = {
        (claim.entity_type, claim.entity_key)
        for claim in plan.claims
        if claim.entity_type in ("team", "session")
        and claim.field == "orgKey"
        and claim.value in gone
    }

    # Events removed on request, and events whose every organiser is
    # suppressed (and none is unresolved).
    dropped_events: set[str] = set(suppressions.events)
    organiser_sets = []
    for org_set in plan.event_organisers:
        if org_set.event_key in suppressions.events:
            report.counts["events"] += 1
            continue
        kept = [o for o in org_set.organisers if o.org_key not in gone]
        if len(kept) < len(org_set.organisers):
            report.counts["event organisers"] += len(org_set.organisers) - len(kept)
            if not kept and org_set.mode != "merge":
                dropped_events.add(org_set.event_key)
                report.counts["events"] += 1
                continue
            org_set = org_set.model_copy(update={"organisers": kept})
        organiser_sets.append(org_set)
    plan.event_organisers = organiser_sets

    claims = []
    for claim in plan.claims:
        if claim.entity_type == "organisation" and claim.entity_key in gone:
            report.counts["claims"] += 1
            continue
        if (claim.entity_type, claim.entity_key) in child_entities or (
            claim.entity_type == "event" and claim.entity_key in dropped_events
        ):
            report.counts["claims"] += 1
            continue
        if claim.value is not None:
            if (
                claim.entity_type == "organisation"
                and (claim.entity_key, claim.field) in suppressions.fields
            ):
                report.counts["claims"] += 1
                continue
            stripped = strip_addresses(claim.field, claim.value, suppressions)
            if stripped is _DROP:
                report.counts["claims"] += 1
                continue
            if stripped != claim.value:
                report.counts["values redacted"] += 1
                claim = claim.model_copy(update={"value": stripped})
        claims.append(claim)
    plan.claims = claims

    before = len(plan.org_internal)
    plan.org_internal = [patch for patch in plan.org_internal if patch.org_key not in gone]
    report.counts["orgInternal"] += before - len(plan.org_internal)

    before = len(plan.relationships)
    plan.relationships = [
        rel for rel in plan.relationships if rel.from_key not in gone and rel.to_key not in gone
    ]
    report.counts["relationships"] += before - len(plan.relationships)

    before = len(plan.broker_profiles)
    plan.broker_profiles = [p for p in plan.broker_profiles if p.org_key not in gone]
    report.counts["broker profiles"] += before - len(plan.broker_profiles)

    before = len(plan.people)
    plan.people = [
        person
        for person in plan.people
        if person.org_key not in gone and person.key not in suppressions.people
    ]
    report.counts["people"] += before - len(plan.people)

    before = len(plan.sources)
    plan.sources = [source for source in plan.sources if source.org_key not in gone]
    report.counts["sources"] += before - len(plan.sources)

    report.counts = Counter({name: count for name, count in report.counts.items() if count})
    return report


__all__ = [
    "ADDRESS",
    "NAME_REDACTED",
    "REDACTED",
    "SuppressionReport",
    "Suppressions",
    "apply_suppressions",
    "contact_hash",
    "name_hash",
    "name_spans",
    "strip_addresses",
]
