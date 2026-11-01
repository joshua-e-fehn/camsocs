import { addDays, startOfWeek, weekdayIndex } from "./calendar"
import { TERM_SHORT, type TermDatesRow, termWeekOf } from "./term-week"

/**
 * The pure side of the week strip (components/molecules/week-strip.tsx):
 * which seven days a strip shows, how busy each looks, and the Cambridge
 * label above it. Dates are London ISO days (`YYYY-MM-DD`).
 */

export type DayCount = {
  /** `YYYY-MM-DD` (London). */
  date: string
  count: number
}

/** Monday to Sunday of the week holding `anchor`. */
export function weekDays(anchor: string): string[] {
  const monday = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

/** The Monday `step` weeks from the week holding `anchor`. */
export function shiftWeek(anchor: string, step: number): string {
  return addDays(startOfWeek(anchor), step * 7)
}

/**
 * The Monday a strip opens on for a view from `first` to `last` (inclusive
 * London days): the week holding `first`, except when the view starts today,
 * today is a Saturday or Sunday (fewer than three days of the week left) and
 * the view runs on past that Sunday. Then it is the coming week, so the
 * weekend's first screen is not six greyed-out past days. A chosen day, or a
 * range that ends this Sunday ("Today", "Weekend"), keeps its own week.
 */
export function stripAnchor(first: string, last: string, today: string): string {
  const monday = startOfWeek(first)
  const sunday = addDays(monday, 6)
  if (first !== today || last <= sunday || weekdayIndex(today) < 5) return monday
  return addDays(monday, 7)
}

/** `days`, each with its count from `counts` (a `{ day, count }` row as
 * `talks.dayCounts` returns it), 0 when it has none. */
export function withCounts(
  days: readonly string[],
  counts: readonly { day: string; count: number }[] | undefined,
): DayCount[] {
  const byDay = new Map((counts ?? []).map((row) => [row.day, row.count]))
  return days.map((date) => ({ date, count: byDay.get(date) ?? 0 }))
}

/** 0 (nothing) to 3 (the busiest day shown), for the density bar under a
 * day: relative to the strip's own busiest day, so a quiet week still reads. */
export function densityLevel(count: number, max: number): 0 | 1 | 2 | 3 {
  if (count <= 0 || max <= 0) return 0
  const share = count / max
  if (share > 2 / 3) return 3
  if (share > 1 / 3) return 2
  return 1
}

/** One letter per weekday, Monday first: the strip's column heads. */
export const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const

export function weekdayLetter(date: string): string {
  return WEEKDAY_LETTERS[weekdayIndex(date)]
}

/** "Today", "Tomorrow", or undefined for any other day. */
export function relativeDay(date: string, today: string): string | undefined {
  if (date === today) return "Today"
  if (date === addDays(today, 1)) return "Tomorrow"
  return undefined
}

/** The term week a day is in, "Mich · Wk 4", or undefined in the vacation. */
export function termWeekTag(date: string, terms: readonly TermDatesRow[]): string | undefined {
  for (const term of terms) {
    const week = termWeekOf(date, term)
    if (week !== undefined) return `${TERM_SHORT[term.term]} · Wk ${week}`
  }
  return undefined
}

/**
 * The strip's label for a week: the term week of its Thursday (when term
 * weeks start, so a Monday-first strip names the week most of it is in),
 * "Mich · Wk 4", or "Vacation" outside term.
 */
export function stripTermLabel(days: readonly string[], terms: readonly TermDatesRow[]): string {
  const thursday = days.find((day) => weekdayIndex(day) === 3) ?? days[0]
  return (thursday && termWeekTag(thursday, terms)) ?? "Vacation"
}
