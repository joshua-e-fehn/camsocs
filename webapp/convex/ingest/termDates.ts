import { v } from "convex/values"
import { TERMS } from "../../lib/vocab"
import { internal } from "../_generated/api"
import { internalMutation } from "../_generated/server"
import { isHttpUrl } from "../lib/fields"
import { assertBatchSize, emptyBatchResult, recordBatch, upsertRow } from "../lib/ingest"
import { literalUnion } from "../lib/validators"

/**
 * `POST /api/pipeline/termDates` — Full Term dates, upserted by
 * (academicYear, term). Seeded by the pipeline from the University's
 * published dates (source-research §19). A change re-labels events'
 * `termWeekLabel` in the background (convex/derive.ts).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ACADEMIC_YEAR = /^\d{4}-\d{2}$/

export const upsert = internalMutation({
  args: {
    terms: v.array(
      v.object({
        academicYear: v.string(),
        term: literalUnion(TERMS),
        fullTermStart: v.string(),
        fullTermEnd: v.string(),
        sourceUrl: v.string(),
      }),
    ),
  },
  returns: v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    assertBatchSize(args.terms.length, "terms")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const term of args.terms) {
      if (!ACADEMIC_YEAR.test(term.academicYear)) {
        throw new Error(`academicYear must look like 2026-27: ${term.academicYear}`)
      }
      if (!ISO_DATE.test(term.fullTermStart) || !ISO_DATE.test(term.fullTermEnd)) {
        throw new Error("Full Term dates must be YYYY-MM-DD")
      }
      if (term.fullTermEnd <= term.fullTermStart)
        throw new Error("Full Term must end after it starts")
      if (!isHttpUrl(term.sourceUrl)) throw new Error("sourceUrl must be http(s)")
      const existing = await ctx.db
        .query("termDates")
        .withIndex("by_year_term", (q) =>
          q.eq("academicYear", term.academicYear).eq("term", term.term),
        )
        .unique()
      const { outcome } = await upsertRow(ctx, "termDates", existing, term, now, {
        touchUpdatedAt: true,
      })
      recordBatch(result, outcome)
    }
    if (result.inserted + result.updated > 0) {
      await ctx.scheduler.runAfter(0, internal.derive.recomputeEvents, {})
    }
    return result
  },
})
