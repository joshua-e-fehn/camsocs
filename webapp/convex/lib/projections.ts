import { type Infer, v } from "convex/values"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  CLAIM_METHODS,
  COLLEGE_BODIES,
  EMAIL_TYPES,
  EVENT_ORGANISER_ROLES,
  EVENT_SOURCES,
  EVENT_STATUSES,
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  EVIDENCE_KINDS,
  FIELD_STATUSES,
  GENDER_CATEGORIES,
  INTERNAL_SOURCE_TYPES,
  MAILING_LIST_PLATFORMS,
  MISSING_REASONS,
  ORG_LEVELS,
  ORG_STATUSES,
  ORG_TYPES,
  RELATIONSHIP_TYPES,
  SOURCE_TYPES,
  TERM_SCOPES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { classifyEmail } from "./derived"
import {
  chatChannelValidator,
  isHttpUrl,
  membershipValidator,
  priceValidator,
  registrationsValidator,
  roleEmailValidator,
  socialValidator,
  speakerValidator,
  sportValidator,
  trialsValidator,
} from "./fields"
import type { FieldMeta } from "./resolve"
import { literalUnion } from "./validators"

/**
 * The public projection (docs/data-model.md §7): what any visitor may see,
 * and the validators that make it the *return type* of every public query —
 * so the webapp gets exact types and nothing internal can slip into a result
 * without failing validation.
 *
 * Removed or reduced on the way out:
 *  - every internal table (orgInternal, fieldClaims, sources, broker data) —
 *    never read by these functions;
 *  - `meta.sourceUrl` from internal sources (`mailing_list_email`, `manual`)
 *    or that is not an http(s) URL, and conflict readings from them;
 *  - a `personal_crsid` email (a person's address, not the society's), its
 *    conflict readings, and personal role emails;
 *  - the mailing list's address (sign-up only);
 *  - stored files become URLs; their storage ids and source URLs stay inside.
 */

// --- meta ---------------------------------------------------------------------------------

export const publicFieldMetaValidator = v.object({
  status: literalUnion(FIELD_STATUSES),
  evidence: v.optional(literalUnion(EVIDENCE_KINDS)),
  missingReason: v.optional(literalUnion(MISSING_REASONS)),
  confidence: v.optional(v.number()),
  sourceUrl: v.optional(v.string()),
  sourceType: v.optional(literalUnion(SOURCE_TYPES)),
  retrievedAt: v.optional(v.number()),
  method: v.optional(literalUnion(CLAIM_METHODS)),
  claimCount: v.optional(v.number()),
  conflicts: v.optional(
    v.array(
      v.object({
        value: v.any(),
        sourceUrl: v.optional(v.string()),
        sourceType: literalUnion(SOURCE_TYPES),
        retrievedAt: v.number(),
        method: literalUnion(CLAIM_METHODS),
      }),
    ),
  ),
})
export type PublicFieldMeta = Infer<typeof publicFieldMetaValidator>

export const publicMetaValidator = v.record(v.string(), publicFieldMetaValidator)

const isInternalSource = (sourceType: string | undefined) =>
  sourceType !== undefined && (INTERNAL_SOURCE_TYPES as readonly string[]).includes(sourceType)

function publicSourceUrl(sourceUrl: string | undefined, sourceType: string | undefined) {
  if (sourceUrl === undefined || isInternalSource(sourceType) || !isHttpUrl(sourceUrl)) {
    return undefined
  }
  return sourceUrl
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = record
  return rest
}

const isPersonalEmail = (value: unknown) =>
  typeof value === "string" && classifyEmail(value) === "personal_crsid"

/** One field's meta, safe to show. `field` decides which values are personal. */
export function publicFieldMeta(field: string, meta: FieldMeta): PublicFieldMeta {
  const conflicts = meta.conflicts
    ?.filter((reading) => !isInternalSource(reading.sourceType))
    .filter((reading) => !(field === "email" && isPersonalEmail(reading.value)))
    .map((reading) => ({
      value:
        field === "mailingList" && reading.value && typeof reading.value === "object"
          ? withoutKey(reading.value as Record<string, unknown>, "address")
          : reading.value,
      sourceUrl: publicSourceUrl(reading.sourceUrl, reading.sourceType),
      sourceType: reading.sourceType,
      retrievedAt: reading.retrievedAt,
      method: reading.method,
    }))
  // A conflict whose other readings are all private is no conflict to this
  // viewer: show the displayed value's own status (an `inferred` value stays
  // `inferred`). Meta written before `winnerStatus` existed falls back to the
  // confidence band: an inferred winner never reaches 0.75 (data-model §1.1).
  const status =
    meta.status === "conflicting" && conflicts?.length === 0
      ? (meta.winnerStatus ?? ((meta.confidence ?? 0) < 0.75 ? "inferred" : "found"))
      : meta.status
  return {
    status,
    evidence: meta.evidence,
    missingReason: meta.missingReason,
    confidence: meta.confidence,
    sourceUrl: publicSourceUrl(meta.sourceUrl, meta.sourceType),
    sourceType: meta.sourceType,
    retrievedAt: meta.retrievedAt,
    method: meta.method,
    claimCount: meta.claimCount,
    ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
  }
}

export function publicMeta(meta: Record<string, FieldMeta>): Record<string, PublicFieldMeta> {
  return Object.fromEntries(
    Object.entries(meta).map(([field, entry]) => [field, publicFieldMeta(field, entry)]),
  )
}

async function fileUrl(ctx: QueryCtx, storageId: Doc<"storedFiles">["storageId"] | undefined) {
  return storageId ? ((await ctx.storage.getUrl(storageId)) ?? undefined) : undefined
}

// --- organisations ----------------------------------------------------------------------------

export const orgCardPublicValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  shortName: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  orgType: v.optional(literalUnion(ORG_TYPES)),
  level: v.optional(literalUnion(ORG_LEVELS)),
  status: literalUnion(ORG_STATUSES),
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
  logoUrl: v.optional(v.string()),
})
export type OrgCardPublic = Infer<typeof orgCardPublicValidator>

export async function orgCardPublic(ctx: QueryCtx, card: Doc<"orgCards">): Promise<OrgCardPublic> {
  return {
    key: card.key,
    slug: card.slug,
    name: card.name,
    shortName: card.shortName,
    shortDescription: card.shortDescription,
    orgType: card.orgType,
    level: card.level,
    status: card.status,
    collegeKeys: card.collegeKeys,
    categories: card.categories,
    activityTypes: card.activityTypes,
    audiences: card.audiences,
    beginnerFriendly: card.beginnerFriendly,
    sport: card.sport,
    logoUrl: await fileUrl(ctx, card.logoStorageId),
  }
}

export const orgPublicValidator = v.object({
  key: v.string(),
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
  status: literalUnion(ORG_STATUSES),
  lastActiveAt: v.optional(v.number()),
  registrations: registrationsValidator,
  categories: v.array(literalUnion(CATEGORIES)),
  activityTypes: v.array(literalUnion(ACTIVITY_TYPES)),
  audiences: v.array(literalUnion(AUDIENCES)),
  languages: v.array(v.string()),
  tags: v.array(v.string()),
  suCategory: v.optional(v.string()),
  department: v.optional(v.string()),
  logo: v.optional(v.object({ url: v.string(), credit: v.optional(v.string()) })),
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
  /** Absent when the only address is a personal one (CRSid). */
  email: v.optional(v.string()),
  emailType: v.optional(literalUnion(EMAIL_TYPES)),
  roleEmails: v.array(roleEmailValidator),
  contactFormUrl: v.optional(v.string()),
  /** Sign-up only; the list address is not shown. */
  mailingList: v.optional(
    v.object({
      platform: v.optional(literalUnion(MAILING_LIST_PLATFORMS)),
      signupUrl: v.optional(v.string()),
    }),
  ),
  socials: v.array(socialValidator),
  chatChannels: v.array(chatChannelValidator),
  /** Tracked fields still missing — "help us complete this listing". */
  missingFields: v.array(v.string()),
  /** Per-field provenance for the `SourceLine` under every fact. */
  meta: publicMetaValidator,
  updatedAt: v.number(),
})
export type OrgPublic = Infer<typeof orgPublicValidator>

export async function orgPublic(ctx: QueryCtx, org: Doc<"organisations">): Promise<OrgPublic> {
  const meta = publicMeta(org.meta)
  const personal = org.email !== undefined && org.emailType === "personal_crsid"
  if (personal) meta.email = { status: "missing", missingReason: "not_published" }
  const logoUrl = await fileUrl(ctx, org.logo?.storageId)
  return {
    key: org.key,
    slug: org.slug,
    name: org.name,
    aliases: org.aliases,
    shortName: org.shortName,
    orgType: org.orgType,
    level: org.level,
    collegeKeys: org.collegeKeys,
    collegeBody: org.collegeBody,
    parentKey: org.parentKey,
    isCounterpart: org.isCounterpart,
    status: org.status,
    lastActiveAt: org.lastActiveAt,
    registrations: org.registrations,
    categories: org.categories,
    activityTypes: org.activityTypes,
    audiences: org.audiences,
    languages: org.languages,
    tags: org.tags,
    suCategory: org.suCategory,
    department: org.department,
    logo: logoUrl ? { url: logoUrl, credit: org.logo?.credit } : undefined,
    shortDescription: org.shortDescription,
    description: org.description,
    howToJoin: org.howToJoin,
    joinUrl: org.joinUrl,
    membership: org.membership,
    beginnerFriendly: org.beginnerFriendly,
    trials: org.trials,
    timeCommitment: org.timeCommitment,
    termcardUrl: org.termcardUrl,
    accessibilityNote: org.accessibilityNote,
    sport: org.sport,
    website: org.website,
    email: personal ? undefined : org.email,
    emailType: personal ? undefined : org.emailType,
    roleEmails: org.roleEmails.filter((entry) => !isPersonalEmail(entry.email)),
    contactFormUrl: org.contactFormUrl,
    mailingList:
      org.mailingList && (org.mailingList.platform || org.mailingList.signupUrl)
        ? { platform: org.mailingList.platform, signupUrl: org.mailingList.signupUrl }
        : undefined,
    socials: org.socials,
    chatChannels: org.chatChannels,
    missingFields: org.missingFields,
    meta,
    updatedAt: org.updatedAt,
  }
}

// --- teams, sessions, venues --------------------------------------------------------------------

export const teamPublicValidator = v.object({
  key: v.string(),
  name: v.string(),
  rank: v.optional(v.number()),
  gender: v.optional(literalUnion(GENDER_CATEGORIES)),
  league: v.optional(v.string()),
  memberCollegeKeys: v.array(v.string()),
  meta: publicMetaValidator,
})

export function teamPublic(team: Doc<"teams">): Infer<typeof teamPublicValidator> {
  return {
    key: team.key,
    name: team.name,
    rank: team.rank,
    gender: team.gender,
    league: team.league,
    memberCollegeKeys: team.memberCollegeKeys,
    meta: publicMeta(team.meta),
  }
}

export const sessionPublicValidator = v.object({
  key: v.string(),
  title: v.string(),
  dayOfWeek: v.optional(v.number()),
  startTime: v.optional(v.string()),
  endTime: v.optional(v.string()),
  venueKey: v.optional(v.string()),
  venueText: v.optional(v.string()),
  termScope: v.optional(literalUnion(TERM_SCOPES)),
  note: v.optional(v.string()),
  meta: publicMetaValidator,
})

export function sessionPublic(session: Doc<"sessions">): Infer<typeof sessionPublicValidator> {
  return {
    key: session.key,
    title: session.title,
    dayOfWeek: session.dayOfWeek,
    startTime: session.startTime,
    endTime: session.endTime,
    venueKey: session.venueKey,
    venueText: session.venueText,
    termScope: session.termScope,
    note: session.note,
    meta: publicMeta(session.meta),
  }
}

export const venuePublicValidator = v.object({
  key: v.string(),
  name: v.string(),
  aliases: v.array(v.string()),
  address: v.optional(v.string()),
  collegeKey: v.optional(v.string()),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
})

export function venuePublic(venue: Doc<"venues">): Infer<typeof venuePublicValidator> {
  return {
    key: venue.key,
    name: venue.name,
    aliases: venue.aliases,
    address: venue.address,
    collegeKey: venue.collegeKey,
    lat: venue.lat,
    lng: venue.lng,
  }
}

// --- events -----------------------------------------------------------------------------------

export const orgRefValidator = v.object({ key: v.string(), slug: v.string(), name: v.string() })
export type OrgRef = Infer<typeof orgRefValidator>

export const eventPublicValidator = v.object({
  key: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  allDay: v.boolean(),
  termWeekLabel: v.optional(v.string()),
  venueKey: v.optional(v.string()),
  venueText: v.optional(v.string()),
  /** Organisations that exist in the directory, with their role. */
  organisers: v.array(
    v.object({
      key: v.string(),
      slug: v.string(),
      name: v.string(),
      role: literalUnion(EVENT_ORGANISER_ROLES),
    }),
  ),
  speakers: v.array(speakerValidator),
  price: v.optional(priceValidator),
  bookingUrl: v.optional(v.string()),
  signupRequired: v.optional(v.boolean()),
  visibility: literalUnion(EVENT_VISIBILITIES),
  eventType: literalUnion(EVENT_TYPES),
  imageUrl: v.optional(v.string()),
  cancelled: v.boolean(),
  status: literalUnion(EVENT_STATUSES),
  source: literalUnion(EVENT_SOURCES),
  /** Absent for mailing-list events (the source is a private inbox). */
  sourceUrl: v.optional(v.string()),
  lastSeenAt: v.number(),
  confidence: v.number(),
  meta: publicMetaValidator,
})
export type EventPublic = Infer<typeof eventPublicValidator>

/** Looks organisations up by key, once each, for the duration of a query. */
export function orgRefCache(ctx: QueryCtx) {
  const cache = new Map<string, Promise<Doc<"orgCards"> | null>>()
  return (key: string) => {
    let hit = cache.get(key)
    if (!hit) {
      hit = ctx.db
        .query("orgCards")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
      cache.set(key, hit)
    }
    return hit
  }
}

export async function eventPublic(
  ctx: QueryCtx,
  event: Doc<"events">,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<EventPublic> {
  const roles = [
    ...event.organiserKeys.map((key) => ({ key, role: "organiser" as const })),
    ...event.coHostKeys.map((key) => ({ key, role: "co_host" as const })),
    ...event.sponsorKeys.map((key) => ({ key, role: "sponsor" as const })),
  ]
  const organisers = []
  for (const { key, role } of roles) {
    const card = await lookup(key)
    if (card) organisers.push({ key: card.key, slug: card.slug, name: card.name, role })
  }
  const internalSource = event.source === "mailing_list"
  return {
    key: event.key,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    termWeekLabel: event.termWeekLabel,
    venueKey: event.venueKey,
    venueText: event.venueText,
    organisers,
    speakers: event.speakers,
    price: event.price,
    bookingUrl: event.bookingUrl,
    signupRequired: event.signupRequired,
    visibility: event.visibility,
    eventType: event.eventType,
    imageUrl: await fileUrl(ctx, event.image?.storageId),
    cancelled: event.cancelled,
    status: event.status,
    source: event.source,
    sourceUrl: internalSource || !isHttpUrl(event.sourceUrl) ? undefined : event.sourceUrl,
    lastSeenAt: event.lastSeenAt,
    confidence: event.confidence,
    meta: publicMeta(event.meta),
  }
}

// --- relationships ----------------------------------------------------------------------------

export const relationshipPublicValidator = v.object({
  key: v.string(),
  type: literalUnion(RELATIONSHIP_TYPES),
  /** `outgoing`: this organisation is `fromKey` (e.g. it sponsors the counterpart). */
  direction: v.union(v.literal("outgoing"), v.literal("incoming")),
  counterpart: orgRefValidator,
  lastSeenAt: v.number(),
  confidence: v.number(),
  evidence: v.array(v.object({ sourceUrl: v.string(), seenAt: v.number() })),
})
export type RelationshipPublic = Infer<typeof relationshipPublicValidator>
