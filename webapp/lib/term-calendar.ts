import {
  addDays,
  DAY_MS,
  dayName,
  formatDayShort,
  formatMonth,
  isoDateMs,
  londonIsoDate,
  monthShort,
} from "@/lib/calendar"
import { TERM_NAMES, type TermDatesRow, termClock } from "@/lib/term-week"
import { TERMS } from "@/lib/vocab"

/**
 * The /term-dates page's tables (SEO audit 2026-11-02,
 * answer-and-editorial-content): the Full Term dates the site already reads
 * (`termDates`, from the University's published page) and the week numbers
 * the term clock uses (lib/term-week.ts), laid out by academic year and week.
 * Nothing here is new data: every date is a stored one or follows from one by
 * the week rule. Pure.
 */

/** One numbered week of a term: Thursday to Wednesday, the last cut at the
 * end of Full Term. London dates, `YYYY-MM-DD`. */
export type TermWeek = { week: number; from: string; to: string }

/** The Thursday Week 1 begins on (lib/term-week.ts, the same rule). */
function firstThursday(fullTermStart: string): string {
  const weekday = new Date(isoDateMs(fullTermStart)).getUTCDay()
  return addDays(fullTermStart, (4 - weekday + 7) % 7)
}

/** Week 0 (the week before Week 1) to the week Full Term ends in. */
export function termWeeks(term: Pick<TermDatesRow, "fullTermStart" | "fullTermEnd">): TermWeek[] {
  const weeks: TermWeek[] = []
  let from = addDays(firstThursday(term.fullTermStart), -7)
  for (let week = 0; from <= term.fullTermEnd; week += 1) {
    const wednesday = addDays(from, 6)
    weeks.push({ week, from, to: wednesday < term.fullTermEnd ? wednesday : term.fullTermEnd })
    from = addDays(from, 7)
  }
  return weeks
}

/** Days from start to end of Full Term, both included. */
export function fullTermDays(term: Pick<TermDatesRow, "fullTermStart" | "fullTermEnd">): number {
  return Math.round((isoDateMs(term.fullTermEnd) - isoDateMs(term.fullTermStart)) / DAY_MS) + 1
}

/** The rows by academic year, years and terms in calendar order. */
export function byAcademicYear<T extends TermDatesRow>(
  rows: readonly T[],
): { academicYear: string; terms: T[] }[] {
  const years = [...new Set(rows.map((row) => row.academicYear))].sort()
  return years.map((academicYear) => ({
    academicYear,
    terms: rows
      .filter((row) => row.academicYear === academicYear)
      .sort((a, b) => TERMS.indexOf(a.term) - TERMS.indexOf(b.term)),
  }))
}

/** "2026–27" (an en dash, as the University writes it). */
export function academicYearLabel(academicYear: string): string {
  return academicYear.replace("-", "–")
}

/** "Michaelmas 2026", for a heading. */
export function termTitle(term: Pick<TermDatesRow, "term" | "fullTermStart">): string {
  return `${TERM_NAMES[term.term]} ${term.fullTermStart.slice(0, 4)}`
}

/** "Tue 6 Oct 2026". */
export function formatDayWithYear(iso: string): string {
  return `${formatDayShort(iso)} ${iso.slice(0, 4)}`
}

// --- search-facing words (GSC 3–7 Nov 2026: the page's queries are
// "cambridge term dates 2026/27", "lent term 2027", "when does michaelmas term
// end", …; the title, description and question headings answer them from the
// stored dates, so they move on by themselves as the terms pass) ------------

/** "Tuesday 19 January 2027". */
export function formatDayLong(iso: string): string {
  return `${dayName(new Date(isoDateMs(iso)).getUTCDay())} ${Number(iso.slice(8, 10))} ${formatMonth(iso)}`
}

/** "19 Jan". */
function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${monthShort(iso)}`
}

function sortedTerms<T extends TermDatesRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.fullTermStart.localeCompare(b.fullTermStart))
}

/** The first term whose Full Term starts after London day `date`. */
export function nextTerm<T extends TermDatesRow>(rows: readonly T[], date: string): T | undefined {
  return sortedTerms(rows).find((row) => row.fullTermStart > date)
}

/** The terms whose Full Term has not ended by `date`, in order. */
export function upcomingTerms<T extends TermDatesRow>(rows: readonly T[], date: string): T[] {
  return sortedTerms(rows).filter((row) => row.fullTermEnd >= date)
}

/** The academic year whose dates lead the page: the one the current or next
 * term belongs to, else the latest. */
export function leadingYear(rows: readonly TermDatesRow[], ms: number): string | undefined {
  const clock = termClock(ms, rows)
  const start = clock.kind === "term" ? clock.fullTermStart : clock.next?.fullTermStart
  return (
    rows.find((row) => row.fullTermStart === start)?.academicYear ??
    sortedTerms(rows).at(-1)?.academicYear
  )
}

/**
 * The page title: the year searchers look for and the next start date, e.g.
 * "Cambridge term dates 2026–27: Lent 2027 starts 19 Jan". The year is the
 * next term's, so in Easter Term it already looks ahead to the next year.
 */
export function termDatesTitle(rows: readonly TermDatesRow[], ms: number): string {
  const date = londonIsoDate(ms)
  const next = nextTerm(rows, date)
  const year = next?.academicYear ?? leadingYear(rows, ms)
  const base = year ? `Cambridge term dates ${academicYearLabel(year)}` : "Cambridge term dates"
  return next ? `${base}: ${termTitle(next)} starts ${dayMonth(next.fullTermStart)}` : base
}

/**
 * The meta description: the dates themselves, so a result answers the
 * question before the click. "Full Term: Michaelmas 2026 6 Oct–4 Dec, Lent
 * 2027 19 Jan–19 Mar, Easter 2027 27 Apr–18 Jun. …"
 */
export function termDatesDescription(rows: readonly TermDatesRow[], ms: number): string {
  const terms = upcomingTerms(rows, londonIsoDate(ms)).slice(0, 3)
  const tail = "Plus which week of term it is today."
  if (terms.length === 0)
    return `Cambridge Full Term dates for Michaelmas, Lent and Easter. ${tail}`
  const list = terms
    .map((t) => `${termTitle(t)} ${dayMonth(t.fullTermStart)}–${dayMonth(t.fullTermEnd)}`)
    .join(", ")
  return `Full Term: ${list}. ${tail}`
}

/** A term as a question and its answer, for the page's "key dates". */
export type TermAnswer = { id: string; question: string; answer: string }

/** "When is Lent Term 2027?" — "Full Term runs from Tuesday 19 January to
 * Friday 19 March 2027. Week 1 starts on Thursday 21 January." */
export function termAnswer(term: TermDatesRow): TermAnswer {
  const weekOne = termWeeks(term).find((week) => week.week === 1)
  const start = formatDayLong(term.fullTermStart)
  const sameYear = term.fullTermStart.slice(0, 4) === term.fullTermEnd.slice(0, 4)
  const from = sameYear ? start.replace(/ \d{4}$/, "") : start
  return {
    id: `${term.term}-${term.fullTermStart.slice(0, 4)}`,
    question: `When is ${TERM_NAMES[term.term]} Term ${term.fullTermStart.slice(0, 4)}?`,
    answer:
      `Full Term runs from ${from} to ${formatDayLong(term.fullTermEnd)}.` +
      (weekOne ? ` Week 1 starts on ${formatDayLong(weekOne.from).replace(/ \d{4}$/, "")}.` : ""),
  }
}

/** "Michaelmas (October to December), Lent (January to March) and Easter
 * (April to June)", from one academic year's dates. */
export function termSeasons(terms: readonly TermDatesRow[]): string {
  const month = (iso: string) => formatMonth(iso).split(" ")[0]
  const parts = sortedTerms(terms).map(
    (t) => `${TERM_NAMES[t.term]} (${month(t.fullTermStart)} to ${month(t.fullTermEnd)})`,
  )
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "")
}
