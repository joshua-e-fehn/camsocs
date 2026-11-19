import { describe, expect, test } from "bun:test"
import { resolveWealthYear } from "@/lib/college-finances"
import {
  COLLEGE_WEALTH,
  registerCheckCounts,
  registerExplained,
  WEALTH_CHECKED_ON,
  WEALTH_FINANCIAL_YEAR,
} from "@/lib/college-wealth"
import {
  biggestRisers,
  faqText,
  freshnessText,
  hubWealthFact,
  longDate,
  nextYearText,
  possessive,
  registerCheckText,
  staticWealthView,
  temporalCoverage,
  trendRows,
  trendTotals,
  VERIFIED_WEALTH,
  WEALTH_H1,
  wealthCsv,
  wealthDescription,
  wealthFaqs,
  wealthLede,
  wealthTitle,
  wealthView,
  yearEndText,
} from "@/lib/college-wealth-view"
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "@/lib/page-metadata"
import { REGISTER_META, registerYearHistory } from "./college-wealth-view.testing"

describe("the verified view (no Convex)", () => {
  const view = staticWealthView()

  test("the dataset's year, every row verified, updated on its check date", () => {
    expect(view.financialYear).toBe(WEALTH_FINANCIAL_YEAR)
    expect(view.basis).toBe("verified")
    expect(view.rows).toHaveLength(31)
    expect(view.rows.every((row) => row.basis === "verified")).toBe(true)
    expect(view.updatedOn).toBe(WEALTH_CHECKED_ON)
    expect(view.registerReadOn).toBeNull()
    expect(view.trendYears).toEqual(["2023-24", "2024-25"])
  })

  test("title, description and H1 from the data, within the limits", () => {
    const title = wealthTitle(view)
    const description = wealthDescription(view)
    expect(title).toBe("Richest Cambridge colleges ranked: endowments 2024-25")
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(description).toBe(
      "All 31 Cambridge colleges ranked by endowment, from Trinity’s £2.70bn to St Edmund’s £11.5m, with per-student figures and net assets from 2024-25 accounts.",
    )
    expect(WEALTH_H1).toBe("Cambridge colleges ranked by endowment, richest to poorest")
    expect(WEALTH_H1).not.toBe(title)
  })

  test("the lede answers the question in one sentence", () => {
    expect(wealthLede(view)).toBe(
      "Trinity College is the richest Cambridge college: its investments were worth £2.70bn at 30 June 2025, about 3.4 times St John’s (£787.2m) and 35.5% of all 31 colleges’ endowments combined.",
    )
  })

  test("the register cross-check replaces the one-read disclaimer", () => {
    const counts = registerCheckCounts(COLLEGE_WEALTH)
    expect(counts).toEqual({ colleges: 31, endowment: 29, netAssets: 31, income: 30 })
    expect(registerExplained(COLLEGE_WEALTH, "endowment").map((row) => row.slug)).toEqual([
      "clare-college",
      "newnham-college",
    ])
    expect(registerCheckText()).toBe(
      "Every 2024-25 figure was read from the accounts each college filed and cross-checked against the Charity Commission register: net assets match for 31 of 31 colleges and investments for 29 of 31, with Clare and Newnham explained in the notes.",
    )
    for (const row of registerExplained(COLLEGE_WEALTH, "endowment")) {
      expect(row.notes).toMatch(/register/)
    }
  })

  test("dates in step: freshness line, check date, year ends", () => {
    expect(freshnessText(view)).toBe(
      "Updated 19 Nov 2026 · 2024-25 accounts, the latest year every college has filed",
    )
    expect(yearEndText(view)).toBe(
      "30 June 2025 for most, 31 July 2025 for Emmanuel, Fitzwilliam and Hughes Hall",
    )
    expect(temporalCoverage(view)).toBe("2024-07-01/2025-07-31")
    expect(longDate("2025-06-30")).toBe("30 June 2025")
    expect(nextYearText(view)).toBeNull()
  })

  test("possessives of the colleges' short names", () => {
    expect(possessive("Trinity")).toBe("Trinity’s")
    expect(possessive("St John’s")).toBe("St John’s")
    expect(possessive("Queens’")).toBe("Queens’")
    expect(possessive("Jesus")).toBe("Jesus’")
  })

  test("the questions answer from the data, with their links", () => {
    const faqs = wealthFaqs(view)
    expect(faqs.map((entry) => entry.id)).toEqual([
      "richest",
      "trinity-worth",
      "trinity-why",
      "poorest",
      "per-student",
      "total",
      "university",
      "other-rankings",
      "best",
    ])
    const byId = Object.fromEntries(faqs.map((entry) => [entry.id, faqText(entry.answer)]))
    expect(byId.richest).toContain("£2.70bn")
    expect(byId["trinity-why"]).toContain("£1,174.1m of property")
    expect(byId.poorest).toContain("St Edmund's College")
    expect(byId["other-rankings"]).toContain("King’s, for one, is 8th by endowment but 3rd")
    for (const text of Object.values(byId)) expect(text).not.toMatch(/undefined|NaN|null/)
  })

  test("each college's hub fact links its row", () => {
    const fact = hubWealthFact(view, "kings-college")
    expect(fact?.href).toBe("/colleges/wealth#kings-college")
    expect(fact?.text).toMatch(/^Endowment £[\d.]+m \(8th of 31, 2024-25\) · £\d+k per student$/)
    expect(fact?.linkText).toBe("King’s endowment, ranked")
    expect(hubWealthFact(view, "no-such-college")).toBeNull()
  })

  test("the trend: two years from the dataset, totals for both", () => {
    const rows = trendRows(view)
    expect(rows).toHaveLength(31)
    expect(rows[0].row.slug).toBe("trinity-college")
    expect(rows.every((row) => row.cells.every((cell) => cell?.basis === "verified"))).toBe(true)
    const totals = trendTotals(view)
    expect(totals[1]).toBe(view.totals.total)
    expect(biggestRisers(view)).toHaveLength(5)
  })

  test("the CSV: a header, 31 rows richest first, the licence", () => {
    const csv = wealthCsv(view, "Contains public sector information.", "https://x/colleges/wealth")
    const lines = csv.trimEnd().split("\n")
    expect(lines[0]).toStartWith("# Cambridge college endowments 2024-25")
    expect(lines[1]).toContain("Contains public sector information.")
    expect(lines[2]).toStartWith("rank,college,charity_number,financial_year,")
    expect(lines).toHaveLength(3 + 31)
    expect(lines[3]).toStartWith("1,Trinity College,")
    // A name with a comma or quote would be quoted; the source refs have commas.
    expect(lines[3]).toContain('"PDF p.18: Consolidated balance sheet, Fixed assets')
  })
})

describe("a later complete year from the register", () => {
  const resolved = resolveWealthYear(VERIFIED_WEALTH, registerYearHistory({ complete: true }))
  const view = wealthView(resolved, REGISTER_META)

  test("takes over: year, basis, sources and dates", () => {
    expect(view.financialYear).toBe("2025-26")
    expect(view.basis).toBe("register")
    expect(view.rows.every((row) => row.basis !== "verified")).toBe(true)
    expect(view.rows[1].basis).toBe("override")
    expect(view.rows.every((row) => row.sourceUrl === row.sourceRegisterUrl)).toBe(true)
    expect(view.rows.every((row) => row.notes === "")).toBe(true)
    expect(view.updatedOn).toBe("2027-05-20")
    expect(view.registerReadOn).toBe("2027-05-24")
  })

  test("every SEO string moves with the year and stays within limits", () => {
    expect(wealthTitle(view)).toBe("Richest Cambridge colleges ranked: endowments 2025-26")
    const description = wealthDescription(view)
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(description).toContain("2025-26 filings")
    expect(wealthLede(view)).toContain("30 June 2026")
    expect(temporalCoverage(view)).toBe("2025-07-01/2026-07-31")
    expect(freshnessText(view)).toContain("Updated 20 May 2027 · 2025-26 figures")
  })

  test("the previous year comes from the dataset; the trend spans the register's years", () => {
    const trinity = view.rows.find((row) => row.slug === "trinity-college")
    const verified = COLLEGE_WEALTH.find((row) => row.slug === "trinity-college")
    expect(trinity?.endowmentPrevGbp).toBe(verified?.endowmentGbp ?? -1)
    expect(view.trendYears).toEqual(["2022-23", "2023-24", "2024-25", "2025-26"])
    const totals = trendTotals(view)
    // One college has no 2022-23 figure: no total for that year.
    expect(totals[0]).toBeNull()
    expect(totals[3]).toBe(view.totals.total)
  })
})

describe("a later year still filing", () => {
  const resolved = resolveWealthYear(VERIFIED_WEALTH, registerYearHistory({ complete: false }))
  const view = wealthView(resolved, REGISTER_META)

  test("keeps the verified year and says how far the next has got", () => {
    expect(view.financialYear).toBe("2024-25")
    expect(view.basis).toBe("verified")
    expect(view.updatedOn).toBe(WEALTH_CHECKED_ON)
    expect(nextYearText(view)).toBe(
      "16 of 31 colleges have filed their 2025-26 accounts with the Charity Commission so far; the ranking moves to 2025-26 once all 31 have, and their figures pass our checks.",
    )
  })
})
