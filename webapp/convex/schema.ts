import { defineSchema, defineTable } from "convex/server"
import { type Infer, v } from "convex/values"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  CLAIM_METHODS,
  COLLEGE_BODIES,
  CONSENT_BASES,
  EMAIL_TYPES,
  ENTITY_TYPES,
  EVENT_HOSTING,
  EVENT_ORGANISER_ROLES,
  EVENT_SOURCES,
  EVENT_STATUSES,
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  EVIDENCE_KINDS,
  FIELD_STATUSES,
  GENDER_CATEGORIES,
  HARVEST_RUN_STATUSES,
  HARVEST_STAGE_STATUSES,
  INBOUND_EXTRACTION_STATUSES,
  INTERACTION_CHANNELS,
  INTRODUCTION_STATUSES,
  LISTING_REQUEST_KINDS,
  LISTING_REQUEST_STATUSES,
  MISSING_REASONS,
  NEED_OFFER_ITEMS,
  NEED_OFFER_STATUSES,
  ORG_LEVELS,
  ORG_STATUSES,
  ORG_TYPES,
  PECR_SUBSCRIBER_TYPES,
  QUOTE_CHECKS,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_VISIBILITIES,
  REVIEW_STATUSES,
  ROBOTS_VERDICTS,
  SOURCE_TYPES,
  SUPPRESSION_SCOPES,
  TERM_SCOPES,
  TERMS,
} from "../lib/vocab"
import {
  chatChannelValidator,
  imageValidator,
  mailingListValidator,
  membershipValidator,
  priceValidator,
  registrationsValidator,
  roleEmailValidator,
  socialValidator,
  speakerValidator,
  sportValidator,
  trialsValidator,
} from "./lib/fields"
import { literalUnion } from "./lib/validators"

/**
 * The application schema — docs/data-model.md is the contract; change it
 * there first. Better Auth's tables live in its own component
 * (convex/betterAuth/schema.ts), not here.
 *
 * Rules every table follows (data-model §0; Bundestracker, salo-ba):
 *
 *  1. **Minted string keys, never `v.id`, for identity** (`org-<slug>`,
 *     `evt-<sha1>`, … — lib/keys.ts, mirrored by pipeline keys.py). A re-run
 *     finds the same row and a URL survives a table rebuild. `v.id` appears
 *     only for `_storage` files.
 *  2. **The pipeline is the source of truth.** Pipeline-owned tables are
 *     written only by `internal*` mutations behind `/api/pipeline/*`
 *     (convex/http.ts). Manual and owner corrections are `fieldClaims` rows
 *     with `method: "manual" | "owner_submitted"`, never direct edits.
 *  3. **Provenance per field.** `fieldClaims` is the append-only log of
 *     observations; each entity carries the *resolved* plain values plus
 *     `meta[field]` (`FieldMeta`), both computed on the server
 *     (convex/lib/resolve.ts). Confidence is computed by rule and never
 *     accepted from the caller.
 *  4. **Unknown is not empty.** A field with no value has
 *     `meta[field].status = "missing"` and a `missingReason`. Plain fields are
 *     `v.optional`; arrays are always present (empty, not missing). The
 *     pipeline never sends `null` for an unobserved field — it omits it.
 *  5. **Privacy boundary.** Public queries return only the public projection
 *     (convex/lib/projections.ts). The internal tables (`fieldClaims`,
 *     `sources`, `orgInternal`, `harvestRuns`, `inboundEmails`,
 *     `listingRequests`, `storedFiles`, `suppressions`,
 *     `coverageSnapshots`) and the broker tables (`people`,
 *     `orgBrokerProfiles`, `interactions`, `introductions`) are never
 *     returned by a public query; broker functions call `requireBrokerUser`.
 *     `cam_only` events need a verified @cam.ac.uk session; `members_only`
 *     are never shown.
 *  6. **Times.** Instants are epoch ms (UTC); dates are ISO `YYYY-MM-DD`;
 *     display is Europe/London.
 *  7. **Vocabularies** are the `as const` tuples in lib/vocab.ts, via
 *     `literalUnion`; the pipeline mirrors them and a test asserts parity.
 *  8. **`createdAt` / `updatedAt` are stamped by the mutation**, never posted.
 */

// --- shared shapes ------------------------------------------------------------------------

/** Provenance of one resolved field (data-model §1). */
export const fieldConflictValidator = v.object({
  value: v.any(),
  sourceUrl: v.string(),
  sourceType: literalUnion(SOURCE_TYPES),
  retrievedAt: v.number(),
  method: literalUnion(CLAIM_METHODS),
})

export const fieldMetaValidator = v.object({
  status: literalUnion(FIELD_STATUSES),
  evidence: v.optional(literalUnion(EVIDENCE_KINDS)),
  missingReason: v.optional(literalUnion(MISSING_REASONS)),
  /** 0..1, computed by rule (data-model §1.1). */
  confidence: v.optional(v.number()),
  sourceUrl: v.optional(v.string()),
  sourceType: v.optional(literalUnion(SOURCE_TYPES)),
  retrievedAt: v.optional(v.number()),
  method: v.optional(literalUnion(CLAIM_METHODS)),
  /** Independent sources (distinct hosts) that agree with the value. */
  claimCount: v.optional(v.number()),
  /** When `status` is `conflicting`: the readings that disagree with `value`. */
  conflicts: v.optional(v.array(fieldConflictValidator)),
  /** When `status` is `conflicting`: the displayed value's own status. */
  winnerStatus: v.optional(literalUnion(FIELD_STATUSES)),
})
export type FieldMetaDoc = Infer<typeof fieldMetaValidator>

export const metaValidator = v.record(v.string(), fieldMetaValidator)

/** One stage's result inside a run — what `pipeline/report.py` posts. */
export const harvestStageResult = v.object({
  name: v.string(),
  status: literalUnion(HARVEST_STAGE_STATUSES),
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  /** Items the stage saw but did not write — robots-disallowed, quarantined,
   * unchanged-on-fetch. Counted so a stage's report adds up. */
  skipped: v.number(),
  error: v.union(v.null(), v.string()),
  notes: v.array(v.string()),
  /** Named counts a stage reports beyond the four above, e.g. the resolve
   * stage's quarantine (`quarantineHeld`, `quarantineDropped`,
   * `quarantineReview`), read by the broker overview. Omitted when none. */
  metrics: v.optional(v.record(v.string(), v.number())),
})
export type HarvestStageResult = Infer<typeof harvestStageResult>

/**
 * One row per pipeline run that reached Convex (`--dry-run` never writes).
 * `status` is derived server-side from `stages` in `runs.finish`, never posted.
 */
export const harvestRunFields = {
  /** Minted by the pipeline per invocation, e.g. `20261007T215500Z-3f9a1c`. */
  runKey: v.string(),
  /** The CLI command, e.g. `sync`. */
  command: v.string(),
  /** Stage names in the order requested. */
  requestedStages: v.array(v.string()),
  /** `camsocs_pipeline.__version__` of the code that ran. */
  pipelineVersion: v.string(),
  status: literalUnion(HARVEST_RUN_STATUSES),
  startedAt: v.number(),
  /** null until `runs.finish`. */
  finishedAt: v.union(v.null(), v.number()),
  stages: v.array(harvestStageResult),
  warnings: v.array(v.string()),
  /** A run-level failure (e.g. the health check failed mid-run). */
  error: v.union(v.null(), v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
}

const stamps = { createdAt: v.number(), updatedAt: v.number() }

// --- pipeline-owned public tables (data-model §2) ----------------------------------------

/** Resolved values — written only by convex/ingest/claims.ts and convex/derive.ts. */
export const organisationFields = {
  key: v.string(),
  /** Derived: the key without `org-`. Unique. */
  slug: v.string(),
  name: v.string(),
  aliases: v.array(v.string()),
  shortName: v.optional(v.string()),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  collegeKeys: v.array(v.string()),
  collegeBody: v.optional(literalUnion(COLLEGE_BODIES)),
  parentKey: v.optional(v.string()),
  isCounterpart: v.boolean(),
  /** Marked defunct by a source (e.g. a college's inactive list) or manually. */
  defunct: v.optional(v.boolean()),
  /**
   * Hidden from the public site by the broker (a "remove" or "object" listing
   * request). Not a claim: set only by `broker.orgs.setHidden`, never by the
   * pipeline, and kept through every re-resolution. A hidden organisation has
   * no `orgCards` row, so no public query lists, links or names it.
   */
  hidden: v.optional(v.boolean()),
  /** Derived (data-model §6). */
  status: literalUnion(ORG_STATUSES),
  /** Derived: max of the claimed value and the latest past event. */
  lastActiveAt: v.optional(v.number()),
  registrations: registrationsValidator,
  categories: v.array(literalUnion(CATEGORIES)),
  activityTypes: v.array(literalUnion(ACTIVITY_TYPES)),
  audiences: v.array(literalUnion(AUDIENCES)),
  languages: v.array(v.string()),
  tags: v.array(v.string()),
  suCategory: v.optional(v.string()),
  department: v.optional(v.string()),
  logo: v.optional(imageValidator),
  shortDescription: v.optional(v.string()),
  description: v.optional(v.string()),
  howToJoin: v.optional(v.string()),
  joinUrl: v.optional(v.string()),
  membership: v.optional(membershipValidator),
  beginnerFriendly: v.optional(v.boolean()),
  trials: v.optional(trialsValidator),
  timeCommitment: v.optional(v.string()),
  termcardUrl: v.optional(v.string()),
  accessibilityNote: v.optional(v.string()),
  sport: v.optional(sportValidator),
  website: v.optional(v.string()),
  email: v.optional(v.string()),
  /** Derived from `email` (convex/lib/derived.ts classifyEmail). */
  emailType: v.optional(literalUnion(EMAIL_TYPES)),
  roleEmails: v.array(roleEmailValidator),
  contactFormUrl: v.optional(v.string()),
  mailingList: v.optional(mailingListValidator),
  socials: v.array(socialValidator),
  chatChannels: v.array(chatChannelValidator),
  /** Derived: name, aliases, short name, short description, tags, categories. */
  searchText: v.string(),
  meta: metaValidator,
  /** Derived: tracked fields whose status is `missing` — the outreach list. */
  missingFields: v.array(v.string()),
  ...stamps,
}

/**
 * The directory card of an organisation: a small, public-safe copy of the
 * fields the list and its filters need, maintained by convex/derive.ts
 * whenever the organisation changes. `orgs.list` / `orgs.facets` scan this
 * (a few hundred bytes per row) instead of the full rows (descriptions and
 * per-field meta run to ~10 KB each). Holds nothing that is not public.
 */
export const orgCardFields = {
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  /** Lowercased name, for ordering. */
  nameSort: v.string(),
  shortName: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  status: literalUnion(ORG_STATUSES),
  isCounterpart: v.boolean(),
  collegeKeys: v.array(v.string()),
  categories: v.array(literalUnion(CATEGORIES)),
  activityTypes: v.array(literalUnion(ACTIVITY_TYPES)),
  audiences: v.array(literalUnion(AUDIENCES)),
  beginnerFriendly: v.optional(v.boolean()),
  sport: v.optional(
    v.object({
      sport: v.optional(v.string()),
      blueStatus: v.optional(literalUnion(BLUE_STATUSES)),
      genderCategories: v.array(literalUnion(GENDER_CATEGORIES)),
    }),
  ),
  logoStorageId: v.optional(v.id("_storage")),
  searchText: v.string(),
  updatedAt: v.number(),
}

export const teamFields = {
  key: v.string(),
  orgKey: v.string(),
  name: v.string(),
  rank: v.optional(v.number()),
  gender: v.optional(literalUnion(GENDER_CATEGORIES)),
  league: v.optional(v.string()),
  memberCollegeKeys: v.array(v.string()),
  meta: metaValidator,
  ...stamps,
}

export const sessionFields = {
  key: v.string(),
  orgKey: v.string(),
  title: v.string(),
  dayOfWeek: v.optional(v.number()),
  startTime: v.optional(v.string()),
  endTime: v.optional(v.string()),
  venueKey: v.optional(v.string()),
  venueText: v.optional(v.string()),
  termScope: v.optional(literalUnion(TERM_SCOPES)),
  note: v.optional(v.string()),
  meta: metaValidator,
  ...stamps,
}

export const eventFields = {
  key: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  /** Derived: `endsAt` of a multi-day event (lib/calendar.ts `spanEndOf`),
   * else absent — indexed, so a run that began before a view still shows. */
  spanEndsAt: v.optional(v.number()),
  allDay: v.boolean(),
  /** Derived from `termDates`, e.g. "MT26 Wk 3". */
  termWeekLabel: v.optional(v.string()),
  venueKey: v.optional(v.string()),
  venueText: v.optional(v.string()),
  /** Set by `eventOrganisers` (the join table is authoritative). */
  organiserKeys: v.array(v.string()),
  coHostKeys: v.array(v.string()),
  sponsorKeys: v.array(v.string()),
  speakers: v.array(speakerValidator),
  price: v.optional(priceValidator),
  bookingUrl: v.optional(v.string()),
  signupRequired: v.optional(v.boolean()),
  visibility: literalUnion(EVENT_VISIBILITIES),
  eventType: literalUnion(EVENT_TYPES),
  image: v.optional(imageValidator),
  cancelled: v.boolean(),
  status: literalUnion(EVENT_STATUSES),
  source: literalUnion(EVENT_SOURCES),
  externalId: v.string(),
  sourceUrl: v.string(),
  /** Whether its organisations host it or only take part (decision D6).
   * Optional: rows written before D6 have none and host (the projection and
   * lib/materialise.ts default it). */
  hosting: v.optional(literalUnion(EVENT_HOSTING)),
  /** The external event's own page, for a `takes_part` event. */
  externalUrl: v.optional(v.string()),
  /** Derived: the latest retrieval of any of its claims. */
  lastSeenAt: v.number(),
  /** Derived: the listing it was read from (lib/derived.ts `sweepGroupOf`);
   * a future event far behind its listing's newest sighting is withdrawn. */
  sweepGroup: v.optional(v.string()),
  /** Derived: the lower of `title` and `startsAt` confidence. */
  confidence: v.number(),
  meta: metaValidator,
  ...stamps,
}

export const venueFields = {
  key: v.string(),
  name: v.string(),
  aliases: v.array(v.string()),
  address: v.optional(v.string()),
  collegeKey: v.optional(v.string()),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
  meta: metaValidator,
  ...stamps,
}

/** One sighting of an edge, as the pipeline posts it. */
export const relationshipEvidenceValidator = v.object({
  sourceUrl: v.string(),
  eventKey: v.optional(v.string()),
  note: v.optional(v.string()),
  seenAt: v.number(),
})

/** A stored sighting: plus the rule-based confidence of that one sighting
 * (data-model §1.1), from which the edge's confidence is computed. */
export const storedRelationshipEvidenceValidator = v.object({
  sourceUrl: v.string(),
  eventKey: v.optional(v.string()),
  note: v.optional(v.string()),
  seenAt: v.number(),
  confidence: v.optional(v.number()),
})

export const relationshipFields = {
  /** `rel-<sha1(from:type:to)>`, minted by the server. */
  key: v.string(),
  fromKey: v.string(),
  toKey: v.string(),
  type: literalUnion(RELATIONSHIP_TYPES),
  /** Newest first, at most 50. */
  evidence: v.array(storedRelationshipEvidenceValidator),
  firstSeenAt: v.number(),
  lastSeenAt: v.number(),
  confidence: v.number(),
  /** Default `internal`; only `sponsors` / `co_hosted` with primary evidence go public. */
  visibility: literalUnion(RELATIONSHIP_VISIBILITIES),
  ...stamps,
}

export const termDateFields = {
  academicYear: v.string(),
  term: literalUnion(TERMS),
  fullTermStart: v.string(),
  fullTermEnd: v.string(),
  /** The official page the dates were taken from. */
  sourceUrl: v.string(),
  ...stamps,
}

// --- pipeline-owned internal tables (data-model §3) --------------------------------------

export const fieldClaimFields = {
  entityType: literalUnion(ENTITY_TYPES),
  entityKey: v.string(),
  field: v.string(),
  /** Absent for a negative claim (`missing` / `not_applicable`). Never null. */
  value: v.optional(v.any()),
  valueRaw: v.optional(v.string()),
  sourceKey: v.string(),
  sourceUrl: v.string(),
  sourceType: literalUnion(SOURCE_TYPES),
  retrievedAt: v.number(),
  /** Bumped (at most daily) when the same observation is posted again. */
  lastSeenAt: v.number(),
  contentSha256: v.optional(v.string()),
  method: literalUnion(CLAIM_METHODS),
  /** Rule id or model id. */
  extractor: v.string(),
  promptVersion: v.optional(v.string()),
  evidenceQuote: v.optional(v.string()),
  quoteCheck: v.optional(literalUnion(QUOTE_CHECKS)),
  /** Normalised on the server (resolve.ts storedStatus). */
  status: literalUnion(FIELD_STATUSES),
  missingReason: v.optional(literalUnion(MISSING_REASONS)),
  evidence: literalUnion(EVIDENCE_KINDS),
  /** Computed by rule on the server. */
  confidence: v.number(),
  reviewStatus: literalUnion(REVIEW_STATUSES),
  runKey: v.optional(v.string()),
  /** lib/keys.ts claimFingerprint — idempotency. */
  fingerprint: v.string(),
  /** The suppression that set this claim aside (`reviewStatus: rejected`).
   * Its value, original and quote are then cleared — only the minimal record
   * stays — and lifting the suppression deletes it, so the next harvest
   * records the reading afresh (lib/suppressionEffects.ts). */
  setAsideBy: v.optional(v.string()),
  createdAt: v.number(),
}

export const sourceFields = {
  /** `src-<sha1(url)>`. */
  key: v.string(),
  url: v.string(),
  host: v.string(),
  sourceType: literalUnion(SOURCE_TYPES),
  orgKey: v.optional(v.string()),
  httpStatus: v.optional(v.number()),
  accessNote: v.optional(v.string()),
  contentSha256: v.optional(v.string()),
  lastFetchedAt: v.number(),
  /** What the fetch yielded, e.g. claim fields or event keys. */
  yielded: v.array(v.string()),
  robotsVerdict: literalUnion(ROBOTS_VERDICTS),
  robotsCheckedAt: v.number(),
  ...stamps,
}

export const orgInternalFields = {
  orgKey: v.string(),
  suOrgId: v.optional(v.string()),
  suSlug: v.optional(v.string()),
  proctorsName: v.optional(v.string()),
  sportSlug: v.optional(v.string()),
  camdramSlug: v.optional(v.string()),
  camdramId: v.optional(v.number()),
  talksListIds: v.array(v.string()),
  icsUrls: v.array(v.string()),
  lumaCalendarIds: v.array(v.string()),
  googleCalendarIds: v.array(v.string()),
  playwaze: v.optional(
    v.object({
      communityId: v.optional(v.string()),
      leagueIds: v.array(v.string()),
      teamIds: v.array(v.string()),
    }),
  ),
  cucbcClub: v.optional(v.string()),
  sympaList: v.optional(v.string()),
  ticketingUrls: v.array(v.string()),
  instagramHandle: v.optional(v.string()),
  instagramBusiness: v.optional(v.boolean()),
  instagramUserId: v.optional(v.string()),
  websiteDomain: v.optional(v.string()),
  seniorTreasurer: v.optional(
    v.object({ name: v.optional(v.string()), department: v.optional(v.string()) }),
  ),
  legalForm: v.optional(v.string()),
  emailHealth: v.optional(
    v.object({ mxOk: v.boolean(), lastBounceAt: v.optional(v.number()), checkedAt: v.number() }),
  ),
  websiteHealth: v.optional(
    v.object({ lastStatus: v.number(), checkedAt: v.number(), platform: v.optional(v.string()) }),
  ),
  ...stamps,
}

export const inboundAttachmentValidator = v.object({
  storageId: v.id("_storage"),
  filename: v.string(),
  contentType: v.string(),
})

export const inboundEmailFields = {
  messageId: v.string(),
  receivedAt: v.number(),
  from: v.string(),
  listId: v.optional(v.string()),
  listName: v.optional(v.string()),
  subject: v.string(),
  text: v.string(),
  htmlStorageId: v.optional(v.id("_storage")),
  attachments: v.array(inboundAttachmentValidator),
  /** Resolved organiser, when the pipeline identified one. */
  orgKey: v.optional(v.string()),
  /** A trusted receiver verified the sender's domain (DKIM / DMARC, read from
   * `ARC-Authentication-Results` / `Authentication-Results`; lib/inbound-email.ts
   * `senderAuthenticated`). Unverified mail is never attributed. */
  senderVerified: v.optional(v.boolean()),
  extraction: literalUnion(INBOUND_EXTRACTION_STATUSES),
  extractedEventKeys: v.array(v.string()),
  extractionNote: v.optional(v.string()),
  /** When the retention job removed the body (`text`, the stored HTML and the
   * attachments) of this processed mail (retention.md R4); the row itself
   * goes later. */
  bodyDeletedAt: v.optional(v.number()),
  /** When the retention job reduced a mail its events cite (`inbound:<id>`)
   * to a stub: message id, list, receipt time, organisation and event keys
   * stay; sender, subject and text are gone (R4). */
  purgedAt: v.optional(v.number()),
  ...stamps,
}

/** What accepting a listing request did (broker.listingRequests). */
export const listingRequestOutcomeValidator = v.object({
  /** Fields written as `owner_submitted` claims (an accepted correction). */
  appliedFields: v.optional(v.array(v.string())),
  /** Suppressions created (an accepted removal or objection). */
  suppressionKeys: v.optional(v.array(v.string())),
  acceptedAt: v.number(),
})

export const listingRequestFields = {
  key: v.string(),
  orgKey: v.optional(v.string()),
  kind: literalUnion(LISTING_REQUEST_KINDS),
  submitterEmail: v.string(),
  role: v.optional(v.string()),
  message: v.string(),
  /** Proposed corrections, field name → proposed value (text). */
  fields: v.optional(v.record(v.string(), v.string())),
  status: literalUnion(LISTING_REQUEST_STATUSES),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
  outcome: v.optional(listingRequestOutcomeValidator),
  /** When the retention job reduced an accepted correction its owner claims
   * cite (`request:<key>`) to a stub: key, kind, listing, role, outcome and
   * dates stay; the submitter's address, message and fields are gone (R8). */
  purgedAt: v.optional(v.number()),
}

/**
 * One suppression: something an accepted removal or objection took off the
 * site, which no later harvest may bring back (retention.md R8; kept
 * indefinitely). The pipeline reads the list (`POST /api/pipeline/suppressions`)
 * and filters before it loads; the ingestion mutations refuse what slips
 * through. Holds no personal data: a contact address is stored only as the
 * sha256 of its normalised form, a person only by their minted key.
 */
export const suppressionFields = {
  /** `sup-<sha1(scope:orgKey:field:valueHash:personKey)>`. */
  key: v.string(),
  scope: literalUnion(SUPPRESSION_SCOPES),
  /** The listing (scope organisation / field; the listing a contact or person
   * was found on). */
  orgKey: v.optional(v.string()),
  /** Scope field: an organisation field name (`ORGANISATION_FIELDS`). */
  field: v.optional(v.string()),
  /** Scope contact: sha256 of the trimmed, lower-cased address. */
  valueHash: v.optional(v.string()),
  /** Scope person: the broker `people` key (`per-<sha1>`). */
  personKey: v.optional(v.string()),
  /** Scope event: the event's key (`evt-<sha1>`). Scope name uses `valueHash`
   * (sha256 of the normalised name, lib/suppressions.ts `nameHash`). */
  eventKey: v.optional(v.string()),
  /** The request that asked for it, when one did. */
  requestKey: v.optional(v.string()),
  requestKind: v.optional(literalUnion(LISTING_REQUEST_KINDS)),
  /** Scope organisation: enforcing it took the listing out of outreach (the
   * broker profile's `suppressed`), so lifting it puts it back. */
  outreachSuppressed: v.optional(v.boolean()),
  createdAt: v.number(),
}

/** Files the pipeline uploaded (logos, event images), de-duplicated by content. */
export const storedFileFields = {
  sha256: v.string(),
  storageId: v.id("_storage"),
  contentType: v.string(),
  size: v.number(),
  createdAt: v.number(),
}

// --- broker tables (data-model §4) ------------------------------------------------------

export const personFields = {
  /** `per-<sha1(orgKey:nameSlug)>`. */
  key: v.string(),
  name: v.string(),
  orgKey: v.string(),
  role: v.string(),
  academicYear: v.string(),
  startDate: v.optional(v.string()),
  /** ISO date of the next handover; default the next 30 June. */
  staleAfter: v.string(),
  /** Derived daily: `staleAfter` has passed — needs reconfirming. */
  stale: v.boolean(),
  sourceUrl: v.string(),
  seenAt: v.number(),
  publicLinks: v.array(v.object({ platform: v.string(), url: v.string() })),
  consentBasis: literalUnion(CONSENT_BASES),
  /** `parser` / `llm` rows are pipeline-owned; `manual` rows are never overwritten by it. */
  method: literalUnion(CLAIM_METHODS),
  notes: v.optional(v.string()),
  archived: v.boolean(),
  ...stamps,
}

/**
 * A person retention deleted at handover (R5): only the person key (a hash
 * of organisation and name) and the academic year they were listed for. The
 * pipeline does not add them again from a page that still lists last year's
 * committee — only a reading that states a later academic year does.
 */
export const expiredPersonFields = {
  key: v.string(),
  academicYear: v.string(),
  deletedAt: v.number(),
}

export const needOfferValidator = v.object({
  item: literalUnion(NEED_OFFER_ITEMS),
  status: literalUnion(NEED_OFFER_STATUSES),
  evidenceQuote: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  method: v.optional(literalUnion(CLAIM_METHODS)),
  updatedAt: v.number(),
})

export const orgBrokerProfileFields = {
  orgKey: v.string(),
  needs: v.array(needOfferValidator),
  offers: v.array(needOfferValidator),
  optIns: v.object({
    openToSponsors: v.optional(v.boolean()),
    openToCollaborations: v.optional(v.boolean()),
    careersEvents: v.optional(v.boolean()),
  }),
  pecrSubscriberType: literalUnion(PECR_SUBSCRIBER_TYPES),
  suppressed: v.boolean(),
  ethicsFlags: v.array(v.string()),
  sponsorNotes: v.optional(v.string()),
  pastSponsorKeys: v.array(v.string()),
  notes: v.optional(v.string()),
  ...stamps,
}

export const interactionFields = {
  key: v.string(),
  date: v.number(),
  orgKey: v.optional(v.string()),
  personKey: v.optional(v.string()),
  channel: literalUnion(INTERACTION_CHANNELS),
  summary: v.string(),
  nextStep: v.optional(v.string()),
  followUpOn: v.optional(v.string()),
  ...stamps,
}

const introductionParty = v.object({
  orgKey: v.optional(v.string()),
  personKey: v.optional(v.string()),
})

export const introductionFields = {
  key: v.string(),
  partyA: introductionParty,
  partyB: introductionParty,
  reason: v.string(),
  date: v.number(),
  status: literalUnion(INTRODUCTION_STATUSES),
  outcome: v.optional(v.string()),
  ...stamps,
}

/**
 * The directory coverage the broker overview shows, folded server-side over
 * every organisation a page at a time (convex/coverage.ts; lib/broker/coverage.ts
 * defines the counts). One row per `scope`; recomputed after each pipeline run
 * and daily.
 */
const counts = v.record(v.string(), v.number())
export const coverageCountsValidator = v.object({
  total: v.number(),
  hidden: v.number(),
  counterparts: v.number(),
  byLevel: counts,
  byStatus: counts,
  byLevelStatus: v.record(v.string(), counts),
  byOrgType: counts,
  headline: v.object({
    email: v.number(),
    website: v.number(),
    instagram: v.number(),
    description: v.number(),
  }),
  held: counts,
  missing: counts,
})
export const coverageStatsValidator = v.object({
  ...coverageCountsValidator.fields,
  share: v.object({
    email: v.number(),
    website: v.number(),
    instagram: v.number(),
    description: v.number(),
  }),
  missingTop: v.array(v.object({ field: v.string(), count: v.number() })),
})

export const coverageSnapshotFields = {
  scope: v.literal("directory"),
  stats: coverageStatsValidator,
  /** Organisation rows read (listed + counterparts). */
  rows: v.number(),
  startedAt: v.number(),
  computedAt: v.number(),
}

/** One `@cam.ac.uk` sign-in link sent (convex/authEmail.ts) — a throttle, not a
 * log: the address is stored only as a sha256, and rows are pruned after a day. */
export const signInLinkSendFields = {
  emailHash: v.string(),
  /** sha256 of the caller's IP, for the per-client limit (convex/authEmail.ts). */
  clientHash: v.optional(v.string()),
  sentAt: v.number(),
}

export default defineSchema({
  // public, pipeline-owned
  organisations: defineTable(organisationFields)
    .index("by_key", ["key"])
    .index("by_slug", ["slug"])
    .index("by_level_status", ["level", "status"])
    .index("by_orgType", ["orgType"])
    .index("by_isCounterpart", ["isCounterpart"])
    // Retention (convex/retention.ts): is a stored file still someone's logo?
    .index("by_logoStorageId", ["logo.storageId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["level", "status", "orgType"],
    }),
  orgCards: defineTable(orgCardFields)
    .index("by_key", ["key"])
    .index("by_isCounterpart_nameSort", ["isCounterpart", "nameSort"])
    .index("by_orgType", ["orgType"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["isCounterpart", "level", "status", "orgType"],
    }),
  teams: defineTable(teamFields).index("by_key", ["key"]).index("by_orgKey", ["orgKey"]),
  sessions: defineTable(sessionFields).index("by_key", ["key"]).index("by_orgKey", ["orgKey"]),
  events: defineTable(eventFields)
    .index("by_key", ["key"])
    .index("by_startsAt", ["startsAt"])
    .index("by_visibility_startsAt", ["visibility", "startsAt"])
    .index("by_visibility_spanEndsAt", ["visibility", "spanEndsAt"])
    .index("by_sweepGroup_lastSeenAt", ["sweepGroup", "lastSeenAt"])
    // Retention (convex/retention.ts): is a stored file still an event's image?
    .index("by_imageStorageId", ["image.storageId"]),
  eventOrganisers: defineTable({
    eventKey: v.string(),
    orgKey: v.string(),
    role: literalUnion(EVENT_ORGANISER_ROLES),
    /** Denormalised from the event, kept in step by convex/ingest/claims.ts. */
    startsAt: v.number(),
    spanEndsAt: v.optional(v.number()),
    visibility: literalUnion(EVENT_VISIBILITIES),
  })
    .index("by_org_startsAt", ["orgKey", "startsAt"])
    .index("by_org_spanEndsAt", ["orgKey", "spanEndsAt"])
    .index("by_event", ["eventKey"]),
  venues: defineTable(venueFields).index("by_key", ["key"]),
  relationships: defineTable(relationshipFields)
    .index("by_key", ["key"])
    .index("by_from", ["fromKey", "type"])
    .index("by_to", ["toKey", "type"]),
  termDates: defineTable(termDateFields).index("by_year_term", ["academicYear", "term"]),

  // internal, pipeline-owned
  fieldClaims: defineTable(fieldClaimFields)
    .index("by_entity_field", ["entityType", "entityKey", "field", "reviewStatus"])
    .index("by_entity_review", ["entityType", "entityKey", "reviewStatus"])
    .index("by_run", ["runKey"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_setAsideBy", ["setAsideBy"]),
  sources: defineTable(sourceFields)
    .index("by_key", ["key"])
    .index("by_orgKey", ["orgKey"])
    .index("by_host", ["host"]),
  orgInternal: defineTable(orgInternalFields)
    .index("by_orgKey", ["orgKey"])
    .index("by_suOrgId", ["suOrgId"])
    .index("by_instagramHandle", ["instagramHandle"]),
  harvestRuns: defineTable(harvestRunFields)
    .index("by_runKey", ["runKey"])
    .index("by_startedAt", ["startedAt"]),
  storedFiles: defineTable(storedFileFields)
    .index("by_sha256", ["sha256"])
    .index("by_storageId", ["storageId"]),
  suppressions: defineTable(suppressionFields)
    .index("by_key", ["key"])
    .index("by_orgKey", ["orgKey"])
    .index("by_scope", ["scope"]),
  coverageSnapshots: defineTable(coverageSnapshotFields).index("by_scope", ["scope"]),

  // internal, written by the inbound webhook and the public form
  inboundEmails: defineTable(inboundEmailFields)
    .index("by_messageId", ["messageId"])
    .index("by_extraction_receivedAt", ["extraction", "receivedAt"]),
  listingRequests: defineTable(listingRequestFields)
    .index("by_key", ["key"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_submitter_createdAt", ["submitterEmail", "createdAt"])
    .index("by_kind_createdAt", ["kind", "createdAt"]),

  // internal, auth
  signInLinkSends: defineTable(signInLinkSendFields)
    .index("by_emailHash_sentAt", ["emailHash", "sentAt"])
    .index("by_clientHash_sentAt", ["clientHash", "sentAt"])
    .index("by_sentAt", ["sentAt"]),

  // private broker CRM
  people: defineTable(personFields)
    .index("by_key", ["key"])
    .index("by_orgKey", ["orgKey"])
    .index("by_stale_staleAfter", ["stale", "staleAfter"]),
  expiredPeople: defineTable(expiredPersonFields).index("by_key", ["key"]),
  orgBrokerProfiles: defineTable(orgBrokerProfileFields).index("by_orgKey", ["orgKey"]),
  interactions: defineTable(interactionFields)
    .index("by_key", ["key"])
    .index("by_orgKey_date", ["orgKey", "date"])
    .index("by_followUpOn", ["followUpOn"])
    .index("by_date", ["date"]),
  introductions: defineTable(introductionFields)
    .index("by_key", ["key"])
    .index("by_status_date", ["status", "date"])
    .index("by_date", ["date"]),
})
