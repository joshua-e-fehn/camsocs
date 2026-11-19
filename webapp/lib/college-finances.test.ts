import { describe, expect, test } from "bun:test"
import {
  type CollegeHistory,
  completeYears,
  financialYearOf,
  nextFinancialYear,
  previousFinancialYear,
  resolveWealthYear,
  TREND_YEARS,
  type VerifiedWealth,
} from "@/lib/college-finances"
import { COLLEGE_WEALTH } from "@/lib/college-wealth"

describe("financial years", () => {
  test("a June or July year end closes the academic year before it", () => {
    expect(financialYearOf("2025-06-30")).toBe("2024-25")
    expect(financialYearOf("2025-07-31")).toBe("2024-25")
    expect(financialYearOf("2025-12-31")).toBe("2025-26")
    expect(financialYearOf("2000-06-30")).toBe("1999-00")
    expect(() => financialYearOf("2025-6-30")).toThrow()
  })

  test("previous and next", () => {
    expect(previousFinancialYear("2024-25")).toBe("2023-24")
    expect(nextFinancialYear("2024-25")).toBe("2025-26")
    expect(nextFinancialYear("2099-00")).toBe("2100-01")
  })
})

const VERIFIED: VerifiedWealth[] = [
  {
    slug: "alpha-college",
    financialYearEnd: "2025-06-30",
    endowmentGbp: 200,
    endowmentPrevGbp: 180,
    netAssetsGbp: 300,
    incomeGbp: 20,
  },
  {
    slug: "beta-college",
    financialYearEnd: "2025-07-31",
    endowmentGbp: 100,
    endowmentPrevGbp: 95,
    netAssetsGbp: 150,
    incomeGbp: 10,
  },
]

function period(
  periodEnd: string,
  endowmentGbp: number,
  status: "register" | "override" = "register",
) {
  return { periodEnd, endowmentGbp, netAssetsGbp: endowmentGbp * 2, incomeGbp: 9, status }
}

const HISTORY: CollegeHistory[] = [
  {
    collegeKey: "org-alpha-college",
    needsReview: 1,
    periods: [
      period("2021-06-30", 150),
      { periodEnd: "2022-06-30", status: "needs_review" },
      period("2023-06-30", 170),
      period("2024-06-30", 999), // the register's; the dataset's 180 wins
      period("2025-06-30", 201), // the register's; the dataset's 200 wins
      period("2026-06-30", 220),
    ],
  },
  {
    collegeKey: "org-beta-college",
    needsReview: 0,
    periods: [period("2024-07-31", 94), period("2025-07-31", 100, "override")],
  },
]

describe("resolveWealthYear", () => {
  test("without Convex: the verified year, from the dataset", () => {
    const resolved = resolveWealthYear(VERIFIED, undefined)
    expect(resolved.financialYear).toBe("2024-25")
    expect(resolved.basis).toBe("verified")
    expect(resolved.rows.map((row) => [row.slug, row.endowmentGbp, row.basis])).toEqual([
      ["alpha-college", 200, "verified"],
      ["beta-college", 100, "verified"],
    ])
    expect(resolved.trends["alpha-college"]).toEqual([
      { financialYear: "2023-24", endowmentGbp: 180, basis: "verified" },
      { financialYear: "2024-25", endowmentGbp: 200, basis: "verified" },
    ])
    expect(resolved.next).toEqual({ financialYear: "2025-26", filed: 0, needsReview: 0, total: 2 })
  })

  test("an incomplete later year keeps the verified year, with the trend from the register", () => {
    const resolved = resolveWealthYear(VERIFIED, HISTORY)
    expect(resolved.financialYear).toBe("2024-25")
    expect(resolved.rows[0]).toMatchObject({ endowmentGbp: 200, basis: "verified" })
    expect(resolved.trends["alpha-college"]).toEqual([
      { financialYear: "2020-21", endowmentGbp: 150, basis: "register" },
      // 2021-22 was held back for review: a gap, not a guess.
      { financialYear: "2022-23", endowmentGbp: 170, basis: "register" },
      { financialYear: "2023-24", endowmentGbp: 180, basis: "verified" },
      { financialYear: "2024-25", endowmentGbp: 200, basis: "verified" },
    ])
    expect(resolved.next).toEqual({ financialYear: "2025-26", filed: 1, needsReview: 0, total: 2 })
  })

  test("a complete later year takes over, its previous year from the dataset", () => {
    const complete: CollegeHistory[] = [
      HISTORY[0],
      { ...HISTORY[1], periods: [...HISTORY[1].periods, period("2026-07-31", 110)] },
    ]
    const resolved = resolveWealthYear(VERIFIED, complete)
    expect(resolved.financialYear).toBe("2025-26")
    expect(resolved.basis).toBe("register")
    expect(resolved.rows).toEqual([
      {
        slug: "alpha-college",
        periodEnd: "2026-06-30",
        endowmentGbp: 220,
        endowmentPrevGbp: 200,
        netAssetsGbp: 440,
        incomeGbp: 9,
        basis: "register",
      },
      {
        slug: "beta-college",
        periodEnd: "2026-07-31",
        endowmentGbp: 110,
        endowmentPrevGbp: 100,
        netAssetsGbp: 220,
        incomeGbp: 9,
        basis: "register",
      },
    ])
    const alpha = resolved.trends["alpha-college"]
    expect(alpha).toHaveLength(4)
    expect(alpha.map((point) => point.financialYear)).toEqual([
      "2022-23",
      "2023-24",
      "2024-25",
      "2025-26",
    ])
    expect(alpha.length).toBeLessThanOrEqual(TREND_YEARS)
  })

  test("a year with any college missing or held back is not complete", () => {
    expect(completeYears(HISTORY, ["org-alpha-college", "org-beta-college"])).toEqual([
      "2024-25",
      "2023-24",
    ])
    expect(completeYears(HISTORY, ["org-alpha-college"])).toEqual([
      "2025-26",
      "2024-25",
      "2023-24",
      "2022-23",
      "2020-21",
    ])
  })

  test("the real dataset resolves to its own year with all 31 colleges", () => {
    const resolved = resolveWealthYear(COLLEGE_WEALTH, [])
    expect(resolved.financialYear).toBe("2024-25")
    expect(resolved.rows).toHaveLength(31)
    expect(Object.keys(resolved.trends)).toHaveLength(31)
  })

  test("refuses a dataset that mixes years", () => {
    expect(() =>
      resolveWealthYear([VERIFIED[0], { ...VERIFIED[1], financialYearEnd: "2024-07-31" }], []),
    ).toThrow(/not in 2024-25/)
  })
})
