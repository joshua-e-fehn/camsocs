import { describe, expect, test } from "bun:test"
import wealth from "../lib/data/college-wealth.json"
import { api, internal } from "./_generated/api"
import { COLLEGE_CHARITIES } from "./ingest/collegeFinances"
import { newTest, type TestConvex } from "./lib/harness.testing"

/**
 * `collegeFinances` (source-research §22): the pipeline's upsert of the
 * register's figures, and the public history and complete-year queries
 * behind /colleges/wealth. Figures here are synthetic.
 */

const EXTRACT =
  "https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/publicextract.charity_annual_return_partb.zip"
const READ = Date.UTC(2026, 10, 19, 12)

const colleges = wealth.colleges.map((college) => ({
  charityNumber: college.charityNumber,
  collegeKey: `org-${college.slug}`,
}))

type Status = "register" | "override" | "needs_review"

function finance(
  college: { charityNumber: string; collegeKey: string },
  periodEnd: string,
  overrides: Partial<{
    endowmentGbp: number
    netAssetsGbp: number
    incomeGbp: number
    status: Status
    checks: string[]
    retrievedAt: number
    extractModified: number
  }> = {},
) {
  const {
    status = "register",
    checks = [],
    retrievedAt = READ,
    extractModified,
    ...figures
  } = overrides
  return {
    ...college,
    periodEnd,
    endowmentGbp: 100_000_000,
    netAssetsGbp: 150_000_000,
    incomeGbp: 10_000_000,
    ...figures,
    status,
    checks,
    source: {
      extractUrl: EXTRACT,
      registerUrl: `https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/${college.charityNumber}`,
      ...(extractModified === undefined ? {} : { extractModified }),
      ...(status === "override"
        ? {
            overrideCitation: {
              url: "https://files.opencharities.uk/ew/1/accounts.pdf",
              page: "PDF p.1",
              reason: "test",
            },
          }
        : {}),
    },
    retrievedAt,
  }
}

async function post(t: TestConvex, finances: ReturnType<typeof finance>[]) {
  return await t.mutation(internal.ingest.collegeFinances.upsert, { finances })
}

describe("ingest/collegeFinances.upsert", () => {
  test("knows exactly the 31 colleges of the wealth dataset", () => {
    expect(COLLEGE_CHARITIES.size).toBe(31)
    expect(COLLEGE_CHARITIES.get("1137604")).toBe("org-trinity-college")
  })

  test("inserts, then counts a re-read that changes nothing as unchanged", async () => {
    const t = newTest()
    const row = finance(colleges[0], "2025-06-30", { extractModified: 1 })
    expect(await post(t, [row])).toMatchObject({ inserted: 1 })
    const later = { ...row, retrievedAt: READ + 7 * 86_400_000 }
    later.source = { ...row.source, extractModified: 2 }
    expect(await post(t, [later])).toMatchObject({ unchanged: 1 })
    const stored = await t.run(async (ctx) => await ctx.db.query("collegeFinances").take(100))
    expect(stored).toHaveLength(1)
    // The read stamps moved; updatedAt did not.
    expect(stored[0].retrievedAt).toBe(later.retrievedAt)
    expect(stored[0].source.extractModified).toBe(2)
    expect(stored[0].updatedAt).toBe(stored[0].createdAt)

    expect(await post(t, [{ ...later, endowmentGbp: 101_000_000 }])).toMatchObject({ updated: 1 })
  })

  test("drops a figure the latest return no longer states", async () => {
    const t = newTest()
    const row = finance(colleges[0], "2025-06-30")
    await post(t, [row])
    const { incomeGbp: _gone, ...withoutIncome } = row
    expect(await post(t, [withoutIncome as typeof row])).toMatchObject({ updated: 1 })
    const [stored] = await t.run(async (ctx) => await ctx.db.query("collegeFinances").take(100))
    expect(stored.incomeGbp).toBeUndefined()
  })

  test("refuses a stranger, a wrong key, a bad date, a fraction or an unexplained review", async () => {
    const t = newTest()
    const good = finance(colleges[0], "2025-06-30")
    await expect(post(t, [{ ...good, charityNumber: "999" }])).rejects.toThrow(/Not a college/)
    await expect(post(t, [{ ...good, collegeKey: "org-trinity-college" }])).rejects.toThrow(
      /is org-christs-college/,
    )
    await expect(post(t, [{ ...good, periodEnd: "2025-6-30" }])).rejects.toThrow(/YYYY-MM-DD/)
    await expect(post(t, [{ ...good, endowmentGbp: 1.5 }])).rejects.toThrow(/whole pounds/)
    await expect(post(t, [{ ...good, status: "needs_review" as const }])).rejects.toThrow(
      /must say why/,
    )
    const override = { ...good, status: "override" as const }
    await expect(post(t, [override])).rejects.toThrow(/cite/)
    // Nothing of a refused batch was written.
    const stored = await t.run(async (ctx) => await ctx.db.query("collegeFinances").take(100))
    expect(stored).toHaveLength(0)
  })
})

describe("collegeFinances.history / latestCompleteYear", () => {
  test("with no rows: every college, no year", async () => {
    const t = newTest()
    const history = await t.query(api.collegeFinances.history, {})
    expect(history).toHaveLength(31)
    expect(history.every((college) => college.periods.length === 0)).toBe(true)
    expect(await t.query(api.collegeFinances.latestCompleteYear, {})).toEqual({
      financialYear: null,
      colleges: 31,
      next: null,
      updatedAt: null,
      retrievedAt: null,
    })
  })

  test("a year is complete only when every college has an accepted row", async () => {
    const t = newTest()
    await post(
      t,
      colleges.map((college) => finance(college, "2025-06-30")),
    )
    // 2025-26: 29 accepted, one held back, one not filed yet.
    await post(t, [
      ...colleges.slice(0, 29).map((college) => finance(college, "2026-06-30")),
      finance(colleges[29], "2026-07-31", { status: "needs_review", checks: ["lines_swapped"] }),
    ])
    const latest = await t.query(api.collegeFinances.latestCompleteYear, {})
    expect(latest.financialYear).toBe("2024-25")
    expect(latest.next).toEqual({ financialYear: "2025-26", filed: 30, needsReview: 1, total: 31 })
    expect(latest.retrievedAt).toBe(READ)

    const history = await t.query(api.collegeFinances.history, {})
    const held = history.find((college) => college.collegeKey === colleges[29].collegeKey)
    expect(held?.needsReview).toBe(1)
    // A needs_review period is counted and listed, never with its figures.
    expect(held?.periods[held.periods.length - 1]).toEqual({
      periodEnd: "2026-07-31",
      status: "needs_review",
    })
    expect(held?.periods[0]).toMatchObject({ periodEnd: "2025-06-30", endowmentGbp: 100_000_000 })

    await post(t, [
      finance(colleges[29], "2026-07-31"),
      finance(colleges[30], "2026-06-30", { status: "override" }),
    ])
    expect(await t.query(api.collegeFinances.latestCompleteYear, {})).toMatchObject({
      financialYear: "2025-26",
      next: { financialYear: "2026-27", filed: 0, needsReview: 0, total: 31 },
    })
  })
})
