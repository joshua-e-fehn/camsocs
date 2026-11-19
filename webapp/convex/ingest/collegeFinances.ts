import { v } from "convex/values"
import wealth from "../../lib/data/college-wealth.json"
import { internalMutation } from "../_generated/server"
import { isHttpUrl } from "../lib/fields"
import {
  assertBatchSize,
  emptyBatchResult,
  type IngestFields,
  recordBatch,
  sameContent,
  upsertRow,
} from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { COLLEGE_FINANCE_STATUSES } from "../schema"

/**
 * `POST /api/pipeline/collegeFinances` — the colleges' endowment, net assets
 * and income from the Charity Commission register (stage `college_finances`,
 * source-research §22), upserted by (charityNumber, periodEnd). Rows are never
 * deleted: the register keeps five years, the site keeps what it was sent.
 *
 * Only the 31 colleges of lib/data/college-wealth.json are accepted, each
 * under its own key. A re-read that changes nothing but when the extract was
 * read (`retrievedAt`, `source.extractModified`) refreshes those quietly and
 * counts as unchanged, so `updatedAt` moves only when a figure, a status or a
 * citation does.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Far above any college (Trinity's investments are about £2.7bn). */
const MAX_GBP = 100_000_000_000

/** Charity number → college key (`org-<slug>`). */
export const COLLEGE_CHARITIES: ReadonlyMap<string, string> = new Map(
  wealth.colleges.map((college) => [college.charityNumber, `org-${college.slug}`]),
)

const financeValidator = v.object({
  charityNumber: v.string(),
  collegeKey: v.string(),
  periodEnd: v.string(),
  endowmentGbp: v.optional(v.number()),
  netAssetsGbp: v.optional(v.number()),
  incomeGbp: v.optional(v.number()),
  status: literalUnion(COLLEGE_FINANCE_STATUSES),
  checks: v.array(v.string()),
  source: v.object({
    extractUrl: v.string(),
    extractModified: v.optional(v.number()),
    registerUrl: v.string(),
    overrideCitation: v.optional(
      v.object({ url: v.string(), page: v.string(), reason: v.string() }),
    ),
  }),
  retrievedAt: v.number(),
})

type Finance = IngestFields<"collegeFinances">

function validate(row: Finance): void {
  const expected = COLLEGE_CHARITIES.get(row.charityNumber)
  if (expected === undefined) throw new Error(`Not a college charity: ${row.charityNumber}`)
  if (row.collegeKey !== expected) {
    throw new Error(`Charity ${row.charityNumber} is ${expected}, not ${row.collegeKey}`)
  }
  if (!ISO_DATE.test(row.periodEnd) || Number.isNaN(Date.parse(row.periodEnd))) {
    throw new Error(`periodEnd must be YYYY-MM-DD: ${row.periodEnd}`)
  }
  for (const [name, value] of [
    ["endowmentGbp", row.endowmentGbp],
    ["netAssetsGbp", row.netAssetsGbp],
    ["incomeGbp", row.incomeGbp],
  ] as const) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_GBP) {
      throw new Error(`${name} must be whole pounds: ${value}`)
    }
  }
  if (row.status === "needs_review" && row.checks.length === 0) {
    throw new Error("A needs_review row must say why (checks)")
  }
  if (row.status === "override" && row.source.overrideCitation === undefined) {
    throw new Error("An override must cite the accounts page")
  }
  for (const url of [
    row.source.extractUrl,
    row.source.registerUrl,
    row.source.overrideCitation?.url,
  ]) {
    if (url !== undefined && !isHttpUrl(url)) throw new Error(`Not an http(s) URL: ${url}`)
  }
  if (!Number.isFinite(row.retrievedAt) || row.retrievedAt <= 0) {
    throw new Error("retrievedAt must be epoch ms")
  }
}

/** The row with every figure's key present: a figure the latest return no
 * longer states is removed from the stored row (a patch with `undefined`),
 * never kept stale. */
function withFigures(row: Finance): Finance {
  return {
    ...row,
    endowmentGbp: row.endowmentGbp,
    netAssetsGbp: row.netAssetsGbp,
    incomeGbp: row.incomeGbp,
  }
}

/** What a reader sees: everything but when the extract was read. */
function content(row: Finance): Record<string, unknown> {
  const { retrievedAt: _read, source, ...rest } = withFigures(row)
  const { extractModified: _modified, ...kept } = source
  return { ...rest, source: kept }
}

export const upsert = internalMutation({
  args: { finances: v.array(financeValidator) },
  returns: v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    assertBatchSize(args.finances.length, "finances")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const row of args.finances) validate(row)
    for (const row of args.finances) {
      const existing = await ctx.db
        .query("collegeFinances")
        .withIndex("by_charity_period", (q) =>
          q.eq("charityNumber", row.charityNumber).eq("periodEnd", row.periodEnd),
        )
        .unique()
      if (existing && sameContent(content(existing), content(row))) {
        // Only the read stamps moved: refresh them, not `updatedAt`.
        if (
          existing.retrievedAt !== row.retrievedAt ||
          existing.source.extractModified !== row.source.extractModified
        ) {
          await ctx.db.patch(existing._id, { retrievedAt: row.retrievedAt, source: row.source })
        }
        recordBatch(result, "unchanged")
        continue
      }
      const fields = existing ? withFigures(row) : row
      const { outcome } = await upsertRow(ctx, "collegeFinances", existing, fields, now, {
        touchUpdatedAt: true,
      })
      recordBatch(result, outcome)
    }
    return result
  },
})
