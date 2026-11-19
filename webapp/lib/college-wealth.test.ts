import { describe, expect, test } from "bun:test"
import {
  BY_ENDOWMENT,
  barScale,
  barWidth,
  COLLEGE_WEALTH,
  changePct,
  formatGbp,
  formatPct,
  INCOME_FROM_ANNUAL_RETURN,
  JULY_YEAR_END,
  listNames,
  metricValue,
  ordinal,
  perStudent,
  RECORDED_TOTAL_GBP,
  rankedBy,
  SHORT_TERM_HOLDERS,
  sourcePage,
  WEALTH_FINANCIAL_YEAR_NOTE,
  WEALTH_QUOTED,
  WEALTH_SORT_KEYS,
  WEALTH_TOTALS,
  wealthTable,
  wealthTotals,
} from "@/lib/college-wealth"
import { COLLEGE_INFO } from "@/lib/colleges"
import { OLD_MONEY_COLLEGE_KEYS } from "@/lib/formal-ranks"

describe("college wealth data", () => {
  test("all 31 colleges, once each, joined to colleges.json", () => {
    expect(COLLEGE_WEALTH).toHaveLength(31)
    const slugs = COLLEGE_WEALTH.map((row) => row.slug)
    expect(new Set(slugs).size).toBe(31)
    expect([...slugs].sort()).toEqual(COLLEGE_INFO.map((c) => c.slug).sort())
    for (const row of COLLEGE_WEALTH) expect(row.college.slug).toBe(row.slug)
  })

  test("every figure is positive and sourced", () => {
    for (const row of COLLEGE_WEALTH) {
      for (const value of [
        row.endowmentGbp,
        row.endowmentPrevGbp,
        row.netAssetsGbp,
        row.incomeGbp,
        row.students,
      ]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThan(0)
      }
      expect(row.sourceUrl).toMatch(/^https:\/\//)
      expect(row.sourceRegisterUrl).toMatch(/^https:\/\/register-of-charities\./)
      expect(row.sourceRef).toMatch(/^PDF p\.\d+/)
      expect(row.status).toBe("verified")
      expect(row.financialYearEnd).toMatch(/^2025-0[67]-3[01]$/)
      expect(row.undergraduates + row.postgraduates).toBe(row.students)
    }
  })

  test("per-student and change recompute from the figures", () => {
    for (const row of COLLEGE_WEALTH) {
      expect(perStudent(row)).toBe(row.endowmentPerStudentGbp)
      expect(changePct(row)).toBeCloseTo(row.endowmentChangePct, 1)
    }
  })

  test("the total equals the sum of the rows", () => {
    const sum = COLLEGE_WEALTH.reduce((total, row) => total + row.endowmentGbp, 0)
    expect(sum).toBe(RECORDED_TOTAL_GBP)
    expect(WEALTH_TOTALS.total).toBe(sum)
  })

  test("the Old money badge is the five largest endowments", () => {
    const top5 = BY_ENDOWMENT.slice(0, 5).map((row) => row.college.key)
    expect([...OLD_MONEY_COLLEGE_KEYS]).toEqual(top5)
  })
})

describe("sorting and headline figures", () => {
  test("every sort key ranks highest first", () => {
    for (const key of WEALTH_SORT_KEYS) {
      const ranked = rankedBy(COLLEGE_WEALTH, key)
      expect(ranked).toHaveLength(31)
      for (let i = 1; i < ranked.length; i++) {
        expect(metricValue(ranked[i - 1], key)).toBeGreaterThanOrEqual(metricValue(ranked[i], key))
      }
    }
  })

  test("ranking does not reorder its input", () => {
    const before = COLLEGE_WEALTH.map((row) => row.slug)
    rankedBy(COLLEGE_WEALTH, "change")
    expect(COLLEGE_WEALTH.map((row) => row.slug)).toEqual(before)
  })

  test("ties fall back to the name", () => {
    const [a, b] = COLLEGE_WEALTH
    const same = [
      { ...b, endowmentGbp: 1 },
      { ...a, endowmentGbp: 1 },
    ]
    expect(rankedBy(same, "endowment").map((row) => row.name)).toEqual(
      [a.name, b.name].sort((x, y) => x.localeCompare(y)),
    )
  })

  test("totals: richest, median and share", () => {
    expect(WEALTH_TOTALS.richest.slug).toBe("trinity-college")
    expect(WEALTH_TOTALS.median).toBe(BY_ENDOWMENT[15])
    expect(WEALTH_TOTALS.poorest).toBe(BY_ENDOWMENT[30])
    expect(WEALTH_TOTALS.richestShare).toBeCloseTo(
      WEALTH_TOTALS.richest.endowmentGbp / WEALTH_TOTALS.total,
      10,
    )
    const three = wealthTotals(BY_ENDOWMENT.slice(0, 3))
    expect(three.median).toBe(BY_ENDOWMENT[1])
  })
})

describe("bars and formatting", () => {
  test("an outlier is cut off at the runner-up's scale", () => {
    expect(barScale([300, 100, 50])).toBe(100)
    expect(barScale([150, 100, 50])).toBe(150)
    expect(barScale([-12, 5, 3])).toBe(5)
    expect(barScale([])).toBe(0)
    expect(barWidth(300, 100)).toEqual({ fraction: 1, cut: true })
    expect(barWidth(50, 100)).toEqual({ fraction: 0.5, cut: false })
    expect(barWidth(-50, 100)).toEqual({ fraction: 0.5, cut: false })
    expect(barWidth(5, 0)).toEqual({ fraction: 0, cut: false })
  })

  test("money and percentages", () => {
    expect(formatGbp(2_704_537_000)).toBe("£2.70bn")
    expect(formatGbp(787_214_000)).toBe("£787.2m")
    expect(formatGbp(249_001)).toBe("£249k")
    expect(formatGbp(950)).toBe("£950")
    expect(formatPct(9.9)).toBe("+9.9%")
    expect(formatPct(-1.9)).toBe("−1.9%")
    expect(formatPct(0)).toBe("0.0%")
  })

  test("source page from a reference", () => {
    expect(sourcePage("PDF p.46: Consolidated balance sheet, Investments (note 10)")).toBe(
      "PDF p.46",
    )
    expect(sourcePage("PDF p.43 (p.43), Non-current assets: Investments")).toBe("PDF p.43")
  })
})

describe("table props", () => {
  test("orders, scales and rows for every key", () => {
    const table = wealthTable(COLLEGE_WEALTH, (college) => `/societies/${college.slug}`)
    expect(table.rows).toHaveLength(31)
    for (const key of WEALTH_SORT_KEYS) {
      expect(table.orders[key]).toEqual(rankedBy(COLLEGE_WEALTH, key).map((row) => row.slug))
      expect(table.scales[key]).toBeGreaterThan(0)
    }
    expect(table.orders.endowment[0]).toBe("trinity-college")
    // Trinity is more than twice St John's, so the bars scale to St John's.
    expect(table.scales.endowment).toBe(BY_ENDOWMENT[1].endowmentGbp)
    const trinity = table.rows.find((row) => row.slug === "trinity-college")
    expect(trinity?.display.endowment).toBe("£2.70bn")
    expect(trinity?.href).toBe("/societies/trinity-college")
  })
})

describe("facts the page states", () => {
  test("ordinals and name lists", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 16, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "16th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ])
    expect(listNames([])).toBe("")
    expect(listNames(["A"])).toBe("A")
    expect(listNames(["A", "B"])).toBe("A and B")
    expect(listNames(["A", "B", "C"])).toBe("A, B and C")
  })

  test("the 31 July year ends match the year-end note", () => {
    expect(JULY_YEAR_END.map((row) => row.slug)).toEqual([
      "emmanuel-college",
      "fitzwilliam-college",
      "hughes-hall",
    ])
    for (const row of JULY_YEAR_END)
      expect(WEALTH_FINANCIAL_YEAR_NOTE).toContain(row.name.split(" ")[0])
    for (const row of COLLEGE_WEALTH) {
      expect(["2025-06-30", "2025-07-31"]).toContain(row.financialYearEnd)
    }
  })

  test("11 colleges' income is the annual-return figure", () => {
    expect(INCOME_FROM_ANNUAL_RETURN).toHaveLength(11)
  })

  test("the short-term holders are the colleges whose notes say so", () => {
    expect(SHORT_TERM_HOLDERS.map((row) => row.slug)).toEqual([
      "fitzwilliam-college",
      "hughes-hall",
    ])
  })

  test("quoted figures are in their college's notes", () => {
    for (const { slug, text } of Object.values(WEALTH_QUOTED)) {
      const row = COLLEGE_WEALTH.find((r) => r.slug === slug)
      expect(row?.notes).toContain(text)
    }
    const trinity = COLLEGE_WEALTH.find((r) => r.slug === "trinity-college")
    // The page says Trinity's investments exceed its net assets.
    expect(trinity && trinity.endowmentGbp > trinity.netAssetsGbp).toBe(true)
  })
})
