import { v } from "convex/values"
import {
  addCoverageRow,
  type CoverageCounts,
  emptyCoverage,
  finishCoverage,
} from "../lib/broker/coverage"
import { internal } from "./_generated/api"
import { internalMutation, internalQuery } from "./_generated/server"
import { coverageRowOf } from "./lib/brokerRows"
import { coverageCountsValidator } from "./schema"

/**
 * Directory coverage, computed on the server (lib/broker/coverage.ts defines
 * the counts).
 *
 * No transaction may read every organisation row (~10 KB each with
 * descriptions and per-field meta; Convex limits a function's reads), so
 * `recompute` folds them a page at a time, each page a scheduled mutation
 * carrying the running counts to the next, and the last writes the one
 * `coverageSnapshots` row the broker overview reads. It runs after every
 * pipeline run that wrote data (convex/runs.ts `finish`), daily
 * (convex/crons.ts), and on the broker's request
 * (`broker.overview.refreshCoverage`).
 *
 * `page` and `eventsPage` are the same fold, a page per call, for the
 * pipeline's coverage report (`POST /api/pipeline/coverage`,
 * `…/coverage/events`; `camsocs harvest`), which sums the pages itself.
 */

/** Organisation rows per page (~1 MB read). */
export const ORG_PAGE = 100
/** Event rows per page (events are smaller). */
const EVENT_PAGE = 500

export const recompute = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    counts: v.optional(coverageCountsValidator),
    rows: v.optional(v.number()),
    startedAt: v.optional(v.number()),
  },
  returns: v.object({ done: v.boolean(), rows: v.number() }),
  handler: async (ctx, args) => {
    const startedAt = args.startedAt ?? Date.now()
    const counts: CoverageCounts = args.counts ?? emptyCoverage()
    const page = await ctx.db
      .query("organisations")
      .paginate({ numItems: ORG_PAGE, cursor: args.cursor ?? null })
    for (const org of page.page) addCoverageRow(counts, coverageRowOf(org))
    const rows = (args.rows ?? 0) + page.page.length
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.coverage.recompute, {
        cursor: page.continueCursor,
        counts,
        rows,
        startedAt,
      })
      return { done: false, rows }
    }
    const snapshot = {
      scope: "directory" as const,
      stats: finishCoverage(counts),
      rows,
      startedAt,
      computedAt: Date.now(),
    }
    const existing = await ctx.db
      .query("coverageSnapshots")
      .withIndex("by_scope", (q) => q.eq("scope", "directory"))
      .first()
    // Two walks may overlap (a run finishing during the daily one): the one
    // that started later wins.
    if (!existing) await ctx.db.insert("coverageSnapshots", snapshot)
    else if (existing.startedAt <= startedAt) {
      await ctx.db.replace("coverageSnapshots", existing._id, snapshot)
    }
    return { done: true, rows }
  },
})

const cursorArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  limit: v.optional(v.number()),
}

function clamp(limit: number | undefined, ceiling: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return ceiling
  return Math.max(1, Math.min(ceiling, Math.floor(limit)))
}

/** One page of organisations folded into coverage counts. */
export const page = internalQuery({
  args: cursorArgs,
  returns: v.object({
    counts: coverageCountsValidator,
    rows: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("organisations")
      .paginate({ numItems: clamp(args.limit, ORG_PAGE), cursor: args.cursor ?? null })
    const counts = emptyCoverage()
    for (const org of result.page) addCoverageRow(counts, coverageRowOf(org))
    return {
      counts,
      rows: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})

const tally = v.record(v.string(), v.number())

/** One page of events starting at or after `from`, counted by source and
 * visibility (cancelled ones apart). */
export const eventsPage = internalQuery({
  args: { from: v.number(), ...cursorArgs },
  returns: v.object({
    bySource: tally,
    byVisibility: tally,
    cancelled: v.number(),
    rows: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("events")
      .withIndex("by_startsAt", (q) => q.gte("startsAt", args.from))
      .paginate({ numItems: clamp(args.limit, EVENT_PAGE), cursor: args.cursor ?? null })
    const bySource: Record<string, number> = {}
    const byVisibility: Record<string, number> = {}
    let cancelled = 0
    for (const event of result.page) {
      if (event.cancelled) {
        cancelled++
        continue
      }
      bySource[event.source] = (bySource[event.source] ?? 0) + 1
      byVisibility[event.visibility] = (byVisibility[event.visibility] ?? 0) + 1
    }
    return {
      bySource,
      byVisibility,
      cancelled,
      rows: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})
