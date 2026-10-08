import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { londonMidnight } from "../lib/calendar"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { londonIsoDate } from "./lib/derived"
import { withdrawnCheck } from "./lib/entityStore"
import { isHttpUrl } from "./lib/fields"
import { facetCounts, matches, orgFiltersValidator, selections } from "./lib/orgFilters"
import {
  type EventPublic,
  eventPublic,
  eventPublicValidator,
  orgCardPublic,
  orgCardPublicValidator,
  orgPublic,
  orgPublicValidator,
  orgRefCache,
  orgRefValidator,
  type RelationshipPublic,
  relationshipPublicValidator,
  sessionPublic,
  sessionPublicValidator,
  teamPublic,
  teamPublicValidator,
} from "./lib/projections"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * The public directory (docs/webapp.md "Public API"). Every function returns
 * the public projection only (convex/lib/projections.ts) and is safe for a
 * signed-out caller.
 */

/** More cards than this is a directory an order of magnitude past plan; the
 * scan stops rather than reading an unbounded table. */
const MAX_CARDS = 5_000
/** Convex's maximum result set for one full-text search query (docs:
 * production/state/limits). The directory holds fewer listings than this; a
 * query that fills it says so (`facets.truncated`). */
const MAX_SEARCH_RESULTS = 1_024
const MAX_PAGE_SIZE = 100
const MAX_QUERY_LENGTH = 200

/** Candidate cards: search-ranked for a query, else every listed card by name. */
async function candidates(ctx: QueryCtx, q: string | undefined): Promise<Doc<"orgCards">[]> {
  const text = q?.trim().slice(0, MAX_QUERY_LENGTH)
  if (text) {
    return await ctx.db
      .query("orgCards")
      .withSearchIndex("search_text", (s) =>
        s.search("searchText", text).eq("isCounterpart", false),
      )
      .take(MAX_SEARCH_RESULTS)
  }
  return await ctx.db
    .query("orgCards")
    .withIndex("by_isCounterpart_nameSort", (i) => i.eq("isCounterpart", false))
    .take(MAX_CARDS)
}

/**
 * One page of directory cards matching the filters — name order, or search
 * relevance when `q` is given. Works with `usePaginatedQuery`; the cursor is
 * an offset into the filtered list.
 */
export const list = query({
  args: { ...orgFiltersValidator, paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(orgCardPublicValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { paginationOpts, ...filters } = args
    const selected = selections(filters)
    const matching = (await candidates(ctx, filters.q)).filter((card) => matches(card, selected))
    const offset = Math.max(0, Number.parseInt(paginationOpts.cursor ?? "0", 10) || 0)
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(paginationOpts.numItems) || 1))
    const slice = matching.slice(offset, offset + size)
    const end = offset + slice.length
    return {
      page: await Promise.all(slice.map((card) => orgCardPublic(ctx, card))),
      isDone: end >= matching.length,
      continueCursor: String(end),
    }
  },
})

const counts = v.record(v.string(), v.number())

/** Counts per facet value under the same filters (disjunctive: each facet
 * ignores its own selection). `total` is the number `list` would return. */
export const facets = query({
  args: orgFiltersValidator,
  returns: v.object({
    total: v.number(),
    categories: counts,
    levels: counts,
    orgTypes: counts,
    collegeKeys: counts,
    activityTypes: counts,
    audiences: counts,
    statuses: counts,
    blueStatus: counts,
    gender: counts,
    beginnerFriendly: counts,
    /** True when a search matched more listings than one query can return:
     * the counts then cover the best-ranked `MAX_SEARCH_RESULTS` only. */
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const cards = await candidates(ctx, args.q)
    const truncated = Boolean(args.q?.trim()) && cards.length >= MAX_SEARCH_RESULTS
    return { ...facetCounts(cards, args), truncated }
  },
})

/** The colleges, for the college filter: key, slug and name, by name. */
export const colleges = query({
  args: {},
  returns: v.array(orgRefValidator),
  handler: async (ctx) => {
    const cards = await ctx.db
      .query("orgCards")
      .withIndex("by_orgType", (i) => i.eq("orgType", "college"))
      .take(200)
    return cards
      .sort((a, b) => a.nameSort.localeCompare(b.nameSort))
      .map((card) => ({ key: card.key, slug: card.slug, name: card.name }))
  },
})

const UPCOMING_EVENTS = 50

/**
 * One organisation's page: its public projection (with per-field `meta` for
 * the SourceLine), teams, regular sessions, upcoming events the viewer may
 * see (public; `cam_only` too for a verified @cam.ac.uk viewer), and its
 * public relationships with the counterpart's name. Null when no such slug,
 * or when the broker has hidden the listing.
 */
export const getBySlug = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      org: orgPublicValidator,
      teams: v.array(teamPublicValidator),
      sessions: v.array(sessionPublicValidator),
      events: v.array(eventPublicValidator),
      relationships: v.array(relationshipPublicValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organisations")
      .withIndex("by_slug", (i) => i.eq("slug", args.slug))
      .unique()
    // Hidden by the broker after a remove / object request: as if absent.
    if (!org || org.hidden === true) return null

    const [teams, sessions] = await Promise.all([
      ctx.db
        .query("teams")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
        .take(100),
      ctx.db
        .query("sessions")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
        .take(100),
    ])

    const viewer = await getViewer(ctx)
    const tiers = visibleEventTiers(viewer)
    // From the start of today (London), so an event later today still shows,
    // plus multi-day events that began earlier and are still running.
    const from = londonMidnight(londonIsoDate(Date.now()))
    const [running, upcoming] = await Promise.all([
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_spanEndsAt", (i) => i.eq("orgKey", org.key).gt("spanEndsAt", from))
        .take(UPCOMING_EVENTS),
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (i) => i.eq("orgKey", org.key).gte("startsAt", from))
        .take(UPCOMING_EVENTS * 3),
    ])
    const links = [...running.filter((link) => link.startsAt < from), ...upcoming]
    const lookup = orgRefCache(ctx)
    const withdrawn = withdrawnCheck(ctx, Date.now())
    const events: EventPublic[] = []
    const seen = new Set<string>()
    for (const link of links) {
      if (events.length >= UPCOMING_EVENTS) break
      if (seen.has(link.eventKey) || !tiers.includes(link.visibility as never)) continue
      seen.add(link.eventKey)
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (i) => i.eq("key", link.eventKey))
        .unique()
      if (event && tiers.includes(event.visibility as never) && !(await withdrawn(event))) {
        events.push(await eventPublic(ctx, event, lookup))
      }
    }

    return {
      org: await orgPublic(ctx, org),
      teams: teams.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map(teamPublic),
      sessions: sessions
        .sort(
          (a, b) =>
            (a.dayOfWeek ?? 7) - (b.dayOfWeek ?? 7) ||
            (a.startTime ?? "").localeCompare(b.startTime ?? ""),
        )
        .map(sessionPublic),
      events,
      relationships: await publicRelationships(ctx, org.key, lookup),
    }
  },
})

async function publicRelationships(
  ctx: QueryCtx,
  orgKey: string,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<RelationshipPublic[]> {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query("relationships")
      .withIndex("by_from", (i) => i.eq("fromKey", orgKey))
      .take(200),
    ctx.db
      .query("relationships")
      .withIndex("by_to", (i) => i.eq("toKey", orgKey))
      .take(200),
  ])
  const out: RelationshipPublic[] = []
  for (const [edges, direction] of [
    [outgoing, "outgoing"],
    [incoming, "incoming"],
  ] as const) {
    for (const edge of edges) {
      if (edge.visibility !== "public") continue
      const counterpart = await lookup(direction === "outgoing" ? edge.toKey : edge.fromKey)
      if (!counterpart) continue
      out.push({
        key: edge.key,
        type: edge.type,
        direction,
        counterpart: { key: counterpart.key, slug: counterpart.slug, name: counterpart.name },
        lastSeenAt: edge.lastSeenAt,
        confidence: edge.confidence,
        // Only links a visitor can follow; event keys stay inside (the
        // event may be in a tier this viewer cannot see).
        evidence: edge.evidence
          .filter((entry) => isHttpUrl(entry.sourceUrl))
          .map(({ sourceUrl, seenAt }) => ({ sourceUrl, seenAt })),
      })
    }
  }
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}
