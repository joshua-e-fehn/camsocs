import { v } from "convex/values"
import {
  EVENT_SOURCES,
  EVENT_VISIBILITIES,
  INTRODUCTION_STATUSES,
  LISTING_REQUEST_KINDS,
} from "../../lib/vocab"
import { query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { DAY_MS, londonIsoDate } from "../lib/derived"
import { harvestRunFields } from "../schema"

/**
 * The broker overview's counters that are cheap to compute on the server:
 * events in the next 14 days by source, the latest pipeline runs, open
 * listing requests, due follow-ups, stale people and introductions by status.
 * Directory coverage (organisations by level / status, field shares) comes
 * from the organisation rows the dashboard already loads (`orgs.page`,
 * lib/broker/coverage.ts). There is no quarantine count: identity
 * resolution's quarantine is not stored in Convex.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const EVENT_WINDOW_DAYS = 14
const MAX_EVENTS = 2_000
const MAX_COUNT = 1_000

const counts = v.record(v.string(), v.number())

export const summary = query({
  args: {},
  returns: v.object({
    events: v.object({
      total: v.number(),
      truncated: v.boolean(),
      bySource: counts,
      byVisibility: counts,
    }),
    runs: v.array(v.object(harvestRunFields)),
    openRequests: v.object({ total: v.number(), byKind: counts }),
    followUpsDue: v.number(),
    stalePeople: v.number(),
    introductions: counts,
  }),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const now = Date.now()
    const today = londonIsoDate(now)

    const events = await ctx.db
      .query("events")
      .withIndex("by_startsAt", (q) =>
        q.gte("startsAt", now).lt("startsAt", now + EVENT_WINDOW_DAYS * DAY_MS),
      )
      .take(MAX_EVENTS + 1)
    const bySource: Record<string, number> = Object.fromEntries(EVENT_SOURCES.map((s) => [s, 0]))
    const byVisibility: Record<string, number> = Object.fromEntries(
      EVENT_VISIBILITIES.map((s) => [s, 0]),
    )
    for (const event of events.slice(0, MAX_EVENTS)) {
      if (event.cancelled) continue
      bySource[event.source]++
      byVisibility[event.visibility]++
    }

    const runs = await ctx.db.query("harvestRuns").withIndex("by_startedAt").order("desc").take(8)

    const open = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "open"))
      .take(MAX_COUNT)
    const byKind: Record<string, number> = Object.fromEntries(
      LISTING_REQUEST_KINDS.map((k) => [k, 0]),
    )
    for (const request of open) byKind[request.kind]++

    const followUps = await ctx.db
      .query("interactions")
      .withIndex("by_followUpOn", (q) => q.gt("followUpOn", "").lte("followUpOn", today))
      .take(MAX_COUNT)
    const stale = await ctx.db
      .query("people")
      .withIndex("by_stale_staleAfter", (q) => q.eq("stale", true))
      .take(MAX_COUNT)
    const introductions: Record<string, number> = {}
    for (const status of INTRODUCTION_STATUSES) {
      const rows = await ctx.db
        .query("introductions")
        .withIndex("by_status_date", (q) => q.eq("status", status))
        .take(MAX_COUNT)
      introductions[status] = rows.length
    }

    return {
      events: {
        total: Math.min(events.length, MAX_EVENTS),
        truncated: events.length > MAX_EVENTS,
        bySource,
        byVisibility,
      },
      runs: runs.map(({ _id, _creationTime, ...run }) => run),
      openRequests: { total: open.length, byKind },
      followUpsDue: followUps.length,
      stalePeople: stale.filter((person) => !person.archived).length,
      introductions,
    }
  },
})
