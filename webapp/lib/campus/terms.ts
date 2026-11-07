import { addDays, DAY_MS, isoDateMs, londonIsoDate } from "../calendar"
import type { TermModel } from "./profile"

/**
 * Term weeks under a campus's term model, as pure functions (decision D8).
 *
 * Cambridge's convention (as Camdram and CUCBC label weeks): Full Term
 * starts on a Tuesday and a student week runs Thursday to Wednesday, so Week
 * 1 begins on the first Thursday of Full Term and Week 0 is the week before.
 * Another campus states its own week start (`weekStartJs`, e.g. Sunday).
 * Labels run from Week `minWeek` to the last day of Full Term.
 */

/** The part of a `termDates` row the week rule reads. */
export type TermSpanDates = {
  term: string
  fullTermStart: string
  fullTermEnd: string
}

/** The first day of Week 1 (`YYYY-MM-DD`): the first `weekStartJs` weekday
 * on or after the start of Full Term. */
export function firstWeekStart(fullTermStart: string, model: TermModel): string {
  const weekday = new Date(isoDateMs(fullTermStart)).getUTCDay()
  return addDays(fullTermStart, (model.weekStartJs - weekday + 7) % 7)
}

/**
 * "MT26 Wk 3" for an instant inside a term's labelled weeks, else undefined:
 * the London day's week counted from `firstWeekStart`, from Week `minWeek`
 * to the last day of Full Term (the last week ends with Full Term:
 * Michaelmas 2026's Week 9 is Thu 3 – Fri 4 Dec, source-research §19).
 */
export function termWeekLabel(
  ms: number,
  terms: readonly TermSpanDates[],
  model: TermModel,
): string | undefined {
  const day = isoDateMs(londonIsoDate(ms))
  for (const term of terms) {
    const start = isoDateMs(term.fullTermStart)
    const end = isoDateMs(term.fullTermEnd)
    const weekOne = isoDateMs(firstWeekStart(term.fullTermStart, model))
    const week = Math.floor((day - weekOne) / (7 * DAY_MS)) + 1
    if (week < model.minWeek || day > end) continue
    const year = new Date(start).getUTCFullYear() % 100
    const parts: Record<string, string> = {
      code: model.codes[term.term] ?? term.term,
      yy: String(year).padStart(2, "0"),
      week: String(week),
    }
    return model.labelFormat.replace(/\{(code|yy|week)\}/g, (_, name: string) => parts[name])
  }
  return undefined
}
