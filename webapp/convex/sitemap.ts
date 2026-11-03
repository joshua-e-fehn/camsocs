import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { londonMidnight } from "../lib/calendar"
import { query } from "./_generated/server"
import { hostsListed, isTalksDerived } from "./events"
import { londonIsoDate } from "./lib/derived"
import { withdrawnCheck } from "./lib/entityStore"
import { orgRefCache } from "./lib/projections"
import { loadSuppressedEvents } from "./lib/suppressions"

/**
 * What the events sitemap lists (app/sitemaps/[file]; SEO audit
 * "events-orphaned-no-sitemap", "sitemap-dynamic-no-lastmod"): page by page,
 * so no read is near Convex's limits, with each page's last change. The
 * society profiles and hubs come from `orgs.sitemap`, which judges a thin
 * profile (G3) on the projection the page renders.
 *
 * Public reads of public facts only: a slug or key and when it last changed.
 */

/** Rows read per page: a page's documents stay well inside a query's limits. */
const MAX_PAGE = 200
/** Multi-day public events still running today: few at any time. */
const MAX_SPANNING = 200

const eventPage = v.object({
  page: v.array(v.object({ key: v.string(), updatedAt: v.number() })),
  isDone: v.boolean(),
  continueCursor: v.string(),
})

/** A page size within `MAX_PAGE`. */
function pageSize(numItems: number): number {
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(numItems) || 1))
}

/**
 * The public events whose pages the sitemap lists: from the start of today
 * (London) on, plus multi-day events still running (on the first page), each
 * with when it last changed. Ended events drop out by themselves (owner
 * decision G4). Never a Cambridge-only, withdrawn or suppressed event, one
 * whose hosts are all hidden, or a talks.cam-derived one (owner decision G1:
 * its page is under /talks).
 */
export const events = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: eventPage,
  handler: async (ctx, args) => {
    const now = Date.now()
    const from = londonMidnight(londonIsoDate(now))
    const result = await ctx.db
      .query("events")
      .withIndex("by_visibility_startsAt", (i) =>
        i.eq("visibility", "public").gte("startsAt", from),
      )
      .paginate({ ...args.paginationOpts, numItems: pageSize(args.paginationOpts.numItems) })
    const candidates = [...result.page]
    if (args.paginationOpts.cursor === null) {
      const spanning = await ctx.db
        .query("events")
        .withIndex("by_visibility_spanEndsAt", (i) =>
          i.eq("visibility", "public").gt("spanEndsAt", now),
        )
        .take(MAX_SPANNING)
      candidates.push(...spanning.filter((event) => event.startsAt < from))
    }
    const lookup = orgRefCache(ctx)
    const withdrawn = withdrawnCheck(ctx, now)
    const removed = await loadSuppressedEvents(ctx)
    const page: { key: string; updatedAt: number }[] = []
    for (const event of candidates) {
      if (removed.has(event.key) || isTalksDerived(event)) continue
      if (!(await hostsListed(event, lookup)) || (await withdrawn(event))) continue
      page.push({ key: event.key, updatedAt: event.updatedAt })
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor }
  },
})
