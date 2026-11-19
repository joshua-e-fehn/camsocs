import { describe, expect, test } from "bun:test"
import {
  BY_ENDOWMENT,
  barScale,
  barWidth,
  COLLEGE_WEALTH,
  changePct,
  collegeRanks,
  formatGbp,
  formatPct,
  INCOME_FROM_ANNUAL_RETURN,
  JULY_YEAR_END,
  listNames,
  metricValue,
  NO_FIGURE,
  ordinal,
  perStudent,
  RECORDED_TOTAL_GBP,
  rankedBy,
  SHORT_TERM_HOLDERS,
  sourcePage,
  tableRows,
  UNIVERSITY_ENDOWMENT,
  UNIVERSITY_ROW_SLUG,
  universityTableRow,
  WEALTH_CHECKED_ON,
  WEALTH_FINANCIAL_YEAR_NOTE,
  WEALTH_PUBLISHED_ON,
  WEALTH_QUOTED,
  WEALTH_REGISTER_CHECK,
  WEALTH_SORT_KEYS,
  WEALTH_TOTALS,
  WEALTH_VERIFICATION,
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

  test("every college was compared with the register; differences are explained", () => {
    for (const row of COLLEGE_WEALTH) {
      for (const result of Object.values(row.registerCheck)) {
        expect(["match", "explained"]).toContain(result)
      }
      if (Object.values(row.registerCheck).includes("explained")) {
        expect(row.notes).toMatch(/register|Charity Commission/)
      }
    }
    expect(WEALTH_REGISTER_CHECK.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(WEALTH_REGISTER_CHECK.licence).toContain("Open Government Licence v3.0")
    // The one-read caveat is gone: every college is cross-checked.
    expect(WEALTH_VERIFICATION.remainingDoubts.join(" ")).not.toMatch(/Not independently/)
  })

  test("the dates are in step", () => {
    expect(WEALTH_VERIFICATION.checkedOn).toBe(WEALTH_CHECKED_ON)
    expect(WEALTH_REGISTER_CHECK.checkedOn <= WEALTH_CHECKED_ON).toBe(true)
    expect(WEALTH_PUBLISHED_ON <= WEALTH_CHECKED_ON).toBe(true)
  })

  test("Pembroke's investments are cited to the balance sheet's page", () => {
    const pembroke = COLLEGE_WEALTH.find((row) => row.slug === "pembroke-college")
    expect(pembroke?.sourceRef).toBe("PDF p.31 (printed p.29): Balance Sheet, Investments (note 9)")
    expect(sourcePage(pembroke?.sourceRef ?? "")).toBe("PDF p.31")
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

describe("the University row (context, not a college)", () => {
  const hub = (college: { slug: string }) => `/societies/${college.slug}`

  test("its figures come from the financial statements, with no per-student figure", () => {
    const row = universityTableRow()
    expect(row.kind).toBe("university")
    expect(row.slug).toBe(UNIVERSITY_ROW_SLUG)
    expect(row.name).toBe("University of Cambridge")
    expect(row.crest).toBeNull()
    expect(row.href).toBe("#university")
    // The University group's share of the fund, not the whole fund (which holds college money too).
    expect(row.values.endowment).toBe(4_141_900_000)
    expect(row.values.endowment).toBe(UNIVERSITY_ENDOWMENT.attributableToUniversityGroupGbp)
    expect(row.values.netAssets).toBe(8_263_000_000)
    expect(row.values.income).toBe(2_660_000_000)
    expect(row.values.change).toBe(6)
    expect(row.values.perStudent).toBe(Number.NEGATIVE_INFINITY)
    expect(row.display).toEqual({
      endowment: "£4.14bn",
      perStudent: NO_FIGURE,
      income: "£2.66bn",
      netAssets: "£8.26bn",
      change: "+6.0%",
    })
    expect(row.financialYearEnd).toBe("2025-07-31")
    expect(row.sourceUrl).toBe(UNIVERSITY_ENDOWMENT.sourceUrl)
    expect(row.sourceLabel).toBe("Financial statements, PDF p.29")
    expect(UNIVERSITY_ENDOWMENT.status).toBe("verified")
    expect(UNIVERSITY_ENDOWMENT.financialYear).toBe("2024-25")
  })

  test("left out of the table unless asked for, and out of the default orders", () => {
    const table = wealthTable(COLLEGE_WEALTH, hub)
    expect(table.university).toBeNull()
    expect(tableRows(table, "endowment", true)).toHaveLength(31)
    const withUni = wealthTable(COLLEGE_WEALTH, hub, UNIVERSITY_ENDOWMENT)
    expect(withUni.rows).toHaveLength(31)
    expect(withUni.rows.every((row) => row.kind === "college")).toBe(true)
    for (const key of WEALTH_SORT_KEYS) {
      expect(withUni.orders[key]).toEqual(table.orders[key])
      expect(withUni.scales[key]).toBe(table.scales[key])
    }
  })

  test("sorted into place by each figure, last by per student; the colleges keep ranks 1..31", () => {
    const table = wealthTable(COLLEGE_WEALTH, hub, UNIVERSITY_ENDOWMENT)
    for (const key of WEALTH_SORT_KEYS) {
      const rows = tableRows(table, key, true)
      expect(rows).toHaveLength(32)
      // Without it, the order is the colleges' own.
      expect(rows.filter((row) => row.kind === "college").map((row) => row.slug)).toEqual(
        table.orders[key],
      )
      const ranks = collegeRanks(rows)
      expect(ranks.has(UNIVERSITY_ROW_SLUG)).toBe(false)
      expect([...ranks.values()]).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
      expect(ranks.get(table.orders[key][0])).toBe(1)
    }
    expect(tableRows(table, "endowment", true)[0].slug).toBe(UNIVERSITY_ROW_SLUG)
    expect(tableRows(table, "netAssets", true)[0].slug).toBe(UNIVERSITY_ROW_SLUG)
    expect(tableRows(table, "income", true)[0].slug).toBe(UNIVERSITY_ROW_SLUG)
    expect(tableRows(table, "perStudent", true).at(-1)?.slug).toBe(UNIVERSITY_ROW_SLUG)
    // +6.0% sits between the colleges either side of it.
    const byChange = tableRows(table, "change", true)
    const at = byChange.findIndex((row) => row.slug === UNIVERSITY_ROW_SLUG)
    expect(byChange[at - 1]?.values.change ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(6)
    expect(byChange[at + 1].values.change).toBeLessThanOrEqual(6)
  })

  test("its bars use the colleges' scale and are cut off where it is larger", () => {
    const table = wealthTable(COLLEGE_WEALTH, hub, UNIVERSITY_ENDOWMENT)
    const row = universityTableRow()
    // Still St John's: the University does not squash the colleges' bars.
    expect(table.scales.endowment).toBe(BY_ENDOWMENT[1].endowmentGbp)
    for (const key of ["endowment", "netAssets", "income"] as const) {
      expect(barWidth(row.values[key], table.scales[key]).cut).toBe(true)
    }
    expect(barWidth(row.values.perStudent, table.scales.perStudent)).toEqual({
      fraction: 0,
      cut: false,
    })
    expect(table.university?.note).toContain("no rank number")
    expect(table.university?.note).toContain("£4.14bn share of the £4.61bn")
    expect(table.university?.note).toContain("31 July 2025")
    expect(table.university?.note).toContain("colleges’ scale")
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
