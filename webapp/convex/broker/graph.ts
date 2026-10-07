import { v } from "convex/values"
import { complementaryMatches, type MatchOrg } from "../../lib/broker/matching"
import {
  NEED_OFFER_ITEMS,
  ORG_TYPES,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_VISIBILITIES,
} from "../../lib/vocab"
import type { QueryCtx } from "../_generated/server"
import { query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { literalUnion } from "../lib/validators"

/**
 * The organisation graph for the broker: every relationship edge (public and
 * internal), and "who could meet whom" — complementary needs and offers
 * (lib/broker/matching.ts).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

/** Edges are small (a few sightings each); this keeps one read well under
 * Convex's per-function limit. `relationships` reports `truncated`. */
const MAX_EDGES = 3_000
const MAX_PROFILES = 3_000
const MAX_CARDS = 5_000

/** Names and categories of every organisation that has a card, plus any
 * hidden ones `keys` asks for (they have no card). */
async function orgIndex(ctx: QueryCtx, keys: Iterable<string>) {
  const cards = await ctx.db.query("orgCards").take(MAX_CARDS)
  const index = new Map<
    string,
    MatchOrg & { slug: string; orgType?: (typeof ORG_TYPES)[number]; isCounterpart: boolean }
  >()
  for (const card of cards) {
    index.set(card.key, {
      key: card.key,
      slug: card.slug,
      name: card.name,
      categories: card.categories,
      orgType: card.orgType,
      isCounterpart: card.isCounterpart,
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
        orgType: org.orgType,
        isCounterpart: org.isCounterpart,
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
