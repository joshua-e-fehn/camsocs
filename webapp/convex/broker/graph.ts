import { v } from "convex/values"
import {
  buildEcosystem,
  campusId,
  DEFAULT_LAYERS,
  ECOSYSTEM_LAYERS,
  type EcosystemEvent,
} from "../../lib/broker/ecosystem"
import { complementaryMatches, type MatchOrg } from "../../lib/broker/matching"
import {
  NEED_OFFER_ITEMS,
  ORG_TYPES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_VISIBILITIES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { academicYearOf } from "../lib/derived"
import { loadSuppressionIndex } from "../lib/suppressions"
import { literalUnion } from "../lib/validators"

/**
 * The organisation graph for the broker: every relationship edge (public and
 * internal), the ecosystem map's layers over it (co-hosting, sponsors,
 * outreach; lib/broker/ecosystem.ts), and "who could meet whom" —
 * complementary needs and offers (lib/broker/matching.ts).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

/** Edges are small (a few sightings each); this keeps one read well under
 * Convex's per-function limit. `relationships` reports `truncated`. */
const MAX_EDGES = 3_000
const MAX_PROFILES = 3_000
const MAX_CARDS = 5_000

/** Names, categories and audiences of every organisation that has a card,
 * plus any hidden ones `keys` asks for (they have no card, so `hidden`). */
async function orgIndex(ctx: QueryCtx, keys: Iterable<string>) {
  const cards = await ctx.db.query("orgCards").take(MAX_CARDS)
  const index = new Map<
    string,
    MatchOrg & {
      slug: string
      orgType?: (typeof ORG_TYPES)[number]
      isCounterpart: boolean
      audiences: readonly string[]
      hidden: boolean
    }
  >()
  for (const card of cards) {
    index.set(card.key, {
      key: card.key,
      slug: card.slug,
      name: card.name,
      categories: card.categories,
      audiences: card.audiences,
      orgType: card.orgType,
      isCounterpart: card.isCounterpart,
      hidden: false,
    })
  }
  for (const key of keys) {
    if (index.has(key)) continue
    const org = await ctx.db
      .query("organisations")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    if (org) {
      index.set(key, {
        key,
        slug: org.slug,
        name: org.name,
        categories: org.categories,
        audiences: org.audiences,
        orgType: org.orgType,
        isCounterpart: org.isCounterpart,
        hidden: org.hidden === true,
      })
    }
  }
  return index
}

export const relationships = query({
  args: { types: v.optional(v.array(literalUnion(RELATIONSHIP_TYPES))) },
  returns: v.object({
    nodes: v.array(
      v.object({
        key: v.string(),
        slug: v.optional(v.string()),
        name: v.string(),
        orgType: v.optional(literalUnion(ORG_TYPES)),
        isCounterpart: v.boolean(),
        degree: v.number(),
      }),
    ),
    edges: v.array(
      v.object({
        key: v.string(),
        from: v.string(),
        to: v.string(),
        type: literalUnion(RELATIONSHIP_TYPES),
        visibility: literalUnion(RELATIONSHIP_VISIBILITIES),
        confidence: v.number(),
        evidenceCount: v.number(),
        lastSeenAt: v.number(),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const wanted = args.types?.length ? new Set<string>(args.types) : null
    const all = await ctx.db.query("relationships").take(MAX_EDGES + 1)
    const truncated = all.length > MAX_EDGES
    const rows = all.slice(0, MAX_EDGES).filter((edge) => !wanted || wanted.has(edge.type))
    const degree = new Map<string, number>()
    for (const edge of rows) {
      degree.set(edge.fromKey, (degree.get(edge.fromKey) ?? 0) + 1)
      degree.set(edge.toKey, (degree.get(edge.toKey) ?? 0) + 1)
    }
    const index = await orgIndex(ctx, degree.keys())
    return {
      nodes: [...degree.entries()].map(([key, count]) => {
        const org = index.get(key)
        return {
          key,
          slug: org?.slug,
          name: org?.name ?? key,
          orgType: org?.orgType,
          isCounterpart: org?.isCounterpart ?? false,
          degree: count,
        }
      }),
      edges: rows.map((edge) => ({
        key: edge.key,
        from: edge.fromKey,
        to: edge.toKey,
        type: edge.type,
        visibility: edge.visibility,
        confidence: edge.confidence,
        evidenceCount: edge.evidence.length,
        lastSeenAt: edge.lastSeenAt,
      })),
      truncated,
    }
  },
})

const item = literalUnion(NEED_OFFER_ITEMS)

/** "Who could meet whom": complementary needs and offers, best first. */
export const matches = query({
  args: {},
  returns: v.array(
    v.object({
      needKey: v.string(),
      needName: v.string(),
      offerKey: v.string(),
      offerName: v.string(),
      need: item,
      kind: v.union(v.literal("offer"), v.literal("past_sponsor")),
      offer: v.optional(item),
      sponsoredKey: v.optional(v.string()),
      sponsoredName: v.optional(v.string()),
      sharedCategories: v.array(v.string()),
      score: v.number(),
    }),
  ),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const profiles = await ctx.db.query("orgBrokerProfiles").take(MAX_PROFILES)
    const sponsorEdges: { fromKey: string; toKey: string }[] = []
    for (const edge of await ctx.db.query("relationships").take(MAX_EDGES)) {
      if (edge.type === "sponsors") sponsorEdges.push({ fromKey: edge.fromKey, toKey: edge.toKey })
    }
    const keys = new Set([
      ...profiles.map((profile) => profile.orgKey),
      ...sponsorEdges.flatMap((edge) => [edge.fromKey, edge.toKey]),
    ])
    const index = await orgIndex(ctx, keys)
    return complementaryMatches(profiles, index, sponsorEdges)
  },
})

// --- the ecosystem map ------------------------------------------------------------------

/** Co-hosting looks back over this many academic years (the current one
 * included); `eventOrganisers` has no role index, so the window bounds the
 * scan. */
const COHOST_YEARS = 3
/** Organiser rows scanned per visibility, newest first. */
const MAX_ORGANISER_ROWS = { public: 4_000, cam_only: 1_000 } as const
/** Whole events read, under separate budgets: the window's co-hosted ones,
 * and those relationship sightings name (a sighting whose event was not read
 * does not count, lib/broker/ecosystem.ts). */
const MAX_COHOST_EVENTS = 500
const MAX_EVIDENCE_EVENTS = 500
const MAX_PEOPLE = 5_000
const MAX_INTERACTIONS = 2_000
const MAX_INTRODUCTIONS = 1_000

const ecosystemLayer = literalUnion(ECOSYSTEM_LAYERS)
const edgeVisibility = literalUnion(RELATIONSHIP_VISIBILITIES)

/** The co-hosting window: the first academic year's starting calendar year
 * (years turn over on 1 July, `academicYearOf`) and an instant a day before it
 * for the index scan, so no London offset loses an event. The scan's rows are
 * then kept only when `academicYearOf` puts them in the window. */
function cohostWindow(now: number, years: number): { firstYear: number; scanFrom: number } {
  const firstYear = Number(academicYearOf(now).slice(0, 4)) - (years - 1)
  return { firstYear, scanFrom: Date.UTC(firstYear, 5, 30) }
}

/** Reads `limit + 1` rows and reports whether the limit cut them off. */
function capped<T>(rows: T[], limit: number): { rows: T[]; over: boolean } {
  return { rows: rows.slice(0, limit), over: rows.length > limit }
}

function asEcosystemEvent(event: Doc<"events">): EcosystemEvent {
  return {
    key: event.key,
    startsAt: event.startsAt,
    academicYear: academicYearOf(event.startsAt),
    visibility: event.visibility,
    hosting: event.hosting,
    cancelled: event.cancelled,
    supersededBy: event.supersededBy,
    source: event.source,
    sourceUrl: event.sourceUrl,
    externalUrl: event.externalUrl,
    bookingUrl: event.bookingUrl,
    description: event.description,
    meta: event.meta,
    organisers: [
      ...event.organiserKeys.map((orgKey) => ({ orgKey, role: "organiser" as const })),
      ...event.coHostKeys.map((orgKey) => ({ orgKey, role: "co_host" as const })),
      ...event.sponsorKeys.map((orgKey) => ({ orgKey, role: "sponsor" as const })),
    ],
  }
}

/**
 * The ecosystem map (lib/broker/ecosystem.ts): the requested layers over the
 * organisations, with node ids `${campus}:${key}`. People appear only as a
 * count per organisation; sensitive societies are flagged; hidden and
 * suppressed listings stay out of every layer but `relationships`; nothing
 * read from talks.cam counts (a sighting whose event was not read does not
 * count either). Co-hosting counts only the events of the last
 * `COHOST_YEARS` academic years, whatever other layers are on. `truncated`
 * says a read stopped at its limit: relationships, organiser rows, events,
 * profiles, interactions, introductions or people.
 */
export const ecosystem = query({
  args: {
    layers: v.optional(v.array(ecosystemLayer)),
    types: v.optional(v.array(literalUnion(RELATIONSHIP_TYPES))),
  },
  returns: v.object({
    campus: v.string(),
    layers: v.array(ecosystemLayer),
    nodes: v.array(
      v.object({
        id: v.string(),
        key: v.string(),
        slug: v.optional(v.string()),
        name: v.string(),
        orgType: v.optional(v.string()),
        isCounterpart: v.boolean(),
        hidden: v.boolean(),
        sensitive: v.boolean(),
        people: v.number(),
        interactions: v.number(),
        lastInteractionAt: v.optional(v.number()),
        degree: v.number(),
      }),
    ),
    edges: v.array(
      v.object({
        id: v.string(),
        from: v.string(),
        to: v.string(),
        layer: ecosystemLayer,
        type: v.string(),
        visibility: edgeVisibility,
        weight: v.number(),
        lastSeenAt: v.optional(v.number()),
        years: v.array(v.object({ academicYear: v.string(), count: v.number() })),
        status: v.optional(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const campus = campusId(process.env.CAMSOCS_CAMPUS)
    const layers = new Set(args.layers?.length ? args.layers : DEFAULT_LAYERS)
    let truncated = false
    const suppressions = await loadSuppressionIndex(ctx)

    const relationships: Doc<"relationships">[] = []
    if (layers.has("relationships") || layers.has("sponsors")) {
      const all = await ctx.db.query("relationships").take(MAX_EDGES + 1)
      truncated ||= all.length > MAX_EDGES
      relationships.push(...all.slice(0, MAX_EDGES))
    }

    // Whole events, each looked up once (`null`: no such event). A
    // suppressed event is never read, so a sighting naming it does not count.
    const read = new Map<string, EcosystemEvent | null>()
    const readEvents = async (keys: Iterable<string>, limit: number) => {
      const wanted = new Set<string>()
      let lookups = 0
      for (const key of keys) {
        if (suppressions.events.has(key)) continue
        if (!read.has(key)) {
          if (lookups === limit) {
            truncated = true
            break
          }
          lookups += 1
          const event = await ctx.db
            .query("events")
            .withIndex("by_key", (q) => q.eq("key", key))
            .unique()
          read.set(key, event ? asEcosystemEvent(event) : null)
        }
        wanted.add(key)
      }
      return wanted
    }

    // Those relationship sightings name, so a sighting of a talks.cam-derived
    // event is judged by it.
    const evidenceKeys = new Set<string>()
    for (const edge of relationships) {
      for (const evidence of edge.evidence) {
        if (evidence.eventKey) evidenceKeys.add(evidence.eventKey)
      }
    }
    await readEvents(evidenceKeys, MAX_EVIDENCE_EVENTS)

    // The window's co-hosted events: the only ones the cohosting layer counts.
    let cohostEventKeys = new Set<string>()
    if (layers.has("cohosting")) {
      const { firstYear, scanFrom } = cohostWindow(Date.now(), COHOST_YEARS)
      const keys = new Set<string>()
      for (const visibility of ["public", "cam_only"] as const) {
        const limit = MAX_ORGANISER_ROWS[visibility]
        const scan = capped(
          await ctx.db
            .query("eventOrganisers")
            .withIndex("by_visibility_startsAt", (q) =>
              q.eq("visibility", visibility).gte("startsAt", scanFrom),
            )
            .order("desc")
            .take(limit + 1),
          limit,
        )
        truncated ||= scan.over
        for (const row of scan.rows) {
          if (row.role === "organiser" || row.hosting === "takes_part") continue
          if (row.cancelled || row.superseded) continue
          if (Number(academicYearOf(row.startsAt).slice(0, 4)) < firstYear) continue
          keys.add(row.eventKey)
        }
      }
      cohostEventKeys = await readEvents(keys, MAX_COHOST_EVENTS)
    }
    const events = [...read.values()].filter((event) => event !== null)

    const take = async <T>(rows: Promise<T[]>, limit: number) => {
      const result = capped(await rows, limit)
      truncated ||= result.over
      return result.rows
    }
    const profiles = layers.has("sponsors")
      ? await take(ctx.db.query("orgBrokerProfiles").take(MAX_PROFILES + 1), MAX_PROFILES)
      : []
    const interactions = layers.has("outreach")
      ? await take(
          ctx.db
            .query("interactions")
            .withIndex("by_date")
            .order("desc")
            .take(MAX_INTERACTIONS + 1),
          MAX_INTERACTIONS,
        )
      : []
    const introductions = layers.has("outreach")
      ? await take(
          ctx.db
            .query("introductions")
            .withIndex("by_date")
            .order("desc")
            .take(MAX_INTRODUCTIONS + 1),
          MAX_INTRODUCTIONS,
        )
      : []
    const people = await take(ctx.db.query("people").take(MAX_PEOPLE + 1), MAX_PEOPLE)

    const keys = new Set<string>()
    for (const edge of relationships) keys.add(edge.fromKey).add(edge.toKey)
    for (const event of events) for (const { orgKey } of event.organisers) keys.add(orgKey)
    for (const profile of profiles) {
      keys.add(profile.orgKey)
      for (const key of profile.pastSponsorKeys) keys.add(key)
    }
    // A party is its organisation, or its person's (people are never nodes).
    const personOrg = new Map(people.map((person) => [person.key, person.orgKey]))
    for (const party of [
      ...interactions,
      ...introductions.flatMap((intro) => [intro.partyA, intro.partyB]),
    ]) {
      const key = party.orgKey ?? (party.personKey ? personOrg.get(party.personKey) : undefined)
      if (key) keys.add(key)
    }

    const map = buildEcosystem({
      campus,
      layers: [...layers],
      types: args.types,
      orgs: await orgIndex(ctx, keys),
      suppressedOrgs: suppressions.organisations,
      relationships,
      events,
      cohostEventKeys,
      judgedEventKeys: new Set(read.keys()),
      profiles,
      interactions,
      introductions,
      people,
      suppressedPeople: suppressions.people,
    })
    return { ...map, truncated }
  },
})
