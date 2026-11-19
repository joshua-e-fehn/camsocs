import { formatDate, londonIsoDate } from "@/lib/calendar"
import {
  financialYearOf,
  type ResolvedWealthYear,
  resolveWealthYear,
  type TrendPoint,
  type VerifiedWealth,
  type YearProgress,
} from "@/lib/college-finances"
import {
  COLLEGE_WEALTH,
  type CollegeWealth,
  changePct,
  formatGbp,
  listNames,
  ordinal,
  perStudent,
  rankedBy,
  registerCheckCounts,
  registerExplained,
  UNIVERSITY_ENDOWMENT,
  WEALTH_CHECKED_ON,
  WEALTH_FINANCIAL_YEAR,
  WEALTH_PATH,
  WEALTH_PUBLISHED_ON,
  WEALTH_QUOTED,
  type WealthRow,
  type WealthTotals,
  wealthTotals,
} from "@/lib/college-wealth"
import { COLLEGES_PATH } from "@/lib/colleges"
import { MAX_DESCRIPTION_LENGTH } from "@/lib/page-metadata"

/**
 * What /colleges/wealth shows (ENG-272): the year `resolveWealthYear` picks
 * (lib/college-finances.ts), its 31 rows, the trend, and every sentence the
 * title, description, lede, FAQ and JSON-LD say, all worked out from the
 * data. Nothing in the copy is typed by hand, so when the register's next
 * complete year takes over, every SEO surface moves with it at once.
 *
 * Pure: the page, the CSV, the share card and each college's hub page build
 * it from the same inputs (`loadWealthView` in lib/college-wealth-data.ts
 * reads Convex for them).
 */

/** The verified dataset as `resolveWealthYear` takes it. */
export const VERIFIED_WEALTH: readonly VerifiedWealth[] = COLLEGE_WEALTH.map((row) => ({
  slug: row.slug,
  financialYearEnd: row.financialYearEnd,
  endowmentGbp: row.endowmentGbp,
  endowmentPrevGbp: row.endowmentPrevGbp,
  netAssetsGbp: row.netAssetsGbp,
  incomeGbp: row.incomeGbp,
}))

/** When the register data last changed and was last read (epoch ms), from
 * `collegeFinances.latestCompleteYear`. */
export type RegisterMeta = { updatedAt: number | null; retrievedAt: number | null }

export type WealthView = {
  /** "2024-25": the year the ranking shows. */
  financialYear: string
  /** The dataset's year (read from the accounts). */
  verifiedYear: string
  /** `verified` while the dataset's year is shown; `register` once a later
   * complete year from the register takes over. */
  basis: "verified" | "register"
  /** In the dataset's order. */
  rows: WealthRow[]
  byEndowment: WealthRow[]
  totals: WealthTotals<WealthRow>
  /** Slug → endowment by year, oldest first (gaps left out). */
  trends: Record<string, TrendPoint[]>
  /** The years the trend spans, oldest first, each with at least one figure. */
  trendYears: string[]
  next: YearProgress
  /** `YYYY-MM-DD`: the page's "Updated" date and `dateModified`. */
  updatedOn: string
  publishedOn: string
  /** `YYYY-MM-DD` the register was last read, when Convex says. */
  registerReadOn: string | null
}

const REGISTER_SOURCE_REF = "Charity Commission register: annual return, Part B"

function registerRow(row: CollegeWealth, figures: ResolvedWealthYear["rows"][number]): WealthRow {
  return {
    ...row,
    financialYearEnd: figures.periodEnd,
    endowmentGbp: figures.endowmentGbp,
    endowmentPrevGbp: figures.endowmentPrevGbp ?? null,
    netAssetsGbp: figures.netAssetsGbp,
    incomeGbp: figures.incomeGbp,
    endowmentPerStudentGbp: perStudent({
      endowmentGbp: figures.endowmentGbp,
      students: row.students,
    }),
    endowmentChangePct:
      changePct({
        endowmentGbp: figures.endowmentGbp,
        endowmentPrevGbp: figures.endowmentPrevGbp ?? null,
      }) ?? 0,
    incomeSource: "Income as filed in the Charity Commission annual return (Part B)",
    sourceUrl: row.sourceRegisterUrl,
    sourceRef: REGISTER_SOURCE_REF,
    collegeAccountsUrl: null,
    // The notes describe the dataset's year; a register year has none.
    notes: "",
    basis: figures.basis === "verified" ? "verified" : figures.basis,
  }
}

/** The view from the dataset and what Convex holds (null when it could
 * not be read, or holds nothing). */
export function wealthView(
  resolved: ResolvedWealthYear,
  meta: RegisterMeta | null = null,
): WealthView {
  const bySlug = new Map(resolved.rows.map((row) => [row.slug, row]))
  const rows: WealthRow[] = COLLEGE_WEALTH.map((row) => {
    const figures = bySlug.get(row.slug)
    if (!figures || figures.basis === "verified") return { ...row, basis: "verified" }
    return registerRow(row, figures)
  })
  const trendYears = [
    ...new Set(
      Object.values(resolved.trends).flatMap((points) => points.map((p) => p.financialYear)),
    ),
  ].sort()
  const updatedOn =
    resolved.basis === "register" && meta?.updatedAt
      ? londonIsoDate(meta.updatedAt)
      : WEALTH_CHECKED_ON
  return {
    financialYear: resolved.financialYear,
    verifiedYear: WEALTH_FINANCIAL_YEAR,
    basis: resolved.basis,
    rows,
    byEndowment: rankedBy(rows, "endowment"),
    totals: wealthTotals(rows),
    trends: resolved.trends,
    trendYears,
    next: resolved.next,
    updatedOn,
    publishedOn: WEALTH_PUBLISHED_ON,
    registerReadOn: meta?.retrievedAt ? londonIsoDate(meta.retrievedAt) : null,
  }
}

/** The view without Convex: the verified year alone. */
export function staticWealthView(): WealthView {
  return wealthView(resolveWealthYear(VERIFIED_WEALTH, null))
}

// --- small facts ---------------------------------------------------------------------------

/** "Trinity’s", "St John’s" (already possessive), "Jesus’", "Queens’". */
export function possessive(name: string): string {
  if (/[’']s?$/.test(name)) return name
  return name.endsWith("s") ? `${name}’` : `${name}’s`
}

/** "30 June 2025" (long month: the snippet sentence). */
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
export function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  return `${day} ${LONG_MONTHS[month - 1]} ${year}`
}

/** The richest college's endowment as a multiple of the runner-up's: "3.4". */
export function richestMultiple(view: WealthView): string {
  const [first, second] = view.byEndowment
  return (first.endowmentGbp / second.endowmentGbp).toFixed(1)
}

export function sharePct(view: WealthView): string {
  return `${(view.totals.richestShare * 100).toFixed(1)}%`
}

/** A college's rank (1 = most) by endowment. */
export function endowmentRank(view: WealthView, slug: string): number {
  return view.byEndowment.findIndex((row) => row.slug === slug) + 1
}

/** The students' year most rows share ("2025-26"), and the colleges whose
 * year differs. */
export function studentsYears(view: WealthView): { main: string; others: WealthRow[] } {
  const counts = new Map<string, number>()
  for (const row of view.rows) counts.set(row.studentsYear, (counts.get(row.studentsYear) ?? 0) + 1)
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return { main, others: view.rows.filter((row) => row.studentsYear !== main) }
}

/** "for 2025-26 (Girton: 2024-25)". */
export function studentsYearText(view: WealthView): string {
  const { main, others } = studentsYears(view)
  if (others.length === 0) return `for ${main}`
  return `for ${main} (${others.map((row) => `${row.college.shortName}: ${row.studentsYear}`).join("; ")})`
}

/** Whether the student numbers are a later year than the accounts. */
export function studentsLater(view: WealthView): boolean {
  return studentsYears(view).main > view.financialYear
}

/** The period ends the shown year's rows use, latest last: ["2025-06-30", "2025-07-31"]. */
export function yearEnds(view: WealthView): string[] {
  return [...new Set(view.rows.map((row) => row.financialYearEnd))].sort()
}

/** The colleges whose year ends on `periodEnd`, by name. */
export function yearEndColleges(view: WealthView, periodEnd: string): WealthRow[] {
  return view.rows
    .filter((row) => row.financialYearEnd === periodEnd)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** "30 June 2025 for most, 31 July 2025 for Emmanuel, Fitzwilliam and Hughes Hall". */
export function yearEndText(view: WealthView): string {
  const ends = yearEnds(view)
  if (ends.length === 1) return longDate(ends[0])
  const groups = ends
    .map((end) => ({ end, colleges: yearEndColleges(view, end) }))
    .sort((a, b) => b.colleges.length - a.colleges.length)
  const [main, ...rest] = groups
  return [
    `${longDate(main.end)} for most`,
    ...rest.map(
      (group) =>
        `${longDate(group.end)} for ${listNames(group.colleges.map((row) => row.college.shortName))}`,
    ),
  ].join(", ")
}

/** The accounts period the rows cover: "2024-07-01/2025-07-31". */
export function temporalCoverage(view: WealthView): string {
  const ends = yearEnds(view)
  const [year, month, day] = ends[0].split("-").map(Number)
  const start = new Date(Date.UTC(year - 1, month - 1, day + 1)).toISOString().slice(0, 10)
  return `${start}/${ends.at(-1)}`
}

// --- title, description, lede -------------------------------------------------------------

export const WEALTH_CRUMB = "Ranked by endowment"
export const WEALTH_H1 = "Cambridge colleges ranked by endowment, richest to poorest"

export function wealthTitle(view: WealthView): string {
  return `Richest Cambridge colleges ranked: endowments ${view.financialYear}`
}

/**
 * At most `MAX_DESCRIPTION_LENGTH` characters, both ends of the ranking in
 * it ("richest" and "poorest" searches); shorter forms when a longer name
 * or figure would overflow.
 */
export function wealthDescription(view: WealthView): string {
  const { richest, poorest } = view.totals
  const count = view.rows.length
  const from = view.basis === "verified" ? "accounts" : "filings"
  const head = `All ${count} Cambridge colleges ranked by endowment, from ${possessive(richest.college.shortName)} ${formatGbp(richest.endowmentGbp)} to ${possessive(poorest.college.shortName)} ${formatGbp(poorest.endowmentGbp)}`
  const forms = [
    `${head}, with per-student figures and net assets from ${view.financialYear} ${from}.`,
    `${head}, with net assets, from ${view.financialYear} ${from}.`,
    `${head}, from ${view.financialYear} ${from}.`,
    `${head}.`,
  ]
  return forms.find((text) => text.length <= MAX_DESCRIPTION_LENGTH) ?? forms[forms.length - 1]
}

/** The first paragraph: the answer to "which is the richest Cambridge college". */
export function wealthLede(view: WealthView): string {
  const { richest } = view.totals
  const runnerUp = view.byEndowment[1]
  return `${richest.college.name} is the richest Cambridge college: its investments were worth ${formatGbp(richest.endowmentGbp)} at ${longDate(richest.financialYearEnd)}, about ${richestMultiple(view)} times ${possessive(runnerUp.college.shortName)} (${formatGbp(runnerUp.endowmentGbp)}) and ${sharePct(view)} of all ${view.rows.length} colleges’ endowments combined.`
}

export function wealthLedePoorest(view: WealthView): string {
  const { poorest } = view.totals
  return `The smallest endowment is ${possessive(poorest.college.shortName)}, at ${formatGbp(poorest.endowmentGbp)}.`
}

/** The register cross-check, said on the page (the dataset's year). */
export function registerCheckText(): string {
  const counts = registerCheckCounts(COLLEGE_WEALTH)
  const explained = registerExplained(COLLEGE_WEALTH, "endowment").map(
    (row) => row.college.shortName,
  )
  const all = counts.colleges
  return `Every ${WEALTH_FINANCIAL_YEAR} figure was read from the accounts each college filed and cross-checked against the Charity Commission register: net assets match for ${counts.netAssets} of ${all} colleges and investments for ${counts.endowment} of ${all}${explained.length > 0 ? `, with ${listNames(explained)} explained in the notes` : ""}.`
}

/** "Updated 19 Nov 2026 · 2024-25 accounts, the latest year every college has filed". */
export function freshnessText(view: WealthView): string {
  const what =
    view.basis === "verified"
      ? `${view.financialYear} accounts`
      : `${view.financialYear} figures from the Charity Commission register`
  return `Updated ${formatDate(view.updatedOn)} · ${what}, the latest year every college has filed`
}

/** "12 of 31 colleges have filed their 2025-26 accounts; the ranking moves to 2025-26 once all 31 have." */
export function nextYearText(view: WealthView): string | null {
  const { filed, total, financialYear } = view.next
  if (filed === 0) return null
  return `${filed} of ${total} colleges have filed their ${financialYear} accounts with the Charity Commission so far; the ranking moves to ${financialYear} once all ${total} have, and their figures pass our checks.`
}

/** The one-line fact on a college's hub page. */
export function hubWealthFact(view: WealthView, slug: string) {
  const row = view.rows.find((entry) => entry.slug === slug)
  if (!row) return null
  return {
    row,
    rank: endowmentRank(view, slug),
    count: view.rows.length,
    text: `Endowment ${formatGbp(row.endowmentGbp)} (${ordinal(endowmentRank(view, slug))} of ${view.rows.length}, ${view.financialYear}) · ${formatGbp(perStudent(row))} per student`,
    href: `${WEALTH_PATH}#${slug}`,
    linkText: `${possessive(row.college.shortName)} endowment, ranked`,
  }
}

// --- the trend -----------------------------------------------------------------------------

export type TrendRow = {
  row: WealthRow
  /** One cell per `view.trendYears`, null for a year without a figure. */
  cells: (TrendPoint | null)[]
  /** The change from the first year to the last, when both are known. */
  changePct: number | null
}

export function trendRows(view: WealthView): TrendRow[] {
  return view.byEndowment.map((row) => {
    const points = view.trends[row.slug] ?? []
    const cells = view.trendYears.map(
      (year) => points.find((point) => point.financialYear === year) ?? null,
    )
    const first = cells[0]
    const last = cells.at(-1) ?? null
    return {
      row,
      cells,
      changePct:
        first && last && first !== last && first.endowmentGbp > 0
          ? Math.round(((last.endowmentGbp - first.endowmentGbp) / first.endowmentGbp) * 1000) / 10
          : null,
    }
  })
}

/** All colleges' endowments added up, for the years every college has a figure. */
export function trendTotals(view: WealthView): (number | null)[] {
  return view.trendYears.map((year) => {
    let sum = 0
    for (const row of view.rows) {
      const point = view.trends[row.slug]?.find((p) => p.financialYear === year)
      if (!point) return null
      sum += point.endowmentGbp
    }
    return sum
  })
}

/** The colleges whose endowment grew most over the shown year. */
export function biggestRisers(view: WealthView, n = 5): WealthRow[] {
  return rankedBy(view.rows, "change")
    .filter((row) => changePct(row) !== null)
    .slice(0, n)
}

// --- the questions -------------------------------------------------------------------------

/** A run of answer text, or a link inside it. */
export type FaqPart = string | { text: string; href: string }

export type WealthFaq = { id: string; question: string; answer: FaqPart[] }

/** An answer as plain text (the FAQPage JSON-LD; the same words the page shows). */
export function faqText(parts: readonly FaqPart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.text)).join("")
}

/** The trinity row of the dataset (its notes describe the verified year). */
function verifiedRow(slug: string): CollegeWealth | undefined {
  return COLLEGE_WEALTH.find((row) => row.slug === slug)
}

/** The college whose rank moves most from endowment to net assets, among
 * the top five by net assets: King's, 8th by endowment but 3rd by net assets. */
export function netAssetsMover(view: WealthView) {
  const byNet = rankedBy(view.rows, "netAssets")
  let best: { row: WealthRow; endowmentRank: number; netAssetsRank: number } | null = null
  byNet.slice(0, 5).forEach((row, index) => {
    const rank = endowmentRank(view, row.slug)
    const gain = rank - (index + 1)
    if (gain > 0 && (!best || gain > best.endowmentRank - best.netAssetsRank)) {
      best = { row, endowmentRank: rank, netAssetsRank: index + 1 }
    }
  })
  return best as { row: WealthRow; endowmentRank: number; netAssetsRank: number } | null
}

export function wealthFaqs(view: WealthView): WealthFaq[] {
  const { richest, poorest, total, netAssetsTotal } = view.totals
  const runnerUp = view.byEndowment[1]
  const count = view.rows.length
  const year = view.financialYear
  const byStudent = rankedBy(view.rows, "perStudent")
  const [topStudent, secondStudent, thirdStudent] = byStudent
  const lowestStudent = byStudent.at(-1) ?? poorest
  const trinity = verifiedRow(WEALTH_QUOTED.trinityProperty.slug)
  const shown = view.rows.find((row) => row.slug === WEALTH_QUOTED.trinityProperty.slug)
  const mover = netAssetsMover(view)
  const later = studentsLater(view)
  const counts = registerCheckCounts(COLLEGE_WEALTH)

  const faqs: WealthFaq[] = [
    {
      id: "richest",
      question: "Which is the richest Cambridge college?",
      answer: [
        `${richest.college.name}, with investments of ${formatGbp(richest.endowmentGbp)} at the end of ${year}: about ${richestMultiple(view)} times the next, ${runnerUp.college.name} (${formatGbp(runnerUp.endowmentGbp)}), and ${sharePct(view)} of all ${count} colleges’ endowments together.`,
      ],
    },
  ]
  if (trinity && shown) {
    faqs.push({
      id: "trinity-worth",
      question: "How much is Trinity College Cambridge worth?",
      answer: [
        `At the end of ${year} Trinity’s investments were worth ${formatGbp(shown.endowmentGbp)} and its net assets, everything it owns less everything it owes, ${formatGbp(shown.netAssetsGbp)}.`,
        shown.endowmentGbp > shown.netAssetsGbp && view.basis === "verified"
          ? " Its investments are larger than its net assets because the college has borrowed."
          : "",
        ` It is ${ordinal(endowmentRank(view, shown.slug))} of ${count} by endowment.`,
      ],
    })
    faqs.push({
      id: "trinity-why",
      question: "Why is Trinity College so rich?",
      answer: [
        `Much of its wealth is property. Trinity’s ${WEALTH_FINANCIAL_YEAR} investments of ${formatGbp(trinity.endowmentGbp)} include ${WEALTH_QUOTED.trinityProperty.text} of property, according to `,
        { text: "its accounts", href: trinity.sourceUrl },
        ".",
        trinity.endowmentGbp > trinity.netAssetsGbp
          ? ` The college also borrows: its investments are larger than its net assets (${formatGbp(trinity.netAssetsGbp)}).`
          : "",
      ],
    })
  }
  faqs.push(
    {
      id: "poorest",
      question: "Which is the poorest Cambridge college?",
      answer: [
        `By endowment, ${poorest.college.name}, with ${formatGbp(poorest.endowmentGbp)} at the end of ${year}. ${
          lowestStudent.slug === poorest.slug
            ? `It is also the smallest per student, at ${formatGbp(perStudent(lowestStudent))} for each of its ${lowestStudent.students.toLocaleString("en-GB")} students.`
            : `Per student, the smallest is ${lowestStudent.college.name}, at ${formatGbp(perStudent(lowestStudent))} for each of its ${lowestStudent.students.toLocaleString("en-GB")} students.`
        }`,
      ],
    },
    {
      id: "per-student",
      question: "Which Cambridge college has the most money per student?",
      answer: [
        `${topStudent.college.name}: ${formatGbp(perStudent(topStudent))} of endowment for each of its ${topStudent.students.toLocaleString("en-GB")} students. Next are ${secondStudent.college.shortName} (${formatGbp(perStudent(secondStudent))}) and ${thirdStudent.college.shortName} (${formatGbp(perStudent(thirdStudent))}). Student numbers are the University’s ${studentsYearText(view)}${later ? ", a later year than the accounts, so treat this as a guide" : ""}.`,
      ],
    },
    {
      id: "total",
      question: "How much are all the Cambridge colleges worth together?",
      answer: [
        `${formatGbp(total)} in investments across all ${count} colleges at the end of ${year}, adding up each college’s balance sheet; their net assets add up to ${formatGbp(netAssetsTotal)}. The colleges’ year ends differ by up to a month.`,
      ],
    },
    {
      id: "university",
      question: "What is the Cambridge University endowment, and is it included?",
      answer: [
        `It is not included. The University is a separate body from the colleges. The Cambridge University Endowment Fund had a net asset value of ${formatGbp(UNIVERSITY_ENDOWMENT.netAssetValueGbp)} at ${longDate(UNIVERSITY_ENDOWMENT.asAt)}, of which ${formatGbp(UNIVERSITY_ENDOWMENT.attributableToUniversityGroupGbp)} belongs to the University, according to its `,
        {
          text: `Reports and Financial Statements ${financialYearOf(UNIVERSITY_ENDOWMENT.asAt)}`,
          href: UNIVERSITY_ENDOWMENT.sourceUrl,
        },
        ". Some colleges invest through that fund, so the two figures overlap and should not be added together.",
      ],
    },
    {
      id: "other-rankings",
      question: "Why do other rankings give different figures?",
      answer: [
        "Many rankings of college wealth use net assets, or older accounts. Net assets count everything a college owns, its buildings included, less what it owes; the endowment here is only its investments.",
        mover
          ? ` ${mover.row.college.shortName}, for one, is ${ordinal(mover.endowmentRank)} by endowment but ${ordinal(mover.netAssetsRank)} by net assets (${formatGbp(mover.row.netAssetsGbp)}).`
          : "",
        view.basis === "verified"
          ? ` The net assets in our table match the Charity Commission register for ${counts.netAssets} of ${counts.colleges} colleges.`
          : "",
      ],
    },
    {
      id: "best",
      question: "Is the richest college the best or the cheapest to live at?",
      answer: [
        "These figures don’t say. An endowment is money invested, not money spent: it does not show what a college spends on its students, what its rooms or formals cost, or what bursaries it gives. ",
        { text: "Each college’s page", href: COLLEGES_PATH },
        " lists its societies and formal hall rules, and ",
        { text: "the formals calendar", href: "/formals" },
        " shows which colleges hold formal hall each night.",
      ],
    },
  )
  return faqs
}

// --- the CSV -------------------------------------------------------------------------------

const CSV_COLUMNS = [
  "rank",
  "college",
  "charity_number",
  "financial_year",
  "financial_year_end",
  "endowment_gbp",
  "endowment_prev_gbp",
  "endowment_change_pct",
  "net_assets_gbp",
  "income_gbp",
  "students",
  "students_year",
  "endowment_per_student_gbp",
  "basis",
  "source_url",
  "source_ref",
  "register_url",
] as const

function csvCell(value: string | number | null): string {
  if (value === null) return ""
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * The ranking as CSV (/colleges/wealth.csv), richest first: the page's own
 * figures, with each row's source. Comment lines (`#`) above the header give
 * the source, the licence of the register data and the date.
 */
export function wealthCsv(view: WealthView, licence: string, pageUrl: string): string {
  const lines = [
    `# Cambridge college endowments ${view.financialYear}, ranked by endowment. From ${pageUrl} (CAMsocs, unofficial), updated ${view.updatedOn}.`,
    `# Figures ${view.basis === "verified" ? "read from each college's filed accounts and cross-checked against" : "as filed in each college's annual return on"} the Charity Commission register for England and Wales. ${licence}`,
    CSV_COLUMNS.join(","),
    ...view.byEndowment.map((row, index) =>
      [
        index + 1,
        row.college.name,
        row.charityNumber,
        view.financialYear,
        row.financialYearEnd,
        row.endowmentGbp,
        row.endowmentPrevGbp,
        changePct(row),
        row.netAssetsGbp,
        row.incomeGbp,
        row.students,
        row.studentsYear,
        perStudent(row),
        row.basis,
        row.sourceUrl,
        row.sourceRef,
        row.sourceRegisterUrl,
      ]
        .map(csvCell)
        .join(","),
    ),
  ]
  return `${lines.join("\n")}\n`
}
