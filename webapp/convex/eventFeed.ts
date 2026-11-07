import { v } from "convex/values"
import { londonMidnight } from "../lib/calendar"
import { query } from "./_generated/server"
import { hostsListed, isTalksDerived } from "./events"
import { londonIsoDate } from "./lib/derived"
import { withdrawnCheck } from "./lib/entityStore"
import { orgRefCache } from "./lib/projections"
import { loadSuppressedEvents } from "./lib/suppressions"

/**
 * The newest events the site lists (event indexing, 2026-11-07): what the
 * Atom feed `/events.atom` and the "Newly listed" links on /events carry, so
 * a search engine learns of a new event's page the day it is harvested
 * rather than when it next walks the whole events sitemap.
 *
 * The same pages the events sitemap lists (`sitemap.events`): public, from
 * today on or a multi-day event still running, never withdrawn, superseded,
 * suppressed, hosted only by hidden organisations or talks.cam-derived
 * (owner decision G1); and not cancelled, since a feed of new listings has
 * no use for one. Newest first by when the event was first stored, which is
 * the only date here a harvest never moves.
 *
 * Public reads of public facts only: the key, title, times and first host.
 */

/** Events read, newest first: a harvest stores at most a few hundred at once,
 * many of them past or Cambridge-only, and the feed wants the recent ones. */
const SCAN = 500
/** At most this many in one answer. */
const MAX_LIMIT = 100
/** Only events first stored this recently are "new". */
export const FEED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

const feedEvent = v.object({
  key: v.string(),
  title: v.string(),
  startsAt: v.number(),
  allDay: v.boolean(),
  /** When the event was first stored (its `_creationTime`). */
  listedAt: v.number(),
  /** The first listed organiser's name; absent for the University's own. */
  host: v.optional(v.string()),
  fromUniversity: v.boolean(),
})

export const newest = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(feedEvent),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit ?? MAX_LIMIT) || 1))
    const now = Date.now()
    const today = londonMidnight(londonIsoDate(now))
    const since = now - FEED_WINDOW_MS
    const recent = await ctx.db.query("events").order("desc").take(SCAN)
    const lookup = orgRefCache(ctx)
    const withdrawn = withdrawnCheck(ctx, now)
    const removed = await loadSuppressedEvents(ctx)
    const out: (typeof feedEvent.type)[] = []
    for (const event of recent) {
      if (out.length >= limit || event._creationTime < since) break
      if (event.visibility !== "public" || event.cancelled) continue
      const running = event.spanEndsAt !== undefined && event.spanEndsAt > now
      if (event.startsAt < today && !running) continue
      if (removed.has(event.key) || isTalksDerived(event)) continue
      if (!(await hostsListed(event, lookup)) || (await withdrawn(event))) continue
      let host: string | undefined
      for (const key of event.organiserKeys) {
        const card = await lookup(key)
        if (card) {
          host = card.name
          break
        }
      }
      out.push({
        key: event.key,
        title: event.title,
        startsAt: event.startsAt,
        allDay: event.allDay,
        listedAt: event._creationTime,
        ...(host ? { host } : {}),
        fromUniversity: event.stream === "university",
      })
    }
    return out
  },
})
