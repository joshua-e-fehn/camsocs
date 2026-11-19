import { COLLEGE_INFO, type CollegeInfo } from "@/lib/colleges"
import data from "@/lib/data/college-wealth.json"

/**
 * The colleges' endowments (ENG-272, /colleges/wealth): each college's
 * consolidated balance-sheet investments at market value at the end of the
 * 2024-25 financial year, read from the audited accounts it filed with the
 * Charity Commission (lib/data/college-wealth.json, researched and re-checked
 * 18 Nov 2026). Every figure keeps its accounts PDF (`sourceUrl`), the page it
 * was read from (`sourceRef`) and a status. Keyed by the college's slug in
 * lib/data/colleges.json, so a row joins its crest and name there.
 *
 * Nothing here is estimated: a college whose accounts gave no figure would be
 * left out, not guessed (all 31 have one).
 */

export const WEALTH_PATH = "/colleges/wealth"

type RawWealth = (typeof data.colleges)[number]

export type CollegeWealth = Omit<
  RawWealth,
  "recheckedOn" | "collegeAccountsUrl" | "registerCheck"
> & {
  /** The college's own copy of the accounts, when it publishes one. */
  collegeAccountsUrl: string | null
  /** `YYYY-MM-DD` of the independent re-check of the accounts figures, or
   * null when only the derived figures were re-checked. */
  recheckedOn: string | null
  /** How each figure compares with the register's annual return. */
  registerCheck: Record<RegisterCheckField, RegisterCheckResult>
  college: CollegeInfo
}

export type RegisterCheckField = "endowment" | "netAssets" | "income"
/** `match`: within the cross-check's tolerance; `explained`: a difference
 * whose cause the college's notes record. */
export type RegisterCheckResult = "match" | "explained"

/**
 * A row as the ranking draws it: a verified row, or a later year's figures
 * from the register (lib/college-wealth-view.ts). `endowmentPrevGbp` is null
 * when the year before has no accepted figure.
 */
export type WealthRow = Omit<CollegeWealth, "endowmentPrevGbp"> & {
  endowmentPrevGbp: number | null
  /** `verified`: read from the accounts; `register`/`override`: the
   * register's annual return (as is, or corrected from the accounts). */
  basis: "verified" | "register" | "override"
}

/** What ranking and totals need of a row. */
type Figures = Pick<
  WealthRow,
  "name" | "endowmentGbp" | "endowmentPrevGbp" | "netAssetsGbp" | "incomeGbp" | "students"
>

const BY_SLUG = new Map(COLLEGE_INFO.map((college) => [college.slug, college]))

function joinCollege(raw: RawWealth): CollegeWealth {
  const college = BY_SLUG.get(raw.slug)
  if (!college) throw new Error(`lib/data/college-wealth.json: no college "${raw.slug}"`)
  return { ...raw, registerCheck: raw.registerCheck as CollegeWealth["registerCheck"], college }
}

export const COLLEGE_WEALTH: readonly CollegeWealth[] = data.colleges.map(joinCollege)

/** The day the figures were last checked (the page's "Updated" date and
 * its JSON-LD `dateModified` while the ranking shows this year). */
export const WEALTH_CHECKED_ON: string = data.checkedOn
/** The day the page was first published (JSON-LD `datePublished`). */
export const WEALTH_PUBLISHED_ON: string = data.publishedOn
/** The comparison of every 2024-25 figure with the Charity Commission
 * register's annual return (each row's `registerCheck`). */
export const WEALTH_REGISTER_CHECK = data.registerCrossCheck
/** "2024-25". */
export const WEALTH_FINANCIAL_YEAR: string = data.financialYear
/** Which year end each college's accounts use. */
export const WEALTH_FINANCIAL_YEAR_NOTE: string = data.financialYearNote
export const WEALTH_DEFINITIONS = data.definitions
export const WEALTH_SOURCES = data.sources
export const WEALTH_CAVEATS: readonly string[] = data.caveats
export const WEALTH_VERIFICATION = data.verification
export const WEALTH_STUDENTS_SOURCE_URL: string = data.studentsSourceUrl
export const UNIVERSITY_ENDOWMENT = data.universityEndowment
/** The research's own sum of the 31 endowments (the tests hold it to the rows). */
export const RECORDED_TOTAL_GBP: number = data.totalEndowmentGbp
export const WEALTH_TOTAL_NOTE: string = data.totalNote

// --- sorting -------------------------------------------------------------------------------

export const WEALTH_SORT_KEYS = [
  "endowment",
  "perStudent",
  "income",
  "netAssets",
  "change",
] as const
export type WealthSortKey = (typeof WEALTH_SORT_KEYS)[number]

export const WEALTH_SORT_LABELS: Record<WealthSortKey, string> = {
  endowment: "Endowment",
  perStudent: "Per student",
  income: "Income",
  netAssets: "Net assets",
  change: "1-year change",
}

/** The number a sort key ranks by (pounds, or percent for `change`; a
 * change that cannot be worked out ranks last, as −∞). */
export function metricValue(row: Figures, key: WealthSortKey): number {
  switch (key) {
    case "endowment":
      return row.endowmentGbp
    case "perStudent":
      return perStudent(row)
    case "income":
      return row.incomeGbp
    case "netAssets":
      return row.netAssetsGbp
    case "change":
      return changePct(row) ?? Number.NEGATIVE_INFINITY
  }
}

/** Endowment per student (headcount), to the nearest pound. */
export function perStudent(row: Pick<CollegeWealth, "endowmentGbp" | "students">): number {
  return Math.round(row.endowmentGbp / row.students)
}

/** The change in endowment over the year, in percent to one decimal; null
 * without the year before. */
export function changePct(
  row: Pick<WealthRow, "endowmentGbp" | "endowmentPrevGbp">,
): number | null {
  const prev = row.endowmentPrevGbp
  if (prev === null || prev <= 0) return null
  return Math.round(((row.endowmentGbp - prev) / prev) * 1000) / 10
}

/** The rows highest first by `key`; ties (and rows without the figure) by
 * name, so the order is stable. */
export function rankedBy<Row extends Figures>(rows: readonly Row[], key: WealthSortKey): Row[] {
  return [...rows].sort(
    (a, b) => metricValue(b, key) - metricValue(a, key) || a.name.localeCompare(b.name),
  )
}

/** The rows by endowment, richest first. */
export const BY_ENDOWMENT: readonly CollegeWealth[] = rankedBy(COLLEGE_WEALTH, "endowment")

// --- headline figures ----------------------------------------------------------------------

export type WealthTotals<Row = CollegeWealth> = {
  total: number
  /** The colleges' net assets added up. */
  netAssetsTotal: number
  richest: Row
  poorest: Row
  /** The middle college by endowment (31 colleges: the 16th). */
  median: Row
  /** The richest college's share of the total, 0–1. */
  richestShare: number
}

export function wealthTotals<Row extends Figures>(rows: readonly Row[]): WealthTotals<Row> {
  const ranked = rankedBy(rows, "endowment")
  const total = ranked.reduce((sum, row) => sum + row.endowmentGbp, 0)
  const richest = ranked[0]
  return {
    total,
    netAssetsTotal: ranked.reduce((sum, row) => sum + row.netAssetsGbp, 0),
    richest,
    poorest: ranked[ranked.length - 1],
    median: ranked[Math.floor(ranked.length / 2)],
    richestShare: richest.endowmentGbp / total,
  }
}

export const WEALTH_TOTALS: WealthTotals = wealthTotals(COLLEGE_WEALTH)

/** How many colleges' figures match the register, field by field, and the
 * colleges whose difference is explained. */
export function registerCheckCounts(rows: readonly Pick<CollegeWealth, "registerCheck">[]) {
  const count = (field: RegisterCheckField) =>
    rows.filter((row) => row.registerCheck[field] === "match").length
  return {
    colleges: rows.length,
    endowment: count("endowment"),
    netAssets: count("netAssets"),
    income: count("income"),
  }
}

/** The colleges whose `field` differs from the register for a reason in their notes. */
export function registerExplained<Row extends Pick<CollegeWealth, "registerCheck" | "name">>(
  rows: readonly Row[],
  field: RegisterCheckField,
): Row[] {
  return rows
    .filter((row) => row.registerCheck[field] === "explained")
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- facts the page states ----------------------------------------------------------------

/** "1st", "2nd", "3rd", "11th", "16th", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"
  return `${n}${suffix}`
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

/** Colleges whose financial year ends 31 July (the rest end 30 June). */
export const JULY_YEAR_END: readonly CollegeWealth[] = BY_ENDOWMENT.filter((row) =>
  row.financialYearEnd.endsWith("-07-31"),
).sort((a, b) => a.name.localeCompare(b.name))

/** Colleges whose income is the Charity Commission annual-return figure, not the accounts. */
export const INCOME_FROM_ANNUAL_RETURN: readonly CollegeWealth[] = COLLEGE_WEALTH.filter((row) =>
  row.incomeSource.startsWith("Income as filed in the Charity Commission annual return"),
)

/** Colleges that hold further money as current-asset (short-term) investments, left out here. */
export const SHORT_TERM_HOLDERS: readonly CollegeWealth[] = COLLEGE_WEALTH.filter((row) =>
  /current-asset\) investments|current-asset investments/.test(row.notes),
).sort((a, b) => a.name.localeCompare(b.name))

/**
 * Figures the page quotes from the colleges' notes. Each one is checked
 * against its row's notes in lib/college-wealth.test.ts, so a refresh of
 * college-wealth.json that drops one fails the tests.
 */
export const WEALTH_QUOTED = {
  trinityProperty: { slug: "trinity-college", text: "£1,174.1m" },
  hughesHallCollegesFundGrant: { slug: "hughes-hall", text: "£0.68m" },
} as const

// --- bars ----------------------------------------------------------------------------------

/**
 * The value a full bar stands for. When the top value is more than twice the
 * next (Trinity's endowment is over three times St John's), the scale is the
 * runner-up's, so the other 30 bars stay readable; bars beyond it are drawn
 * full and marked as cut off. Uses absolute values (a change can be negative).
 */
export function barScale(values: readonly number[]): number {
  const sorted = values
    .filter(Number.isFinite)
    .map(Math.abs)
    .sort((a, b) => b - a)
  const [top = 0, next = 0] = sorted
  return next > 0 && top > 2 * next ? next : top
}

/** A bar's width as a fraction 0–1 of the scale, and whether it was cut. */
export function barWidth(value: number, scale: number): { fraction: number; cut: boolean } {
  if (scale <= 0 || !Number.isFinite(value)) return { fraction: 0, cut: false }
  const fraction = Math.abs(value) / scale
  return fraction > 1 ? { fraction: 1, cut: true } : { fraction, cut: false }
}

// --- formatting ----------------------------------------------------------------------------

/** £2.70bn, £787.2m, £249k, £950. */
export function formatGbp(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? "−" : ""
  if (abs >= 1e9) return `${sign}£${(abs / 1e9).toFixed(2)}bn`
  if (abs >= 1e6) return `${sign}£${(abs / 1e6).toFixed(1)}m`
  if (abs >= 1e3) return `${sign}£${Math.round(abs / 1e3)}k`
  return `${sign}£${Math.round(abs)}`
}

/** +9.9%, −1.9%, 0.0%. */
export function formatPct(value: number): string {
  if (value === 0) return "0.0%"
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`
}

/** What a figure that cannot be worked out shows. */
export const NO_FIGURE = "–"

/** A metric's value as the table shows it. */
export function formatMetric(row: Figures, key: WealthSortKey): string {
  if (key !== "change") return formatGbp(metricValue(row, key))
  const pct = changePct(row)
  return pct === null ? NO_FIGURE : formatPct(pct)
}

/** "PDF p.46" from a source reference ("PDF p.46: Consolidated balance sheet…"). */
export function sourcePage(sourceRef: string): string {
  return sourceRef
    .split(":")[0]
    .replace(/\s*\(.*$/, "")
    .trim()
}

// --- the table's props ---------------------------------------------------------------------

/** One row as the client table gets it: only what it draws, numbers and
 * their text already worked out, so the table imports no data. */
export type WealthTableRow = {
  /** `university`: the University of Cambridge's own figures, shown for
   * context only when the reader asks (it is not a college and has no rank). */
  kind: "college" | "university"
  slug: string
  shortName: string
  name: string
  href: string
  /** Null for the University, which never shows a crest (DESIGN.md). */
  crest: CollegeInfo["crest"] | null
  values: Record<WealthSortKey, number>
  display: Record<WealthSortKey, string>
  financialYearEnd: string
  sourceUrl: string
  /** "Accounts, PDF p.46", or "Register" for a register year. */
  sourceLabel: string
  sourceRef: string
}

export type WealthTable = {
  rows: WealthTableRow[]
  /** Slugs in rank order for each sort key. */
  orders: Record<WealthSortKey, string[]>
  /** The value of a full bar for each sort key (`barScale`). */
  scales: Record<WealthSortKey, number>
  columns: { key: WealthSortKey; label: string }[]
  /** The University's row and the orders with it in, when the ranking's
   * year matches the University's figures; null otherwise. `scales` stay
   * the colleges' either way. */
  university: {
    row: WealthTableRow
    orders: Record<WealthSortKey, string[]>
    /** What the note under the table says about the row. */
    note: string
  } | null
}

function byKey<T>(make: (key: WealthSortKey) => T): Record<WealthSortKey, T> {
  return Object.fromEntries(WEALTH_SORT_KEYS.map((key) => [key, make(key)])) as Record<
    WealthSortKey,
    T
  >
}

type TableSource = Figures &
  Pick<WealthRow, "slug" | "college" | "financialYearEnd" | "sourceUrl" | "sourceRef"> & {
    basis?: WealthRow["basis"]
  }

export function wealthTable(
  rows: readonly TableSource[],
  hubPath: (college: CollegeInfo) => string,
  university: UniversityEndowment | null = null,
): WealthTable {
  const collegeRows: WealthTableRow[] = rows.map((row) => ({
    kind: "college",
    slug: row.slug,
    shortName: row.college.shortName,
    name: row.name,
    href: hubPath(row.college),
    crest: row.college.crest,
    values: byKey((key) => metricValue(row, key)),
    display: byKey((key) => formatMetric(row, key)),
    financialYearEnd: row.financialYearEnd,
    sourceUrl: row.sourceUrl,
    sourceLabel:
      row.basis === undefined || row.basis === "verified"
        ? `Accounts, ${sourcePage(row.sourceRef)}`
        : "Register",
    sourceRef: row.sourceRef,
  }))
  const universityRow = university ? universityTableRow(university) : null
  return {
    rows: collegeRows,
    orders: byKey((key) => rankedBy(rows, key).map((row) => row.slug)),
    scales: byKey((key) => barScale(rows.map((row) => metricValue(row, key)))),
    columns: WEALTH_SORT_KEYS.map((key) => ({ key, label: WEALTH_SORT_LABELS[key] })),
    university:
      university && universityRow
        ? {
            row: universityRow,
            orders: byKey((key) => orderByValue([...collegeRows, universityRow], key)),
            note: universityNote(university),
          }
        : null,
  }
}

/** Slugs highest first by a row's value; ties (and rows without a figure,
 * which are −∞) by name, as `rankedBy` orders the colleges. */
function orderByValue(rows: readonly WealthTableRow[], key: WealthSortKey): string[] {
  return [...rows]
    .sort((a, b) => b.values[key] - a.values[key] || a.name.localeCompare(b.name))
    .map((row) => row.slug)
}

/** The rows in order by `key`, with the University among them when
 * `withUniversity` is set and the table has it. */
export function tableRows(
  table: WealthTable,
  key: WealthSortKey,
  withUniversity: boolean,
): WealthTableRow[] {
  const shown = withUniversity ? table.university : null
  const bySlug = new Map(table.rows.map((row) => [row.slug, row]))
  if (shown) bySlug.set(shown.row.slug, shown.row)
  return (shown ? shown.orders : table.orders)[key].flatMap((slug) => bySlug.get(slug) ?? [])
}

/** Each row's rank among the colleges (1..N), by slug; the University has none. */
export function collegeRanks(rows: readonly WealthTableRow[]): Map<string, number> {
  const ranks = new Map<string, number>()
  for (const row of rows) if (row.kind === "college") ranks.set(row.slug, ranks.size + 1)
  return ranks
}

// --- the University (context, not a college) -----------------------------------------------

export type UniversityEndowment = typeof data.universityEndowment

/** The University row's id (the prose section's is `university`). */
export const UNIVERSITY_ROW_SLUG = "university-of-cambridge"
/** The page section that explains the University's endowment. */
export const UNIVERSITY_SECTION_ID = "university"

/**
 * The University of Cambridge as a table row. Its endowment is the part of
 * the Cambridge University Endowment Fund attributable to the University
 * group (the rest of the fund belongs to other investors, some of them
 * colleges, so the whole fund would count college money twice); net assets
 * and income are the University group's. It has no per-student figure: its
 * student numbers do not compare with a college's.
 */
export function universityTableRow(u: UniversityEndowment = UNIVERSITY_ENDOWMENT): WealthTableRow {
  const change = changePct({
    endowmentGbp: u.attributableToUniversityGroupGbp,
    endowmentPrevGbp: u.attributableToUniversityGroupPrevGbp,
  })
  const values: Record<WealthSortKey, number> = {
    endowment: u.attributableToUniversityGroupGbp,
    perStudent: Number.NEGATIVE_INFINITY,
    income: u.groupIncomeGbp,
    netAssets: u.groupNetAssetsGbp,
    change: change ?? Number.NEGATIVE_INFINITY,
  }
  return {
    kind: "university",
    slug: UNIVERSITY_ROW_SLUG,
    shortName: "University of Cambridge",
    name: "University of Cambridge",
    href: `#${UNIVERSITY_SECTION_ID}`,
    crest: null,
    values,
    display: byKey((key) => {
      if (key === "perStudent") return NO_FIGURE
      if (key === "change") return change === null ? NO_FIGURE : formatPct(change)
      return formatGbp(values[key])
    }),
    financialYearEnd: u.financialYearEnd,
    sourceUrl: u.sourceUrl,
    sourceLabel: `Financial statements, ${u.sourceRef.match(/PDF p\.\d+/)?.[0] ?? "PDF"}`,
    sourceRef: u.sourceRef,
  }
}

/** The note under the table while the University is shown. */
export function universityNote(u: UniversityEndowment = UNIVERSITY_ENDOWMENT): string {
  return (
    "The University of Cambridge is not a college, so it has no rank number and the colleges keep theirs. " +
    `Its endowment here is its ${formatGbp(u.attributableToUniversityGroupGbp)} share of the ` +
    `${formatGbp(u.netAssetValueGbp)} Cambridge University Endowment Fund; the rest belongs to other ` +
    "investors, some of them colleges. Its net assets and income are the whole University group’s, " +
    `for ${u.financialYear} (the year to ${new Date(`${u.financialYearEnd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}). ` +
    "It has no per-student figure, as its student numbers do not compare with a college’s, so it comes last by that. " +
    "Its bars use the colleges’ scale."
  )
}
