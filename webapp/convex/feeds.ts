import { v } from "convex/values"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import { internalMutation, mutation, query } from "./_generated/server"
import { orgRefCache } from "./lib/projections"

/**
 * Personal calendar feeds from the Finder (ENG-129). A feed is a random id
 * and the listings it follows; `/events.ics?f=<id>` serves their public
 * events. Whoever holds the edit token (kept only in the browser that made
 * the feed) can change the list. Nothing here identifies a person: no
 * account, no e-mail, no IP. The id is unguessable (128 bits) and the token
 * is stored only as a SHA-256 hash.
 */

/** Most listings one feed may follow. */
export const MAX_FEED_ORGS = 40

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/** `n` random characters from a-z0-9 (crypto, ~5.2 bits each). */
function randomId(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The listed organisations among `orgKeys`, once each, at most the cap. */
async function listedKeys(
  ctx: QueryCtx | MutationCtx,
  orgKeys: readonly string[],
): Promise<string[]> {
  const lookup = orgRefCache(ctx)
  const out: string[] = []
  for (const key of new Set(orgKeys)) {
    if (out.length >= MAX_FEED_ORGS) break
    if (key.length <= 120 && (await lookup(key))) out.push(key)
  }
  return out
}

async function byFeedId(ctx: QueryCtx | MutationCtx, feedId: string) {
  return await ctx.db
    .query("calendarFeeds")
    .withIndex("by_feedId", (i) => i.eq("feedId", feedId))
    .unique()
}

/** A new feed following these listings; returns its id and edit token. */
export const create = mutation({
  args: { orgKeys: v.array(v.string()) },
  returns: v.object({ feedId: v.string(), editToken: v.string(), orgKeys: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const orgKeys = await listedKeys(ctx, args.orgKeys.slice(0, 200))
    if (orgKeys.length === 0) throw new Error("Follow at least one listed society.")
    const feedId = randomId(25)
    const editToken = randomId(32)
    const now = Date.now()
    await ctx.db.insert("calendarFeeds", {
      feedId,
      editTokenHash: await sha256(editToken),
      orgKeys,
      createdAt: now,
      updatedAt: now,
    })
    return { feedId, editToken, orgKeys }
  },
})

/** Replace a feed's listings; needs its edit token. */
export const update = mutation({
  args: { feedId: v.string(), editToken: v.string(), orgKeys: v.array(v.string()) },
  returns: v.object({ orgKeys: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const feed = await byFeedId(ctx, args.feedId)
    if (!feed || feed.editTokenHash !== (await sha256(args.editToken)))
      throw new Error("This feed cannot be changed from here.")
    const orgKeys = await listedKeys(ctx, args.orgKeys.slice(0, 200))
    await ctx.db.patch(feed._id, { orgKeys, updatedAt: Date.now() })
    return { orgKeys }
  },
})

/** A feed's followed listings (key, slug, name), or null for an unknown id. */
export const get = query({
  args: { feedId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ orgs: v.array(v.object({ key: v.string(), slug: v.string(), name: v.string() })) }),
  ),
  handler: async (ctx, args) => {
    const feed = await byFeedId(ctx, args.feedId)
    if (!feed) return null
    const lookup = orgRefCache(ctx)
    const orgs = []
    for (const key of feed.orgKeys) {
      const ref = await lookup(key)
      if (ref) orgs.push({ key, slug: ref.slug, name: ref.name })
    }
    return { orgs }
  },
})

/** Note that a calendar app read the feed (at most once an hour is written). */
export const touch = mutation({
  args: { feedId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const feed = await byFeedId(ctx, args.feedId)
    const now = Date.now()
    if (feed && (feed.lastFetchedAt ?? 0) < now - 3_600_000) {
      await ctx.db.patch(feed._id, { lastFetchedAt: now })
    }
    return null
  },
})

/** A feed no calendar app has read for this long is deleted (/privacy). */
export const FEED_RETENTION_MS = 365 * 86_400_000

/** Daily: delete feeds unused for a year (created and never read counts from creation). */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - FEED_RETENTION_MS
    let deleted = 0
    for (const feed of await ctx.db.query("calendarFeeds").take(2000)) {
      if ((feed.lastFetchedAt ?? feed.createdAt) < cutoff) {
        await ctx.db.delete(feed._id)
        deleted += 1
      }
    }
    return deleted
  },
})
