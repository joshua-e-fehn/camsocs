"""The ingestion API's payloads, as pydantic models — the pipeline's half of
the argument validators in webapp/convex/ingest/*.ts and convex/runs.ts.

Python names are snake_case; on the wire they are camelCase
(``model_dump(by_alias=True)``). `to_wire` is the one way a model becomes a
request body: it drops every ``None`` — the pipeline never sends null for a
field it did not observe (AGENTS.md; Bundestracker lost 633 records to one).
Models forbid unknown fields, so a typo fails here rather than as a 400.

Routes (all ``POST /api/pipeline/<path>``, Bearer ``PIPELINE_API_KEY``):

=====================  ==============================  ===========================
path                   body                            Convex function
=====================  ==============================  ===========================
claims                 `ClaimsBatch`                   ingest/claims:ingest
sources                `SourcesBatch`                  ingest/sources:upsert
orgInternal            `OrgInternalBatch`              ingest/orgInternal:patch
relationships          `RelationshipsBatch`            ingest/relationships:upsert
eventOrganisers        `EventOrganisersBatch`          ingest/relationships:setEventOrganisers
brokerInferences       `BrokerInferences`              ingest/broker:ingest
files                  `FileUpload`                    (http action) → ingest/files
inbound/pending        `InboundPendingRequest`         ingest/inbound:pending
inbound/file           `InboundFileRequest`            (http action) → ingest/inbound:fileOf
inbound/mark           `InboundMarkBatch`              ingest/inbound:mark
crosswalk              `CrosswalkRequest`              ingest/orgInternal:crosswalk
worklist               ``{paginationOpts}``            ingest/orgInternal:worklistPage
termDates              `TermDatesBatch`                ingest/termDates:upsert
derive                 ``{}``                          derive:daily
purge                  `PurgeRequest`                  ingest/purge:purge (dev only)
runs/start, finish     see pipeline/load.py            runs:start / runs:finish
=====================  ==============================  ===========================

Never sent: `confidence` (computed on the server), relationship keys
(minted on the server), `status` of a resolved field.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from camsocs_pipeline.models.vocab import (
    CLAIM_METHODS,
    CLAIM_STATUSES,
    ENTITY_TYPES,
    EVENT_ORGANISER_ROLES,
    EVIDENCE_KINDS,
    INBOUND_EXTRACTION_STATUSES,
    MISSING_REASONS,
    NEED_OFFER_ITEMS,
    QUOTE_CHECKS,
    RELATIONSHIP_TYPES,
    RELATIONSHIP_VISIBILITIES,
    ROBOTS_VERDICTS,
    SOURCE_TYPES,
    TERMS,
    Vocab,
)

EntityTypeStr = Vocab(ENTITY_TYPES)
ClaimMethodStr = Vocab(CLAIM_METHODS)
ClaimStatusStr = Vocab(CLAIM_STATUSES)
EvidenceKindStr = Vocab(EVIDENCE_KINDS)
MissingReasonStr = Vocab(MISSING_REASONS)
QuoteCheckStr = Vocab(QUOTE_CHECKS)
SourceTypeStr = Vocab(SOURCE_TYPES)
RobotsVerdictStr = Vocab(ROBOTS_VERDICTS)
RelationshipTypeStr = Vocab(RELATIONSHIP_TYPES)
RelationshipVisibilityStr = Vocab(RELATIONSHIP_VISIBILITIES)
OrganiserRoleStr = Vocab(EVENT_ORGANISER_ROLES)
NeedOfferItemStr = Vocab(NEED_OFFER_ITEMS)
ExtractionStr = Vocab(INBOUND_EXTRACTION_STATUSES)
TermStr = Vocab(TERMS)


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=False
    )

    def to_wire(self) -> dict[str, Any]:
        """The JSON body: camelCase, every None omitted."""
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


# --- claims ---------------------------------------------------------------------------


class ClaimInput(WireModel):
    """One observed value of one field (convex/ingest/claims.ts
    `claimInputValidator`). Build with `claims.build_claim`."""

    entity_type: EntityTypeStr
    entity_key: str
    field: str
    #: Omitted for a negative claim. Never None on the wire (to_wire drops it).
    value: Any = None
    value_raw: str | None = None
    status: ClaimStatusStr | None = None
    missing_reason: MissingReasonStr | None = None
    evidence: EvidenceKindStr
    method: ClaimMethodStr
    extractor: str
    prompt_version: str | None = None
    evidence_quote: str | None = None
    quote_check: QuoteCheckStr | None = None
    #: `keys.source_key(source_url)` — the `sources` row of the fetched page.
    source_key: str
    source_url: str
    source_type: SourceTypeStr
    #: Epoch milliseconds.
    retrieved_at: int
    content_sha256: str | None = None


class ClaimsBatch(WireModel):
    run_key: str | None = None
    claims: list[ClaimInput]


class Rejection(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    index: int
    entity_type: str
    entity_key: str
    field: str
    reason: str


class EntityCounts(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    created: int = 0
    updated: int = 0
    unchanged: int = 0


class ClaimsResult(WireModel):
    """What `claims` answers: claim-log counts, entity counts, and every
    claim refused with its reason (the rest of the batch still landed)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    entities: EntityCounts = Field(default_factory=EntityCounts)
    rejected: list[Rejection] = Field(default_factory=list)


# --- sources, orgInternal --------------------------------------------------------------


class SourceInput(WireModel):
    #: Must be `keys.source_key(url)`.
    key: str
    url: str
    source_type: SourceTypeStr
    org_key: str | None = None
    http_status: int | None = None
    access_note: str | None = None
    content_sha256: str | None = None
    last_fetched_at: int
    yielded: list[str] | None = None
    robots_verdict: RobotsVerdictStr
    robots_checked_at: int


class SourcesBatch(WireModel):
    sources: list[SourceInput]


class PlaywazeIds(WireModel):
    community_id: str | None = None
    league_ids: list[str] | None = None
    team_ids: list[str] | None = None


class SeniorTreasurer(WireModel):
    name: str | None = None
    department: str | None = None


class EmailHealth(WireModel):
    mx_ok: bool
    last_bounce_at: int | None = None
    checked_at: int


class WebsiteHealth(WireModel):
    last_status: int
    checked_at: int
    platform: str | None = None


class OrgInternalPatch(WireModel):
    """Patch by org key; absent fields untouched; list fields merge server-side."""

    org_key: str
    su_org_id: str | None = None
    su_slug: str | None = None
    proctors_name: str | None = None
    sport_slug: str | None = None
    camdram_slug: str | None = None
    camdram_id: int | None = None
    talks_list_ids: list[str] | None = None
    ics_urls: list[str] | None = None
    luma_calendar_ids: list[str] | None = None
    google_calendar_ids: list[str] | None = None
    playwaze: PlaywazeIds | None = None
    cucbc_club: str | None = None
    sympa_list: str | None = None
    ticketing_urls: list[str] | None = None
    instagram_handle: str | None = None
    instagram_business: bool | None = None
    instagram_user_id: str | None = None
    website_domain: str | None = None
    senior_treasurer: SeniorTreasurer | None = None
    legal_form: str | None = None
    email_health: EmailHealth | None = None
    website_health: WebsiteHealth | None = None


class OrgInternalBatch(WireModel):
    patches: list[OrgInternalPatch]


# --- relationships, event organisers ------------------------------------------------------


class RelationshipEvidence(WireModel):
    source_url: str
    event_key: str | None = None
    note: str | None = None
    seen_at: int


class RelationshipInput(WireModel):
    """The key is minted on the server (`keys.relationship_key` predicts it)."""

    from_key: str
    to_key: str
    type: RelationshipTypeStr
    evidence: RelationshipEvidence
    method: ClaimMethodStr
    evidence_kind: EvidenceKindStr
    quote_check: QuoteCheckStr | None = None
    visibility: RelationshipVisibilityStr | None = None


class RelationshipsBatch(WireModel):
    relationships: list[RelationshipInput]


class EventOrganiser(WireModel):
    org_key: str
    role: OrganiserRoleStr


class EventOrganiserSet(WireModel):
    """The event's organiser set. ``replace`` (the default) makes it the whole
    set; ``merge`` only adds — sent when the source names organisers this run
    could not resolve, so a partial or empty index never removes known ones."""

    event_key: str
    organisers: list[EventOrganiser]
    mode: Literal["replace", "merge"] = "replace"


class EventOrganisersBatch(WireModel):
    events: list[EventOrganiserSet]


# --- broker -------------------------------------------------------------------------------


class InferredItem(WireModel):
    item: NeedOfferItemStr
    evidence_quote: str | None = None
    source_url: str
    method: Literal["parser", "llm"]


class BrokerProfileInput(WireModel):
    """Inferred needs/offers replace the previous inferred ones of that kind;
    confirmed entries are never touched."""

    org_key: str
    needs: list[InferredItem] | None = None
    offers: list[InferredItem] | None = None


class PersonLink(WireModel):
    platform: str
    url: str


class PersonInput(WireModel):
    """A named committee member *as published*. Private: broker tables only."""

    #: `keys.person_key(org_key, name)`.
    key: str
    org_key: str
    name: str
    role: str
    academic_year: str | None = None
    start_date: str | None = None
    #: Default: the next 30 June after `seen_at`.
    stale_after: str | None = None
    source_url: str
    seen_at: int
    public_links: list[PersonLink] | None = None
    method: Literal["parser", "llm"]


class BrokerInferences(WireModel):
    profiles: list[BrokerProfileInput] | None = None
    people: list[PersonInput] | None = None


# --- files, inbox, term dates, maintenance ---------------------------------------------------


class FileUpload(WireModel):
    #: Base64 of at most 2 MB of PNG / JPEG / WebP / GIF / AVIF / PDF bytes.
    data: str
    content_type: Literal[
        "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "application/pdf"
    ]


class FileResult(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    storage_id: str
    sha256: str
    inserted: int = 0
    unchanged: int = 0


class InboundPendingRequest(WireModel):
    limit: int | None = None


class InboundAttachment(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    storage_id: str
    filename: str
    content_type: str


class PendingMail(WireModel):
    """A forwarded list mail awaiting extraction. Personal data: never logged."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    message_id: str
    received_at: int
    from_: str = Field(alias="from")
    list_id: str | None = None
    list_name: str | None = None
    subject: str
    text: str
    html_storage_id: str | None = None
    attachments: list[InboundAttachment] = Field(default_factory=list)
    org_key: str | None = None
    #: A trusted receiver verified the From domain (DKIM / DMARC; the server's
    #: `senderAuthenticated`). Only then may the mail speak for an organisation.
    sender_verified: bool = False


class CrosswalkRequest(WireModel):
    cursor: str | None = None
    limit: int | None = None


class CrosswalkRow(WireModel):
    """One organisation and the identifiers it is known by (read-only)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    org_key: str
    name: str | None = None
    aliases: list[str] = Field(default_factory=list)
    short_name: str | None = None
    org_type: str | None = None
    level: str | None = None
    college_keys: list[str] = Field(default_factory=list)
    is_counterpart: bool = False
    su_org_id: str | None = None
    su_slug: str | None = None
    proctors_name: str | None = None
    sport_slug: str | None = None
    camdram_slug: str | None = None
    camdram_id: int | None = None
    cucbc_club: str | None = None
    instagram_handle: str | None = None
    website_domain: str | None = None


class InboundMark(WireModel):
    message_id: str
    extraction: ExtractionStr
    extracted_event_keys: list[str] | None = None
    org_key: str | None = None
    note: str | None = None


class InboundMarkBatch(WireModel):
    items: list[InboundMark]


class InboundFileRequest(WireModel):
    message_id: str
    storage_id: str


class InboundFile(WireModel):
    """One attachment of a forwarded mail (base64). Personal data: never logged."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    data: str
    content_type: str
    filename: str


class MailingListInfo(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    platform: str | None = None
    address: str | None = None
    signup_url: str | None = None


class WorklistOrg(WireModel):
    """One organisation as `worklist` pages it (ingest/orgInternal.ts
    `worklistPage`): what the mailing-list sign-up worklist ranks on."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    key: str
    slug: str
    name: str
    short_name: str | None = None
    aliases: list[str] = Field(default_factory=list)
    status: str
    org_type: str | None = None
    level: str | None = None
    mailing_list: MailingListInfo | None = None
    sympa_list: str | None = None
    feeds: list[str] = Field(default_factory=list)
    upcoming_event_sources: list[str] = Field(default_factory=list)


class WorklistPage(WireModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
    page: list[WorklistOrg]
    is_done: bool
    continue_cursor: str


class TermDate(WireModel):
    academic_year: str
    term: TermStr
    full_term_start: str
    full_term_end: str
    source_url: str


class TermDatesBatch(WireModel):
    terms: list[TermDate]


class PurgeRequest(WireModel):
    confirm: Literal["PURGE-DEV"] = "PURGE-DEV"


__all__ = [
    "BrokerInferences",
    "BrokerProfileInput",
    "ClaimInput",
    "ClaimsBatch",
    "ClaimsResult",
    "CrosswalkRequest",
    "CrosswalkRow",
    "EventOrganiser",
    "EventOrganiserSet",
    "EventOrganisersBatch",
    "FileResult",
    "FileUpload",
    "InboundFile",
    "InboundFileRequest",
    "InboundMark",
    "InboundMarkBatch",
    "InboundPendingRequest",
    "InferredItem",
    "MailingListInfo",
    "OrgInternalBatch",
    "OrgInternalPatch",
    "PendingMail",
    "PersonInput",
    "PurgeRequest",
    "Rejection",
    "RelationshipEvidence",
    "RelationshipInput",
    "RelationshipsBatch",
    "SourceInput",
    "SourcesBatch",
    "TermDate",
    "TermDatesBatch",
    "WireModel",
    "WorklistOrg",
    "WorklistPage",
]
