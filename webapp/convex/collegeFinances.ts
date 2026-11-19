import { v } from "convex/values"
import {
  type CollegeHistory,
  completeYears,
  financialYearOf,
  nextFinancialYear,
  yearProgress,
} from "../lib/college-finances"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { COLLEGE_CHARITIES } from "./ingest/collegeFinances"
import { literalUnion } from "./lib/validators"
import { COLLEGE_FINANCE_STATUSES } from "./schema"

/**
 * The colleges' register finances (public; source-research §22): the
 * history behind /colleges/wealth's trend, and which financial year is
 * complete. Written by the pipeline (`convex/ingest/collegeFinances.ts`);
 * the page's year rule is `lib/college-finances.ts`.
 */

/** Far above 31 colleges × the years the site will ever hold. */
const MAX_ROWS = 2000

const COLLEGE_KEYS: readonly string[] = [...COLLEGE_CHARITIES.values()]

/** Oldest first; past the cap the oldest periods drop, never the newest. */
async function allRows(ctx: QueryCtx): Promise<Doc<"collegeFinances">[]> {
  const newestFirst = await ctx.db
    .query("collegeFinances")
    .withIndex("by_periodEnd")
    .order("desc")
    .take(MAX_ROWS)
  return newestFirst.reverse()
}

function histories(rows: readonly Doc<"collegeFinances">[]): CollegeHistory[] {
  const byCollege = new Map<string, CollegeHistory>()
  for (const key of COLLEGE_KEYS)
    byCollege.set(key, { collegeKey: key, periods: [], needsReview: 0 })
  for (const row of rows) {
    const college = byCollege.get(row.collegeKey)
    if (!college) continue
    if (row.status === "needs_review") {
      college.needsReview++
      college.periods.push({ periodEnd: row.periodEnd, status: row.status })
      continue
    }
    college.periods.push({
      periodEnd: row.periodEnd,
      status: row.status,
      ...(row.endowmentGbp !== undefined ? { endowmentGbp: row.endowmentGbp } : {}),
      ...(row.netAssetsGbp !== undefined ? { netAssetsGbp: row.netAssetsGbp } : {}),
      ...(row.incomeGbp !== undefined ? { incomeGbp: row.incomeGbp } : {}),
    })
  }
  return [...byCollege.values()]
}

const periodValidator = v.object({
  periodEnd: v.string(),
  endowmentGbp: v.optional(v.number()),
  netAssetsGbp: v.optional(v.number()),
  incomeGbp: v.optional(v.number()),
  status: literalUnion(COLLEGE_FINANCE_STATUSES),
})

/** Every college's periods, oldest first. A `needs_review` period is listed
 * without its figures and counted in `needsReview`. */
export const history = query({
  args: {},
  returns: v.array(
    v.object({
      collegeKey: v.string(),
      periods: v.array(periodValidator),
      needsReview: v.number(),
    }),
  ),
  handler: async (ctx) => histories(await allRows(ctx)),
})

const progressValidator = v.object({
  financialYear: v.string(),
  filed: v.number(),
  needsReview: v.number(),
  total: v.number(),
})

/**
 * The newest financial year ("2024-25") in which all 31 colleges have an
 * accepted row, or null; the next year's filings so far; and when the data
 * last changed (`updatedAt`) and was last read (`retrievedAt`), epoch ms.
 */
export const latestCompleteYear = query({
  args: {},
  returns: v.object({
    financialYear: v.union(v.string(), v.null()),
    colleges: v.number(),
    next: v.union(progressValidator, v.null()),
    updatedAt: v.union(v.number(), v.null()),
    retrievedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const rows = await allRows(ctx)
    const all = histories(rows)
    const [financialYear = null] = completeYears(all, COLLEGE_KEYS)
    const newest = rows[rows.length - 1]
    const nextYear =
      financialYear !== null
        ? nextFinancialYear(financialYear)
        : newest
          ? financialYearOf(newest.periodEnd)
          : null
    return {
      financialYear,
      colleges: COLLEGE_KEYS.length,
      next: nextYear === null ? null : yearProgress(all, COLLEGE_KEYS, nextYear),
      updatedAt: rows.length ? Math.max(...rows.map((row) => row.updatedAt)) : null,
      retrievedAt: rows.length ? Math.max(...rows.map((row) => row.retrievedAt)) : null,
    }
  },
})
