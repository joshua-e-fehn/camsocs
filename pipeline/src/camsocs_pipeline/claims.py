"""Building field observations and claims — the one way stages make them.

Harvesters describe what a source says with `parser_field`, `llm_field` and
`missing_field` (→ `models.observation.FieldObs`); the load stage turns keyed
observations into wire claims with `claims_for_observation` /
`claims_for_event` (→ `models.wire.ClaimInput`).

What these enforce, so no stage has to remember it:

- **No nulls.** ``None`` inside a value (a dict member, a list item) is
  dropped; a value that is ``None`` or empty after that becomes a
  ``missing`` / ``not_found`` claim instead of a value. Absence is said with a
  status, never with null (AGENTS.md).
- **LLM honesty.** `llm_field` checks the model's quote against the source
  text (`extract.evidence.check_quote`) and records the verdict; without an
  ``exact``/``normalised`` match the claim says ``inferred``. The server
  applies the same rule again (convex/lib/resolve.ts `storedStatus`).
- **No confidence.** Nothing here computes or sends one; Convex does, by rule.
- **talks.cam stays out of the LLM** (source-research §6): `llm_field`
  refuses a ``talks_list`` source.
- `stored_status` mirrors the server's status normalisation, so
  `keys.claim_fingerprint` can predict the server's fingerprint.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any

from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote
from camsocs_pipeline.keys import event_key, source_key
from camsocs_pipeline.models.observation import EventObservation, FieldObs, Observation
from camsocs_pipeline.models.wire import ClaimInput

#: Sources whose text never reaches an LLM (robots.txt blocks AI agents; §6).
NO_LLM_SOURCE_TYPES = frozenset({"talks_list"})


class NoLLMSource(ValueError):
    """An LLM claim was attempted over a source that must never reach the LLM."""


def epoch_ms(moment: datetime) -> int:
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return int(moment.timestamp() * 1000)


def strip_nones(value: Any) -> Any:
    """Drops None members and items, recursively — null is never a value."""
    if isinstance(value, dict):
        return {k: strip_nones(v) for k, v in value.items() if v is not None}
    if isinstance(value, list | tuple):
        return [strip_nones(item) for item in value if item is not None]
    return value


def _is_empty(value: Any) -> bool:
    if isinstance(value, str):
        return not value.strip()
    return value is None or (isinstance(value, list | tuple | dict) and len(value) == 0)


# --- field observations (what harvesters write) ---------------------------------------


def parser_field(
    field: str,
    value: Any,
    *,
    extractor: str,
    evidence: str,
    value_raw: str | None = None,
    inferred: bool = False,
) -> FieldObs:
    """A value a deterministic rule read off the page. An empty value becomes
    a ``missing`` / ``not_found`` observation. ``inferred=True`` for a rule
    that guesses (a heuristic) rather than reads."""
    cleaned = strip_nones(value)
    if _is_empty(cleaned):
        return missing_field(field, "not_found", extractor=extractor, evidence=evidence)
    return FieldObs(
        field=field,
        value=cleaned,
        value_raw=value_raw,
        method="parser",
        evidence=evidence,
        extractor=extractor,
        status="inferred" if inferred else None,
    )


def llm_field(
    field: str,
    value: Any,
    *,
    quote: str | None,
    source_text: str,
    source_type: str,
    model: str,
    prompt_version: str,
    evidence: str,
) -> FieldObs:
    """A value an LLM extracted, with its verbatim quote checked against the
    text it was extracted from. ``found`` only on an exact or normalised match."""
    if source_type in NO_LLM_SOURCE_TYPES:
        raise NoLLMSource(f"{source_type} content is never passed to the LLM (source-research §6)")
    cleaned = strip_nones(value)
    if _is_empty(cleaned):
        return missing_field(field, "not_found", extractor=model, evidence=evidence, method="llm")
    match = check_quote(quote, source_text)
    return FieldObs(
        field=field,
        value=cleaned,
        method="llm",
        evidence=evidence,
        extractor=model,
        prompt_version=prompt_version,
        evidence_quote=quote or None,
        quote_check=match.value,
        status=None if match is not EvidenceMatch.ABSENT else "inferred",
    )


#: Joins the item quotes of a list value into its one evidence quote.
QUOTE_JOINER = " … "


def llm_items_field(
    field: str,
    items: list[tuple[Any, str | None]],
    *,
    source_texts: list[str],
    source_type: str,
    model: str,
    prompt_version: str,
    evidence: str,
) -> FieldObs:
    """A list value an LLM extracted item by item, each item with its own
    quote (categories, activity types, audiences …). One claim per field per
    page is all the server keeps, so the items become one value whose
    evidence is their quotes joined by `QUOTE_JOINER`. Each quote is checked
    against `source_texts` (the pages the model read); the claim is ``found``
    only if **every** item's quote is there — otherwise the whole list is
    ``inferred``."""
    if source_type in NO_LLM_SOURCE_TYPES:
        raise NoLLMSource(f"{source_type} content is never passed to the LLM (source-research §6)")
    values: list[Any] = []
    quotes: list[str] = []
    verdict = EvidenceMatch.EXACT
    for value, quote in items:
        cleaned = strip_nones(value)
        if _is_empty(cleaned) or cleaned in values:
            continue
        values.append(cleaned)
        matches = [check_quote(quote, text) for text in source_texts] or [EvidenceMatch.ABSENT]
        match = (
            EvidenceMatch.EXACT
            if EvidenceMatch.EXACT in matches
            else EvidenceMatch.NORMALISED
            if EvidenceMatch.NORMALISED in matches
            else EvidenceMatch.ABSENT
        )
        if match is EvidenceMatch.ABSENT:
            verdict = EvidenceMatch.ABSENT
        elif match is EvidenceMatch.NORMALISED and verdict is EvidenceMatch.EXACT:
            verdict = EvidenceMatch.NORMALISED
        if quote and quote.strip() and quote.strip() not in quotes:
            quotes.append(quote.strip())
    if not values:
        absent = missing_field(field, "not_found", extractor=model, evidence=evidence, method="llm")
        absent.prompt_version = prompt_version
        return absent
    joined = QUOTE_JOINER.join(quotes)[:4_000] or None
    return FieldObs(
        field=field,
        value=values,
        method="llm",
        evidence=evidence,
        extractor=model,
        prompt_version=prompt_version,
        evidence_quote=joined,
        quote_check=verdict.value if joined else EvidenceMatch.ABSENT.value,
        status=None if joined and verdict is not EvidenceMatch.ABSENT else "inferred",
    )


def missing_field(
    field: str,
    reason: str,
    *,
    extractor: str,
    evidence: str,
    method: str = "parser",
) -> FieldObs:
    """The source was checked and does not give this field. ``reason``:
    ``not_found`` (404, or absent from the page), ``not_published``,
    ``access_restricted`` (401/403, members-only), ``unreachable``."""
    return FieldObs(
        field=field,
        method=method,
        evidence=evidence,
        extractor=extractor,
        status="missing",
        missing_reason=reason,
    )


def not_applicable_field(field: str, *, extractor: str, evidence: str) -> FieldObs:
    return FieldObs(
        field=field,
        method="parser",
        evidence=evidence,
        extractor=extractor,
        status="not_applicable",
    )


# --- claims (what the load stage posts) -------------------------------------------------


def stored_status(obs: FieldObs) -> str:
    """The status the server will store (convex/lib/resolve.ts `storedStatus`)."""
    if obs.value is None:
        return "not_applicable" if obs.status == "not_applicable" else "missing"
    if obs.method == "manual":
        return "manual"
    if obs.method == "owner_submitted":
        return "owner_confirmed"
    if obs.method == "llm":
        quoted = bool((obs.evidence_quote or "").strip()) and obs.quote_check in (
            "exact",
            "normalised",
        )
        return "found" if quoted and obs.status != "inferred" else "inferred"
    return "inferred" if obs.status == "inferred" else "found"


def build_claim(
    obs: FieldObs,
    *,
    entity_type: str,
    entity_key: str,
    source_url: str,
    source_type: str,
    retrieved_at: datetime,
    content_sha256: str | None = None,
) -> ClaimInput:
    return ClaimInput(
        entity_type=entity_type,
        entity_key=entity_key,
        field=obs.field,
        value=strip_nones(obs.value) if obs.value is not None else None,
        value_raw=obs.value_raw,
        status=obs.status,
        missing_reason=obs.missing_reason,
        evidence=obs.evidence,
        method=obs.method,
        extractor=obs.extractor,
        prompt_version=obs.prompt_version,
        evidence_quote=obs.evidence_quote,
        quote_check=obs.quote_check,
        source_key=source_key(source_url),
        source_url=source_url,
        source_type=source_type,
        retrieved_at=epoch_ms(retrieved_at),
        content_sha256=content_sha256,
    )


def _claims(
    fields: Iterable[FieldObs], record: Observation | EventObservation, entity_type: str, key: str
) -> list[ClaimInput]:
    return [
        build_claim(
            obs,
            entity_type=entity_type,
            entity_key=key,
            source_url=record.source_url,
            source_type=record.source_type,
            retrieved_at=record.retrieved_at,
            content_sha256=record.content_sha256,
        )
        for obs in fields
    ]


def claims_for_observation(obs: Observation) -> list[ClaimInput]:
    """Claims for a resolved observation. Teams and sessions get an `orgKey`
    claim from their resolved parent; an organisation gets `parentKey` from
    its resolved parent (a JCR inside its college) and `collegeKeys` from its
    resolved ``member_college`` relationships — harvesters never mint keys, so
    these key-valued fields can only be claimed once the resolver has keyed
    the identities they point at.

    A derived claim carries the provenance of the reading that established
    it: `collegeKeys` the relationship's own `evidence_url` and evidence kind
    (the page that names the college, which need not be this one), and
    `parentKey` / `orgKey` the observation's — primary only when every field
    of it is (one primary registration fact does not make a listing primary
    for everything else)."""
    if obs.entity_key is None:
        raise ValueError("observation is not resolved: entity_key is None")
    fields = list(obs.fields)
    present = {f.field for f in fields}
    evidence = evidence_of(obs.fields)
    if obs.parent is not None:
        if obs.parent.known_key is None:
            raise ValueError("parent organisation is not resolved")
        parent_field = "parentKey" if obs.entity_type == "organisation" else "orgKey"
        if obs.entity_type in ("team", "session", "organisation") and parent_field not in present:
            fields.append(
                parser_field(
                    parent_field,
                    obs.parent.known_key,
                    extractor="resolve.parent",
                    evidence=evidence,
                )
            )
    claims = _claims(fields, obs, obs.entity_type, obs.entity_key)
    if obs.entity_type != "organisation" or "collegeKeys" in present:
        return claims
    # One claim per page that names a college, from that page.
    colleges: dict[tuple[str, str], set[str]] = {}
    for rel in obs.relationships:
        if (
            rel.type == "member_college"
            and rel.direction == "outgoing"
            and rel.to_identity.known_key is not None
        ):
            colleges.setdefault((rel.evidence_url, rel.evidence), set()).add(
                rel.to_identity.known_key
            )
    for (url, rel_evidence), keys in sorted(colleges.items()):
        claims.append(
            build_claim(
                parser_field(
                    "collegeKeys",
                    sorted(keys),
                    extractor="resolve.member_college",
                    evidence=rel_evidence,
                ),
                entity_type="organisation",
                entity_key=obs.entity_key,
                source_url=url,
                source_type=obs.source_type,
                retrieved_at=obs.retrieved_at,
                content_sha256=obs.content_sha256 if url == obs.source_url else None,
            )
        )
    return claims


def claims_for_event(
    obs: EventObservation, *, duplicate_of: tuple[str, str] | None = None
) -> list[ClaimInput]:
    """Claims for an event, including the identity claims every event row
    needs (`source`, `externalId`, `visibility`, `sourceUrl`) and its venue.

    ``duplicate_of``: (source, externalId) of the event another source
    already lists (`events.duplicates`). The reading's claims then go to that
    event, with their own provenance, and without the identity claims
    (`source`, `externalId`, `sourceUrl`): the event keeps its own listing.
    `visibility` is still claimed — the strictest reading wins."""
    key = event_key(*(duplicate_of or (obs.event_source, obs.external_id)))
    evidence = evidence_of(obs.fields)
    extra: list[FieldObs] = [
        parser_field("visibility", obs.visibility, extractor="event.identity", evidence=evidence),
    ]
    fields = list(obs.fields)
    if duplicate_of is None:
        extra[:0] = [
            parser_field("source", obs.event_source, extractor="event.identity", evidence=evidence),
            parser_field(
                "externalId", obs.external_id, extractor="event.identity", evidence=evidence
            ),
        ]
        if "sourceUrl" not in {f.field for f in fields}:
            extra.append(
                parser_field(
                    "sourceUrl", obs.source_url, extractor="event.identity", evidence=evidence
                )
            )
    else:
        fields = [f for f in fields if f.field != "sourceUrl"]
    present = {f.field for f in fields}
    if obs.venue is not None and not present & {"venueKey", "venueText"}:
        if obs.venue.known_key is not None:
            extra.append(
                parser_field(
                    "venueKey", obs.venue.known_key, extractor="resolve.venue", evidence=evidence
                )
            )
        else:
            extra.append(
                parser_field(
                    "venueText", obs.venue.name, extractor="event.venue", evidence=evidence
                )
            )
    return _claims([*fields, *extra], obs, "event", key)


def evidence_of(fields: Iterable[FieldObs]) -> str:
    """Identity claims (and the claims a later step derives from a reading, as
    the calendar-noise verdict) inherit the evidence kind of the observation's
    fields: primary only when all of them are."""
    kinds = {f.evidence for f in fields}
    return "primary" if kinds == {"primary"} else "secondary"


__all__ = [
    "NO_LLM_SOURCE_TYPES",
    "QUOTE_JOINER",
    "NoLLMSource",
    "build_claim",
    "claims_for_event",
    "claims_for_observation",
    "epoch_ms",
    "evidence_of",
    "llm_field",
    "llm_items_field",
    "missing_field",
    "not_applicable_field",
    "parser_field",
    "stored_status",
    "strip_nones",
]
