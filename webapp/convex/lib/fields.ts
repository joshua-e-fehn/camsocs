import { type GenericValidator, type Infer, v } from "convex/values"
import { isEmail, isHttpUrl } from "../../lib/syntax"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  CHAT_PLATFORMS,
  COLLEGE_BODIES,
  ENTITY_TYPES,
  type EntityType,
  EVENT_FIELDS,
  EVENT_SOURCES,
  EVENT_STATUSES,
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  GENDER_CATEGORIES,
  MAILING_LIST_PLATFORMS,
  MEMBERSHIP_PERIODS,
  ORG_LEVELS,
  ORG_TYPES,
  ORGANISATION_FIELDS,
  ROLES,
  SESSION_FIELDS,
  SOCIAL_PLATFORMS,
  TEAM_FIELDS,
  TERM_SCOPES,
  VENUE_FIELDS,
} from "../../lib/vocab"
import { literalUnion } from "./validators"

/**
 * The claimable fields of every entity type: what a value must look like, how
 * several sources' claims combine, and whether a missing value matters.
 *
 * One registry, used three ways:
 *  - convex/schema.ts builds the entity tables' plain fields from the same
 *    validators, so a resolved value always fits its column;
 *  - convex/ingest/claims.ts checks each claim's `v.any()` value against the
 *    field's validator (`checkValue`) and its `check`;
 *  - convex/lib/resolve.ts reads `merge` / `compare` to resolve claims.
 *
 * The field *names* are the tuples in lib/vocab.ts (mirrored by the pipeline);
 * `assertRegistryMatchesVocab` (run by fields.test.ts) keeps the two equal.
 *
 * Imports only convex/values and lib/vocab — schema.ts imports this module.
 */

// --- shared value validators -------------------------------------------------------

export const registrationValidator = v.object({
  registered: v.boolean(),
  /** Academic year, e.g. "2026-27". */
  year: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
})
export type Registration = Infer<typeof registrationValidator>

export const registrationsValidator = v.object({
  su: v.optional(registrationValidator),
  proctors: v.optional(registrationValidator),
  sportsService: v.optional(registrationValidator),
  camdram: v.optional(registrationValidator),
  cucbc: v.optional(registrationValidator),
})

/** Our own stored copy (`storageId`) plus where it came from. Never hotlinked. */
export const imageValidator = v.object({
  storageId: v.optional(v.id("_storage")),
  sourceUrl: v.optional(v.string()),
  credit: v.optional(v.string()),
})

export const membershipValidator = v.object({
  tiers: v.array(
    v.object({
      label: v.string(),
      pricePence: v.optional(v.number()),
      /** Absent when the source states no period: never assumed. */
      period: v.optional(literalUnion(MEMBERSHIP_PERIODS)),
      note: v.optional(v.string()),
    }),
  ),
  bursaryNote: v.optional(v.string()),
  collegeReimbursable: v.optional(v.boolean()),
})

export const trialsValidator = v.object({
  required: v.boolean(),
  dates: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
})

/** Assembled from the `sport.*` sub-field claims. */
export const sportValidator = v.object({
  sport: v.optional(v.string()),
  blueStatus: v.optional(literalUnion(BLUE_STATUSES)),
  varsity: v.optional(v.boolean()),
  bucs: v.optional(v.boolean()),
  collegeCompetition: v.optional(v.boolean()),
  genderCategories: v.array(literalUnion(GENDER_CATEGORIES)),
  kitCostNote: v.optional(v.string()),
  venues: v.optional(v.array(v.string())),
})

export const roleEmailValidator = v.object({ role: literalUnion(ROLES), email: v.string() })

export const mailingListValidator = v.object({
  platform: v.optional(literalUnion(MAILING_LIST_PLATFORMS)),
  address: v.optional(v.string()),
  signupUrl: v.optional(v.string()),
})

export const socialValidator = v.object({
  platform: literalUnion(SOCIAL_PLATFORMS),
  url: v.string(),
  handle: v.optional(v.string()),
})

/** Never an invite URL — only that a channel exists and how to ask for it. */
export const chatChannelValidator = v.object({
  platform: literalUnion(CHAT_PLATFORMS),
  howToJoin: v.optional(v.string()),
})

export const speakerValidator = v.object({ name: v.string(), affiliation: v.optional(v.string()) })

export const priceValidator = v.object({
  free: v.boolean(),
  minPence: v.optional(v.number()),
  maxPence: v.optional(v.number()),
  text: v.optional(v.string()),
})

// --- semantic checks ----------------------------------------------------------------

type Check = (value: unknown) => string | null

const ORG_KEY = /^org-[a-z0-9-]+$/

// Shared with the public form's in-browser checks.
export { isEmail, isHttpUrl }

/** An organisation key as lib/keys.ts mints it. */
export function isOrgKey(value: string): boolean {
  return ORG_KEY.test(value)
}

const checks = {
  email: (value: unknown) =>
    typeof value === "string" && isEmail(value) ? null : "not an email address",
  url: (value: unknown) =>
    typeof value === "string" && isHttpUrl(value) ? null : "not an http(s) URL",
  orgKey: (value: unknown) =>
    typeof value === "string" && isOrgKey(value) ? null : "not an organisation key",
  venueKey: (value: unknown) =>
    typeof value === "string" && /^ven-[a-z0-9-]+$/.test(value) ? null : "not a venue key",
  hhmm: (value: unknown) =>
    typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? null : "not HH:MM",
  dayOfWeek: (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6
      ? null
      : "not a day of week 0..6",
  instant: (value: unknown) =>
    typeof value === "number" && value > Date.UTC(1990, 0, 1) && value < Date.UTC(2100, 0, 1)
      ? null
      : "not a plausible epoch-ms instant",
  latitude: (value: unknown) =>
    typeof value === "number" && value >= -90 && value <= 90 ? null : "latitude out of range",
  longitude: (value: unknown) =>
    typeof value === "number" && value >= -180 && value <= 180 ? null : "longitude out of range",
} satisfies Record<string, Check>

function maxLength(limit: number): Check {
  return (value) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= limit
      ? null
      : `must be 1..${limit} characters`
}

function each(check: Check): Check {
  return (value) => {
    if (!Array.isArray(value)) return "expected an array"
    for (const item of value) {
      const problem = check(item)
      if (problem) return problem
    }
    return null
  }
}

function urlsIn(pick: (item: Record<string, unknown>) => unknown[]): Check {
  return (value) => {
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      for (const url of pick(item as Record<string, unknown>)) {
        if (url !== undefined && checks.url(url)) return `${String(url)}: not an http(s) URL`
      }
    }
    return null
  }
}

const INVITE_LINK =
  /(chat\.whatsapp\.com|discord\.gg|discord\.com\/invite|t\.me\/|join\.slack\.com|groupme\.com\/join)/i

// --- the registry -------------------------------------------------------------------

/**
 * How claims for one field combine (docs/data-model.md §1.2):
 *  - `single` — one winner by precedence; disagreeing equal-rank claims make
 *    the field `conflicting` unless `compare` is `text`;
 *  - `union`  — array fields: the union of the contributing claims' items,
 *    de-duplicated by `itemKey`;
 *  - `max`    — the largest value wins (a "latest activity" timestamp);
 *  - `strictest` — the most restrictive value any live claim reports wins,
 *    by `order` (least to most restrictive), whatever its precedence or age;
 *    only a manual / owner override can lift it. For privacy gates, where a
 *    later or better-ranked reading must never widen who can see something.
 */
export type MergeRule = "single" | "union" | "max" | "strictest"

/** How two values are compared for agreement / conflict. `text` never
 * conflicts: two sources' prose always differs, and that is not a dispute. */
export type CompareRule = "exact" | "email" | "url" | "text"

/** What applicability may look at: the entity's resolved plain fields. */
export type ApplicabilityContext = {
  orgType?: string
  level?: string
  categories?: readonly string[]
  isCounterpart?: boolean
}

export type FieldSpec = {
  validator: GenericValidator
  merge: MergeRule
  compare: CompareRule
  check?: Check
  /** De-duplication key for one item of a `union` field. */
  itemKey?: (item: unknown) => string
  /** For `strictest`: the values from least to most restrictive. */
  order?: readonly string[]
  /** A URL field whose sources check the URL itself: a negative reading
   * *from* the URL (it answered 404, a login wall or nothing) sets claims of
   * that URL aside (lib/resolve.ts `withoutDeadLinks`). */
  checksLink?: boolean
  /** Counts toward `organisations.missingFields` (the outreach list). */
  tracked?: boolean
  /** When false and nobody claimed the field, its status is `not_applicable`. */
  applies?: (context: ApplicabilityContext) => boolean
  /** Must be resolved for the entity row to be created. */
  requiredOnCreate?: boolean
}

const lower = (item: unknown) => String(item).trim().toLowerCase()
const exactItem = (item: unknown) => String(item)

const isSporty = (c: ApplicabilityContext) =>
  c.orgType === "sports_club" ||
  c.orgType === "college_boat_club" ||
  (c.categories ?? []).includes("sport")
const isCollegeLevel = (c: ApplicabilityContext) =>
  c.level === "college" ||
  ["jcr", "mcr", "college_club", "college_boat_club"].includes(c.orgType ?? "")

function scalar(validator: GenericValidator, extra: Partial<FieldSpec> = {}): FieldSpec {
  return { validator, merge: "single", compare: "exact", ...extra }
}

function text(limit: number, extra: Partial<FieldSpec> = {}): FieldSpec {
  return {
    validator: v.string(),
    merge: "single",
    compare: "text",
    check: maxLength(limit),
    ...extra,
  }
}

function url(extra: Partial<FieldSpec> = {}): FieldSpec {
  return { validator: v.string(), merge: "single", compare: "url", check: checks.url, ...extra }
}

function union(
  element: GenericValidator,
  itemKey: (item: unknown) => string,
  extra: Partial<FieldSpec> = {},
): FieldSpec {
  return { validator: v.array(element), merge: "union", compare: "exact", itemKey, ...extra }
}

const registration = scalar(registrationValidator, { check: urlsIn((r) => [r.sourceUrl]) })

export const ORGANISATION_SPECS: Record<(typeof ORGANISATION_FIELDS)[number], FieldSpec> = {
  name: text(200, { requiredOnCreate: true }),
  aliases: union(v.string(), lower, { check: each(maxLength(200)) }),
  shortName: text(40),
  orgType: scalar(literalUnion(ORG_TYPES), { tracked: true }),
  level: scalar(literalUnion(ORG_LEVELS), { tracked: true }),
  collegeKeys: union(v.string(), exactItem, {
    check: each(checks.orgKey),
    tracked: true,
    applies: isCollegeLevel,
  }),
  collegeBody: scalar(literalUnion(COLLEGE_BODIES), { applies: isCollegeLevel }),
  parentKey: scalar(v.string(), { check: checks.orgKey }),
  isCounterpart: scalar(v.boolean()),
  defunct: scalar(v.boolean()),
  lastActiveAt: { validator: v.number(), merge: "max", compare: "exact", check: checks.instant },
  "registrations.su": registration,
  "registrations.proctors": registration,
  "registrations.sportsService": registration,
  "registrations.camdram": registration,
  "registrations.cucbc": registration,
  categories: union(literalUnion(CATEGORIES), exactItem, { tracked: true }),
  activityTypes: union(literalUnion(ACTIVITY_TYPES), exactItem, { tracked: true }),
  audiences: union(literalUnion(AUDIENCES), exactItem, { tracked: true }),
  languages: union(v.string(), lower, {
    check: each((item) =>
      typeof item === "string" && /^[a-z]{2}$/.test(item) ? null : "not an ISO 639-1 code",
    ),
  }),
  tags: union(v.string(), lower, {
    check: each((item) =>
      typeof item === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(item) && item.length <= 40
        ? null
        : "tags are lower-kebab, ≤ 40 characters",
    ),
  }),
  suCategory: text(100),
  department: text(200),
  logo: scalar(imageValidator, { tracked: true, check: urlsIn((i) => [i.sourceUrl]) }),
  shortDescription: text(200, { tracked: true }),
  description: text(20_000, { tracked: true }),
  howToJoin: text(2_000, { tracked: true }),
  joinUrl: url({ tracked: true }),
  membership: scalar(membershipValidator, { compare: "text", tracked: true }),
  beginnerFriendly: scalar(v.boolean(), { tracked: true }),
  trials: scalar(trialsValidator, { compare: "text", applies: isSporty }),
  timeCommitment: text(500, { tracked: true }),
  termcardUrl: url(),
  accessibilityNote: text(2_000),
  "sport.sport": scalar(v.string(), { compare: "text", applies: isSporty }),
  "sport.blueStatus": scalar(literalUnion(BLUE_STATUSES), { tracked: true, applies: isSporty }),
  "sport.varsity": scalar(v.boolean(), { applies: isSporty }),
  "sport.bucs": scalar(v.boolean(), { applies: isSporty }),
  "sport.collegeCompetition": scalar(v.boolean(), { tracked: true, applies: isSporty }),
  "sport.genderCategories": union(literalUnion(GENDER_CATEGORIES), exactItem, {
    tracked: true,
    applies: isSporty,
  }),
  "sport.kitCostNote": text(500, { applies: isSporty }),
  "sport.venues": union(v.string(), lower, { check: each(maxLength(200)), applies: isSporty }),
  website: url({ tracked: true, checksLink: true }),
  email: scalar(v.string(), { compare: "email", check: checks.email, tracked: true }),
  roleEmails: union(
    roleEmailValidator,
    (item) => {
      const entry = item as { role: string; email: string }
      return `${entry.role}:${entry.email.trim().toLowerCase()}`
    },
    {
      tracked: true,
      check: each((item) => checks.email((item as { email: unknown }).email)),
    },
  ),
  contactFormUrl: url(),
  mailingList: scalar(mailingListValidator, {
    tracked: true,
    check: urlsIn((m) => [m.signupUrl]),
  }),
  socials: union(socialValidator, (item) => normaliseUrl((item as { url: string }).url), {
    tracked: true,
    check: urlsIn((s) => [s.url]),
  }),
  chatChannels: union(chatChannelValidator, (item) => (item as { platform: string }).platform, {
    check: each((item) => {
      const howToJoin = (item as { howToJoin?: unknown }).howToJoin
      return typeof howToJoin === "string" && INVITE_LINK.test(howToJoin)
        ? "chat invite links are never stored"
        : null
    }),
  }),
}

export const EVENT_SPECS: Record<(typeof EVENT_FIELDS)[number], FieldSpec> = {
  title: text(300, { requiredOnCreate: true }),
  description: text(20_000),
  startsAt: scalar(v.number(), { check: checks.instant, requiredOnCreate: true }),
  endsAt: scalar(v.number(), { check: checks.instant }),
  allDay: scalar(v.boolean()),
  venueKey: scalar(v.string(), { check: checks.venueKey }),
  venueText: text(300),
  speakers: scalar(v.array(speakerValidator), { compare: "text" }),
  price: scalar(priceValidator),
  bookingUrl: url(),
  signupRequired: scalar(v.boolean()),
  /** Strictest reading wins: a later mail or post that omits "members only"
   * never opens an event a live claim restricts (AGENTS.md privacy boundary). */
  visibility: scalar(literalUnion(EVENT_VISIBILITIES), {
    merge: "strictest",
    order: EVENT_VISIBILITIES,
    requiredOnCreate: true,
  }),
  eventType: scalar(literalUnion(EVENT_TYPES)),
  image: scalar(imageValidator, { check: urlsIn((i) => [i.sourceUrl]) }),
  cancelled: scalar(v.boolean()),
  status: scalar(literalUnion(EVENT_STATUSES)),
  source: scalar(literalUnion(EVENT_SOURCES), { requiredOnCreate: true }),
  externalId: scalar(v.string(), { check: maxLength(500), requiredOnCreate: true }),
  /** The event's page, or an opaque internal reference for mailing-list
   * events (`inbound:<messageId>`), which the projection never shows. */
  sourceUrl: scalar(v.string(), {
    compare: "url",
    check: (value) =>
      typeof value === "string" && /^[a-z][a-z0-9+.-]*:\S+$/i.test(value) && value.length <= 2048
        ? null
        : "not a URL or URI",
    requiredOnCreate: true,
  }),
}

export const TEAM_SPECS: Record<(typeof TEAM_FIELDS)[number], FieldSpec> = {
  orgKey: scalar(v.string(), { check: checks.orgKey, requiredOnCreate: true }),
  name: text(200, { requiredOnCreate: true }),
  rank: scalar(v.number()),
  gender: scalar(literalUnion(GENDER_CATEGORIES)),
  league: text(200),
  memberCollegeKeys: union(v.string(), exactItem, { check: each(checks.orgKey) }),
}

export const SESSION_SPECS: Record<(typeof SESSION_FIELDS)[number], FieldSpec> = {
  orgKey: scalar(v.string(), { check: checks.orgKey, requiredOnCreate: true }),
  title: text(300, { requiredOnCreate: true }),
  dayOfWeek: scalar(v.number(), { check: checks.dayOfWeek }),
  startTime: scalar(v.string(), { check: checks.hhmm }),
  endTime: scalar(v.string(), { check: checks.hhmm }),
  venueKey: scalar(v.string(), { check: checks.venueKey }),
  venueText: text(300),
  termScope: scalar(literalUnion(TERM_SCOPES)),
  note: text(2_000),
}

export const VENUE_SPECS: Record<(typeof VENUE_FIELDS)[number], FieldSpec> = {
  name: text(200, { requiredOnCreate: true }),
  aliases: union(v.string(), lower, { check: each(maxLength(200)) }),
  address: text(500),
  collegeKey: scalar(v.string(), { check: checks.orgKey }),
  lat: scalar(v.number(), { check: checks.latitude }),
  lng: scalar(v.number(), { check: checks.longitude }),
}

export const FIELD_SPECS: Record<EntityType, Record<string, FieldSpec>> = {
  organisation: ORGANISATION_SPECS,
  event: EVENT_SPECS,
  team: TEAM_SPECS,
  session: SESSION_SPECS,
  venue: VENUE_SPECS,
}

/** The key prefix each entity type's keys carry (lib/keys.ts). */
export const KEY_PREFIXES: Record<EntityType, string> = {
  organisation: "org-",
  event: "evt-",
  team: "team-",
  session: "ses-",
  venue: "ven-",
}

/** Every field the registry knows for `entityType`, in vocab order. */
export function fieldNames(entityType: EntityType): string[] {
  return Object.keys(FIELD_SPECS[entityType])
}

/** Throws if a registry and its lib/vocab.ts tuple disagree. Called by tests. */
export function assertRegistryMatchesVocab(): void {
  const vocab: Record<EntityType, readonly string[]> = {
    organisation: ORGANISATION_FIELDS,
    event: EVENT_FIELDS,
    team: TEAM_FIELDS,
    session: SESSION_FIELDS,
    venue: VENUE_FIELDS,
  }
  for (const entityType of ENTITY_TYPES) {
    const registry = fieldNames(entityType)
    const expected = [...vocab[entityType]]
    if (registry.join(",") !== expected.join(",")) {
      throw new Error(`${entityType} field registry differs from lib/vocab.ts`)
    }
  }
}

/**
 * A URL in comparable form: scheme dropped (http ≡ https), host lowercased
 * without `www.`, no fragment, no trailing slash. For agreement checks and
 * de-duplication only — the stored value is the URL as observed.
 */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim()
  const match = /^(?:https?:)?\/\/([^/?#]+)([^#]*)/i.exec(trimmed)
  if (!match) return trimmed.toLowerCase()
  const host = match[1].toLowerCase().replace(/^www\./, "")
  const rest = match[2].replace(/\/+$/, "").replace(/\/(?=\?)/, "")
  return `${host}${rest}`
}

/** The host a source URL belongs to, for counting independent sources. */
export function hostOf(raw: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(raw.trim())
  return match ? match[1].toLowerCase().replace(/^www\./, "") : raw.trim().toLowerCase()
}
