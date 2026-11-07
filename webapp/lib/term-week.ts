import { DAY_MS, formatDayShort, isoDateMs, londonIsoDate } from "@/lib/calendar"
import { currentCampus } from "@/lib/campus"
import type { Term } from "@/lib/vocab"

/**
 * Where an instant sits in the Cambridge year, for the term clock strip, the
 * footer and term stamps: "MICH · WK 4 · SAT 31 OCT", or "VACATION · LENT
 * STARTS IN 9 WEEKS". Pure; the term dates come from `api.termDates.list`.
 *
 * The week rule is the one `termWeekLabel` (convex/lib/derived.ts) stamps on
 * events, so the strip and the event rows never disagree (term-week.test.ts
 * holds them together): Full Term starts on a Tuesday, a week runs Thursday
 * to Wednesday, Week 1 begins on the first Thursday of Full Term and Week 0
 * is the week before it. A term's weeks run until the last day of Full Term.
 *
 * The term names, the teaching weeks and the weekday a week starts on are
 * the campus's (`currentCampus()`, lib/campus, decision D8); for Cambridge
 * they are the literals above.
 */

const campus = currentCampus()

export type TermDatesRow = {
  academicYear: string
  term: Term
  fullTermStart: string
  fullTermEnd: string
}

export type TermClock =
  | {
      kind: "term"
      term: Term
      academicYear: string
      /** 0 (the week before Full Term) to 9 (Michaelmas' last part-week). */
      week: number
      /** London date, `YYYY-MM-DD`. */
      date: string
      fullTermStart: string
      fullTermEnd: string
    }
  | {
      kind: "vacation"
      date: string
      /** The next term we have dates for, if any. */
      next?: { term: Term; fullTermStart: string; inDays: number }
    }

/** "Michaelmas", "Lent", "Easter". */
export const TERM_NAMES = campus.terms.names as Readonly<Record<Term, string>>

/** The short names students use: "Mich", "Lent", "Easter". */
export const TERM_SHORT = campus.terms.short as Readonly<Record<Term, string>>

/** Teaching weeks in a Full Term. A term that runs past Week 8 (Michaelmas and
 * Lent, at 60 days from a Tuesday) ends in a short Week 9; Easter does not. */
export const TEACHING_WEEKS = campus.terms.teachingWeeks

/** The JS weekday a student week starts on (4 = Thursday). */
const WEEK_START = campus.facts.terms.weekStartJs

const WEEK_MS = 7 * DAY_MS

/** The Thursday Week 1 begins on: the first Thursday (the campus's week
 * start) on or after the start. */
function firstThursday(fullTermStart: string): number {
  const start = isoDateMs(fullTermStart)
  return start + ((WEEK_START - new Date(start).getUTCDay() + 7) % 7) * DAY_MS
}

/** The term week of London day `date` within `term`, or undefined outside
 * Week 0 … the end of Full Term. */
export function termWeekOf(date: string, term: TermDatesRow): number | undefined {
  const day = isoDateMs(date)
  const week = Math.floor((day - firstThursday(term.fullTermStart)) / WEEK_MS) + 1
  if (week < 0 || day > isoDateMs(term.fullTermEnd)) return undefined
  return week
}

/** Where `ms` falls: a term week, or the vacation before the next term. */
export function termClock(ms: number, terms: readonly TermDatesRow[]): TermClock {
  const date = londonIsoDate(ms)
  const sorted = [...terms].sort((a, b) => a.fullTermStart.localeCompare(b.fullTermStart))
  for (const term of sorted) {
    const week = termWeekOf(date, term)
    if (week === undefined) continue
    return {
      kind: "term",
      term: term.term,
      academicYear: term.academicYear,
      week,
      date,
      fullTermStart: term.fullTermStart,
      fullTermEnd: term.fullTermEnd,
    }
  }
  const next = sorted.find((term) => term.fullTermStart > date)
  return {
    kind: "vacation",
    date,
    next: next && {
      term: next.term,
      fullTermStart: next.fullTermStart,
      inDays: Math.round((isoDateMs(next.fullTermStart) - isoDateMs(date)) / DAY_MS),
    },
  }
}

/** "tomorrow", "in 5 days", "in 9 weeks". */
export function startsIn(days: number): string {
  if (days <= 1) return "tomorrow"
  if (days < 14) return `in ${days} days`
  return `in ${Math.round(days / 7)} weeks`
}

/** The strip's words, as segments joined with " · " (shown upper-case):
 * ["Mich", "Wk 4", "Sat 31 Oct"] or ["Vacation", "Lent starts in 9 weeks"]. */
export function termClockParts(clock: TermClock): string[] {
  const day = formatDayShort(clock.date)
  if (clock.kind === "term") return [TERM_SHORT[clock.term], `Wk ${clock.week}`, day]
  if (!clock.next) return ["Vacation", day]
  return ["Vacation", `${TERM_NAMES[clock.next.term]} starts ${startsIn(clock.next.inDays)}`]
}

/** "MICH · WK 4 · SAT 31 OCT" (for titles and alt text; the strip styles
 * the parts itself). */
export function termClockLabel(clock: TermClock): string {
  return termClockParts(clock).join(" · ").toUpperCase()
}

/** "Week 4 of 8", "Week 0", "Week 9" — the footer's line for a term week. */
export function weekOfTerm(week: number): string {
  return week >= 1 && week <= TEACHING_WEEKS ? `Week ${week} of ${TEACHING_WEEKS}` : `Week ${week}`
}
