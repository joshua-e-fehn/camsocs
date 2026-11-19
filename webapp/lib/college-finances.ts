/**
 * Which financial year /colleges/wealth ranks, and each college's trend
 * (ENG-272): the verified dataset (lib/data/college-wealth.json, every figure
 * read from the filed accounts and cross-checked against the register) joined
 * with what the pipeline's `college_finances` stage keeps in Convex from the
 * Charity Commission register (`collegeFinances`, source-research §22).
 *
 * The rule: the ranking shows the newest financial year in which every
 * college has an accepted row (`register` or `override`, all three figures).
 * Until a later year is complete it shows the verified year, whose figures
 * always come from the dataset, never from the register. A year is complete
 * only when the last college has filed (each year by early June), so the page
 * never mixes two years in one ranking.
 *
 * Pure: no imports, so Convex (convex/collegeFinances.ts) and the page share it.
 */

export const FINANCE_STATUSES = ["register", "override", "needs_review"] as const
export type FinanceStatus = (typeof FINANCE_STATUSES)[number]

/** One college's period as `collegeFinances.history` returns it. A
 * `needs_review` period carries no figures. */
export type FinancePeriod = {
  periodEnd: string
  endowmentGbp?: number
  netAssetsGbp?: number
  incomeGbp?: number
  status: FinanceStatus
}

export type CollegeHistory = {
  /** `org-<slug>`. */
  collegeKey: string
  /** Oldest first. */
  periods: FinancePeriod[]
  /** Periods held back for review (counted, never shown as figures). */
  needsReview: number
}

/** "2024-25" for a year ending 30 June or 31 July 2025. A period ending in
 * January to September closes the academic year that began the previous
 * autumn; one ending October to December closes in the year it names. */
export function financialYearOf(periodEnd: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodEnd)
  if (!match) throw new Error(`Not a period end: ${periodEnd}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const start = month <= 9 ? year - 1 : year
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** "2023-24" before "2024-25". */
export function previousFinancialYear(financialYear: string): string {
  const start = Number(financialYear.slice(0, 4)) - 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

export function nextFinancialYear(financialYear: string): string {
  const start = Number(financialYear.slice(0, 4)) + 1
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`
}

/** An accepted period with all three figures. */
export type AcceptedPeriod = FinancePeriod & {
  status: "register" | "override"
  endowmentGbp: number
  netAssetsGbp: number
  incomeGbp: number
}

export function isAccepted(period: FinancePeriod): period is AcceptedPeriod {
  return (
    period.status !== "needs_review" &&
    period.endowmentGbp !== undefined &&
    period.netAssetsGbp !== undefined &&
    period.incomeGbp !== undefined
  )
}

/** Each college's accepted period by financial year. */
function acceptedByYear(
  history: readonly CollegeHistory[],
): Map<string, Map<string, AcceptedPeriod>> {
  const out = new Map<string, Map<string, AcceptedPeriod>>()
  for (const college of history) {
    const years = new Map<string, AcceptedPeriod>()
    for (const period of college.periods) {
      if (isAccepted(period)) years.set(financialYearOf(period.periodEnd), period)
    }
    out.set(college.collegeKey, years)
  }
  return out
}

/** Financial years in which every one of `collegeKeys` has an accepted
 * period, newest first. */
export function completeYears(
  history: readonly CollegeHistory[],
  collegeKeys: readonly string[],
): string[] {
  const accepted = acceptedByYear(history)
  const years = new Set<string>()
  for (const byYear of accepted.values()) for (const year of byYear.keys()) years.add(year)
  return [...years]
    .filter((year) => collegeKeys.every((key) => accepted.get(key)?.has(year)))
    .sort()
    .reverse()
}

/** How far a year's filings have got: colleges with any row for it, and
 * how many of those are held back for review. */
export type YearProgress = {
  financialYear: string
  filed: number
  needsReview: number
  total: number
}

export function yearProgress(
  history: readonly CollegeHistory[],
  collegeKeys: readonly string[],
  financialYear: string,
): YearProgress {
  let filed = 0
  let needsReview = 0
  const wanted = new Set(collegeKeys)
  for (const college of history) {
    if (!wanted.has(college.collegeKey)) continue
    const rows = college.periods.filter((p) => financialYearOf(p.periodEnd) === financialYear)
    if (rows.length === 0) continue
    filed++
    if (!rows.some(isAccepted)) needsReview++
  }
  return { financialYear, filed, needsReview, total: collegeKeys.length }
}

// --- the page's year -----------------------------------------------------------------------

/** What the verified dataset gives for one college (a subset of its row). */
export type VerifiedWealth = {
  slug: string
  financialYearEnd: string
  endowmentGbp: number
  endowmentPrevGbp: number
  netAssetsGbp: number
  incomeGbp: number
}

/** One college's figures for the year the ranking shows. */
export type WealthFigures = {
  slug: string
  periodEnd: string
  endowmentGbp: number
  /** The year before, on the same basis; absent when not known. */
  endowmentPrevGbp?: number
  netAssetsGbp: number
  incomeGbp: number
  /** `verified`: the dataset (accounts PDF + register); otherwise the register's status. */
  basis: "verified" | "register" | "override"
}

export type TrendPoint = {
  financialYear: string
  endowmentGbp: number
  basis: "verified" | "register" | "override"
}

export type ResolvedWealthYear = {
  /** "2024-25". */
  financialYear: string
  /** `verified` while the dataset's year is the newest complete one. */
  basis: "verified" | "register"
  /** One per college, in the dataset's order. */
  rows: WealthFigures[]
  /** Slug → endowment by financial year, oldest first, at most `TREND_YEARS`
   * years up to the shown year. A year a college has no accepted row for is
   * absent (a gap), never interpolated. */
  trends: Record<string, TrendPoint[]>
  /** The next year's filings so far, while it is incomplete. */
  next: YearProgress
}

/** The trend's length: the register keeps five financial periods. */
export const TREND_YEARS = 5

const keyOf = (slug: string) => `org-${slug}`

export function resolveWealthYear(
  verified: readonly VerifiedWealth[],
  history: readonly CollegeHistory[] | null | undefined,
): ResolvedWealthYear {
  if (verified.length === 0) throw new Error("resolveWealthYear: no verified rows")
  const verifiedYear = financialYearOf(verified[0].financialYearEnd)
  for (const row of verified) {
    if (financialYearOf(row.financialYearEnd) !== verifiedYear) {
      throw new Error(`${row.slug}: ${row.financialYearEnd} is not in ${verifiedYear}`)
    }
  }
  const histories = history ?? []
  const keys = verified.map((row) => keyOf(row.slug))
  const accepted = acceptedByYear(histories)
  const newest = completeYears(histories, keys).find((year) => year > verifiedYear)

  // The verified year and the one before it always come from the dataset.
  const verifiedPoint = (row: VerifiedWealth, year: string): TrendPoint | undefined => {
    if (year === verifiedYear) {
      return { financialYear: year, endowmentGbp: row.endowmentGbp, basis: "verified" }
    }
    if (year === previousFinancialYear(verifiedYear)) {
      return { financialYear: year, endowmentGbp: row.endowmentPrevGbp, basis: "verified" }
    }
    return undefined
  }
  const pointFor = (row: VerifiedWealth, year: string): TrendPoint | undefined => {
    const fromDataset = verifiedPoint(row, year)
    if (fromDataset) return fromDataset
    const period = accepted.get(keyOf(row.slug))?.get(year)
    return period
      ? { financialYear: year, endowmentGbp: period.endowmentGbp, basis: period.status }
      : undefined
  }

  const shownYear = newest ?? verifiedYear
  const rows: WealthFigures[] = verified.map((row) => {
    if (newest === undefined) {
      return {
        slug: row.slug,
        periodEnd: row.financialYearEnd,
        endowmentGbp: row.endowmentGbp,
        endowmentPrevGbp: row.endowmentPrevGbp,
        netAssetsGbp: row.netAssetsGbp,
        incomeGbp: row.incomeGbp,
        basis: "verified",
      }
    }
    const period = accepted.get(keyOf(row.slug))?.get(newest) as AcceptedPeriod
    return {
      slug: row.slug,
      periodEnd: period.periodEnd,
      endowmentGbp: period.endowmentGbp,
      endowmentPrevGbp: pointFor(row, previousFinancialYear(newest))?.endowmentGbp,
      netAssetsGbp: period.netAssetsGbp,
      incomeGbp: period.incomeGbp,
      basis: period.status,
    }
  })

  const years: string[] = []
  for (let year = shownYear, i = 0; i < TREND_YEARS; i++, year = previousFinancialYear(year)) {
    years.unshift(year)
  }
  const trends: Record<string, TrendPoint[]> = {}
  for (const row of verified) {
    trends[row.slug] = years
      .map((year) => pointFor(row, year))
      .filter((point): point is TrendPoint => point !== undefined)
  }

  return {
    financialYear: shownYear,
    basis: newest === undefined ? "verified" : "register",
    rows,
    trends,
    next: yearProgress(histories, keys, nextFinancialYear(shownYear)),
  }
}
