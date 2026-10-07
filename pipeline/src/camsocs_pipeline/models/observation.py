"""The staging format: what a harvester stage writes, and the resolver reads.

The contract between harvesters and the rest of the pipeline. A harvester
never talks to Convex and never mints organisation keys: it records what one
source said about one thing as an `Observation` (organisations, teams,
sessions, venues) or an `EventObservation`, with `IdentityHints` saying how
to recognise who it is about. `staging.store` writes them as JSONL under
``var/staging/<source_type>/<run_key>.jsonl``.

Then:

1. **resolve** (T4) reads the latest file per source, maps every identity to a
   key (``entity_key``, ``IdentityHints.known_key`` on parents, relationship
   targets and event organisers) and writes the keyed observations to
   ``var/staging/_resolved/<run_key>.jsonl``;
2. stages that run after resolve (enrichment, events, inbox) may write
   observations that already carry keys, to their own source directory;
3. **load** posts every *keyed* observation (`Observation.is_keyed`) from the
   latest file of each directory: claims, sources, orgInternal,
   relationships, broker inferences and event organisers
   (`pipeline.load.ConvexLoader.post_observations`).

Rules the models enforce (AGENTS.md "Data honesty"):

- a field observation has a value, or a status of ``missing`` /
  ``not_applicable`` and no value — never ``None`` for "not observed" (omit
  the field instead);
- LLM observations carry their evidence quote and the quote-check verdict
  (`claims.llm_field` runs `extract.evidence.check_quote`); the server
  downgrades unquoted ones to ``inferred`` regardless;
- field names are the claimable fields of the entity type
  (`models.vocab.FIELDS_BY_ENTITY_TYPE`);
- no confidence anywhere: Convex computes it by rule.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from camsocs_pipeline.models.vocab import (
    CLAIM_METHODS,
    CLAIM_STATUSES,
    ENTITY_TYPES,
    EVENT_FIELDS,
    EVENT_ORGANISER_ROLES,
    EVENT_SOURCES,
    EVENT_VISIBILITIES,
    EVIDENCE_KINDS,
    FIELDS_BY_ENTITY_TYPE,
    MISSING_REASONS,
    ORG_LEVELS,
    ORG_TYPES,
    QUOTE_CHECKS,
    RELATIONSHIP_TYPES,
    RELATIONSHIP_VISIBILITIES,
    ROBOTS_VERDICTS,
    SOURCE_TYPES,
    Vocab,
)

SourceTypeStr = Vocab(SOURCE_TYPES)
EntityTypeStr = Vocab(ENTITY_TYPES)
ClaimMethodStr = Vocab(CLAIM_METHODS)
EvidenceKindStr = Vocab(EVIDENCE_KINDS)
ClaimStatusStr = Vocab(CLAIM_STATUSES)
MissingReasonStr = Vocab(MISSING_REASONS)
QuoteCheckStr = Vocab(QUOTE_CHECKS)
OrgTypeStr = Vocab(ORG_TYPES)
OrgLevelStr = Vocab(ORG_LEVELS)
RelationshipTypeStr = Vocab(RELATIONSHIP_TYPES)
RelationshipVisibilityStr = Vocab(RELATIONSHIP_VISIBILITIES)
EventSourceStr = Vocab(EVENT_SOURCES)
EventVisibilityStr = Vocab(EVENT_VISIBILITIES)
OrganiserRoleStr = Vocab(EVENT_ORGANISER_ROLES)
RobotsVerdictStr = Vocab(ROBOTS_VERDICTS)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("retrieved_at must be timezone-aware (UTC)")
    return value.astimezone(UTC)


AwareDatetime = Annotated[datetime, AfterValidator(_aware)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=False)


class IdentityHints(_Strict):
    """Everything a source tells us about *who* something is. The resolver
    matches on these (SU id, Instagram handle, normalised name + level +
    college, …); a harvester fills in what its source states and nothing else.
    """

    name: str
    aliases: list[str] = Field(default_factory=list)
    org_type: OrgTypeStr | None = None
    level: OrgLevelStr | None = None
    #: Free text naming a college ("Jesus", "Jesus College"); the resolver maps it.
    college_hint: str | None = None
    su_id: str | None = None
    su_slug: str | None = None
    proctors_name: str | None = None
    sport_slug: str | None = None
    camdram_id: int | None = None
    camdram_slug: str | None = None
    cucbc_club: str | None = None
    instagram_handle: str | None = None
    website_domain: str | None = None
    talks_list_ids: list[str] = Field(default_factory=list)
    email_domain: str | None = None
    #: Set by the resolver (or by a stage that already knows the entity).
    known_key: str | None = None


class FieldObs(_Strict):
    """One field as one source states it. Build with `claims.parser_field`,
    `claims.llm_field` or `claims.missing_field` rather than by hand."""

    field: str
    value: Any = None
    value_raw: str | None = None
    method: ClaimMethodStr
    evidence: EvidenceKindStr
    #: Rule id (``su_profile.email``) or model id.
    extractor: str
    prompt_version: str | None = None
    evidence_quote: str | None = None
    quote_check: QuoteCheckStr | None = None
    #: Omit for a value (``found``); ``missing`` / ``not_applicable`` without one.
    status: ClaimStatusStr | None = None
    missing_reason: MissingReasonStr | None = None

    @model_validator(mode="after")
    def _value_or_absence(self) -> Self:
        negative = self.status in ("missing", "not_applicable")
        if self.value is None and not negative:
            raise ValueError(
                f"{self.field}: no value — omit the field, or say status='missing' with a reason"
            )
        if self.value is not None and negative:
            raise ValueError(f"{self.field}: a {self.status} observation carries no value")
        if self.missing_reason is not None and self.status != "missing":
            raise ValueError(f"{self.field}: missing_reason belongs to status='missing'")
        return self


class RelObs(_Strict):
    """An edge from the observed organisation to another one."""

    type: RelationshipTypeStr
    to_identity: IdentityHints
    evidence_url: str
    note: str | None = None
    #: ``outgoing``: the observed organisation is the edge's `from` (it
    #: sponsors / is sister of `to`); ``incoming``: it is the `to`.
    direction: Literal["outgoing", "incoming"] = "outgoing"
    method: ClaimMethodStr = "parser"
    evidence: EvidenceKindStr = "secondary"
    quote_check: QuoteCheckStr | None = None
    #: Requested; the server grants ``public`` only to sponsors/co_hosted on
    #: primary evidence.
    visibility: RelationshipVisibilityStr | None = None


class FetchInfo(_Strict):
    """How the source page was fetched — becomes its `sources` row."""

    http_status: int | None = None
    robots_verdict: RobotsVerdictStr = "allowed"
    robots_checked_at: AwareDatetime | None = None
    access_note: str | None = None


class _ObservationBase(_Strict):
    source_type: SourceTypeStr
    #: A stable id *within* the source (an SU org id, a Camdram slug, a URL).
    source_key: str
    source_url: str
    retrieved_at: AwareDatetime
    content_sha256: str | None = None
    fetch: FetchInfo | None = None
    fields: list[FieldObs] = Field(default_factory=list)


class Observation(_ObservationBase):
    """What one source says about one organisation, team, session or venue."""

    kind: Literal["observation"] = "observation"
    entity_type: EntityTypeStr
    identity: IdentityHints
    #: The owning organisation, for a team or session.
    parent: IdentityHints | None = None
    #: Set by the resolver (or a stage that already knows the entity).
    entity_key: str | None = None
    relationships: list[RelObs] = Field(default_factory=list)
    #: orgInternal identifiers and feeds, snake_case names of
    #: `models.wire.OrgInternalPatch` (``su_org_id``, ``ics_urls``, …).
    internal: dict[str, Any] = Field(default_factory=dict)
    #: Broker inferences (private; `pipeline.load` turns them into
    #: `models.wire.BrokerInferences`):
    #:   ``needs`` / ``offers``: ``[{item, evidence_quote?, method?}]``
    #:   (NEED_OFFER_ITEMS; method default ``llm``; source = this observation);
    #:   ``people``: ``[{name, role, start_date?, public_links?, method?}]`` —
    #:   named committee members *as published*, never public.
    broker: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _fields_belong_to_type(self) -> Self:
        if self.entity_type == "event":
            raise ValueError("events are EventObservation, not Observation")
        allowed = FIELDS_BY_ENTITY_TYPE[self.entity_type]
        unknown = sorted({f.field for f in self.fields} - set(allowed))
        if unknown:
            raise ValueError(f"not {self.entity_type} fields: {', '.join(unknown)}")
        if self.entity_type in ("team", "session") and self.parent is None:
            raise ValueError(f"a {self.entity_type} observation needs its parent organisation")
        return self

    @property
    def is_keyed(self) -> bool:
        """Ready to load: the entity and every referenced identity has a key."""
        if self.entity_key is None:
            return False
        if self.parent is not None and self.parent.known_key is None:
            return False
        return all(rel.to_identity.known_key is not None for rel in self.relationships)


class OrganiserObs(_Strict):
    identity: IdentityHints
    role: OrganiserRoleStr = "organiser"


class EventObservation(_ObservationBase):
    """One event as one source lists it. Its key needs no resolver:
    `keys.event_key(event_source, external_id)`.

    `source`, `externalId` and `visibility` are attributes here, not fields:
    the load stage turns them into claims, so every event row gets them.
    `sourceUrl` defaults to the observation's `source_url`; add a
    ``sourceUrl`` field when the event's own page differs (an ICS feed entry
    linking to its page). Mailing-list events use an internal
    ``inbound:<message-id>`` source URL and default to ``cam_only``.
    """

    kind: Literal["event"] = "event"
    event_source: EventSourceStr
    external_id: str
    visibility: EventVisibilityStr
    organisers: list[OrganiserObs] = Field(default_factory=list)
    #: Organisers the source names but nobody could match to a key yet (an
    #: events stage resolves against the keyed observations in staging,
    #: `events.organisers`). Kept for a later resolver pass and for coverage
    #: reports; never posted, and they do not hold the event back.
    unresolved_organisers: list[OrganiserObs] = Field(default_factory=list)
    #: Where it happens, when the source names a venue. With a resolved key it
    #: becomes `venueKey`; without one, its name becomes `venueText`.
    venue: IdentityHints | None = None

    @model_validator(mode="after")
    def _fields_belong_to_events(self) -> Self:
        unknown = sorted({f.field for f in self.fields} - set(EVENT_FIELDS))
        if unknown:
            raise ValueError(f"not event fields: {', '.join(unknown)}")
        derived = {"source", "externalId", "visibility"} & {f.field for f in self.fields}
        if derived:
            raise ValueError(
                f"{', '.join(sorted(derived))} are attributes of the observation "
                "(event_source / external_id / visibility); do not repeat them as fields"
            )
        return self

    @property
    def is_keyed(self) -> bool:
        """Ready to load once every organiser is resolved (the venue may stay text)."""
        return all(o.identity.known_key is not None for o in self.organisers)


StagedRecord = Annotated[Observation | EventObservation, Field(discriminator="kind")]


__all__ = [
    "EventObservation",
    "FetchInfo",
    "FieldObs",
    "IdentityHints",
    "Observation",
    "OrganiserObs",
    "RelObs",
    "StagedRecord",
]
