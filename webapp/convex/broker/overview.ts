import { v } from "convex/values"
import {
  EVENT_SOURCES,
  EVENT_VISIBILITIES,
  INTRODUCTION_STATUSES,
  LISTING_REQUEST_KINDS,
} from "../../lib/vocab"
import { internal } from "../_generated/api"
import { mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { DAY_MS, londonIsoDate } from "../lib/derived"
import { coverageStatsValidator, harvestRunFields } from "../schema"

/**
 * The broker overview, computed on the server: events in the next 14 days by
 * source, the latest pipeline runs, open listing requests, due follow-ups,
 * stale people, introductions by status, the directory coverage (the latest
 * `coverageSnapshots` row, folded over every organisation a page at a time
 * by convex/coverage.ts — never in the browser) and the identity-resolution
 * quarantine (the counts the pipeline's resolve stage reported with its
 * latest run, `metrics`; the cases themselves are in the pipeline's
 * var/reports/quarantine.json).
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const EVENT_WINDOW_DAYS = 14
const MAX_EVENTS = 1_000
const MAX_COUNT = 1_000

const counts = v.record(v.string(), v.number())

/** Runs searched for the latest resolve stage's quarantine counts. */
const QUARANTINE_RUNS = 20

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
    coverage: v.union(
      v.null(),
      v.object({ stats: coverageStatsValidator, rows: v.number(), computedAt: v.number() }),
    ),
    quarantine: v.union(
      v.null(),
      v.object({
        held: v.number(),
        dropped: v.number(),
        review: v.number(),
        runKey: v.string(),
        startedAt: v.number(),
      }),
    ),
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

    const recent = await ctx.db
      .query("harvestRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(QUARANTINE_RUNS)
    const runs = recent.slice(0, 8)
    let quarantine = null
    for (const run of recent) {
      const metrics = run.stages.find((stage) => stage.name === "resolve")?.metrics
      if (metrics?.quarantineHeld === undefined) continue
      quarantine = {
        held: metrics.quarantineHeld,
        dropped: metrics.quarantineDropped ?? 0,
        review: metrics.quarantineReview ?? 0,
        runKey: run.runKey,
        startedAt: run.startedAt,
      }
      break
    }
    const snapshot = await ctx.db
      .query("coverageSnapshots")
      .withIndex("by_scope", (q) => q.eq("scope", "directory"))
      .first()

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
      coverage: snapshot
        ? { stats: snapshot.stats, rows: snapshot.rows, computedAt: snapshot.computedAt }
        : null,
      quarantine,
    }
  },
})

/** Recomputes the directory coverage now (it also runs after every pipeline
 * run and daily); the overview updates when the walk finishes. */
export const refreshCoverage = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    await ctx.scheduler.runAfter(0, internal.coverage.recompute, {})
    return null
  },
})
