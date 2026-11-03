import { addDays, DAY_MS, formatDayShort, isoDateMs } from "@/lib/calendar"
import { TERM_NAMES, type TermDatesRow } from "@/lib/term-week"
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
