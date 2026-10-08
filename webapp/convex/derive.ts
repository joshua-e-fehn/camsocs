import { v } from "convex/values"
import { spanEndOf } from "../lib/calendar"
import { internal } from "./_generated/api"
import { internalMutation } from "./_generated/server"
import { londonIsoDate, sweepGroupOf, termWeekLabel } from "./lib/derived"
import { loadTerms, refreshOrganisation, syncEventOrganiserRows } from "./lib/entityStore"

/**
 * Derived fields that depend on the clock or on other tables (data-model §6),
 * recomputed in the background. On ingest, convex/ingest/claims.ts derives
 * the touched entity directly; these catch what time alone changes:
 *
 *  - an organisation's `status` turns `dormant` 180 days after its last
 *    activity, and registrations lapse at the academic-year boundary;
 *  - events' `termWeekLabel` changes when `termDates` change (and their
 *    `spanEndsAt` is kept current, also for rows written before it existed);
 *  - a person's `stale` flag turns on when `staleAfter` passes.
 *
 * Each walk is paginated and reschedules itself, so no transaction reads a
 * whole table. `daily` (convex/crons.ts) starts all three.
 */

const ORG_PAGE = 100
const EVENT_PAGE = 300
const PEOPLE_PAGE = 500

const pageResult = v.object({ processed: v.number(), changed: v.number(), done: v.boolean() })

export const recomputeOrganisations = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: pageResult,
  handler: async (ctx, args) => {
    const now = Date.now()
    const terms = await loadTerms(ctx)
    const page = await ctx.db
      .query("organisations")
      .paginate({ numItems: ORG_PAGE, cursor: args.cursor ?? null })
    let changed = 0
    for (const org of page.page) {
      if (await refreshOrganisation(ctx, org, { now, terms })) changed++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.derive.recomputeOrganisations, {
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, changed, done: page.isDone }
  },
})

export const recomputeEvents = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: pageResult,
  handler: async (ctx, args) => {
    const terms = await loadTerms(ctx)
    const page = await ctx.db
      .query("events")
      .paginate({ numItems: EVENT_PAGE, cursor: args.cursor ?? null })
    let changed = 0
    for (const event of page.page) {
      const label = termWeekLabel(event.startsAt, terms)
      const spanEndsAt = spanEndOf(event.startsAt, event.endsAt)
      const sweepGroup = sweepGroupOf(event.source, event.meta.externalId?.sourceUrl)
      if (
        label === event.termWeekLabel &&
        spanEndsAt === event.spanEndsAt &&
        sweepGroup === event.sweepGroup
      ) {
        continue
      }
      await ctx.db.patch("events", event._id, { termWeekLabel: label, spanEndsAt, sweepGroup })
      await syncEventOrganiserRows(ctx, { ...event, spanEndsAt })
      changed++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.derive.recomputeEvents, {
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, changed, done: page.isDone }
  },
})

/** Flags people whose `staleAfter` date has passed (London date). */
export const flagStalePeople = internalMutation({
  args: {},
  returns: pageResult,
  handler: async (ctx) => {
    const today = londonIsoDate(Date.now())
    const due = await ctx.db
      .query("people")
      .withIndex("by_stale_staleAfter", (q) => q.eq("stale", false).lt("staleAfter", today))
      .take(PEOPLE_PAGE)
    for (const person of due) {
      await ctx.db.patch("people", person._id, { stale: true, updatedAt: Date.now() })
    }
    const done = due.length < PEOPLE_PAGE
    if (!done) await ctx.scheduler.runAfter(0, internal.derive.flagStalePeople, {})
    return { processed: due.length, changed: due.length, done }
  },
})

/** The daily cron's entry point: starts each walk. */
export const daily = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.derive.recomputeOrganisations, {})
    await ctx.scheduler.runAfter(0, internal.derive.recomputeEvents, {})
    await ctx.scheduler.runAfter(0, internal.derive.flagStalePeople, {})
    return null
  },
})
