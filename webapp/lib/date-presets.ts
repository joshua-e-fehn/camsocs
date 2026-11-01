import { addDays, weekdayIndex } from "./calendar"
import type { TermDatesRow } from "./term-week"
import { termClock } from "./term-week"

/**
 * Quick date ranges for an agenda (talks-redesign-spec §6: "Today / This week
 * / Weekend / Rest of term"), as pure functions over London ISO dates, so the
 * talks page, the events page and their server preloads agree on a range.
 *
 * Every range starts today or later and is inclusive at both ends (`last`
 * is the last day shown). A week runs Monday to Sunday here, the way a
 * calendar app reads "this week"; the term week (Thursday to Wednesday) is
 * a label, never a range.
 */

export const DATE_PRESETS = ["today", "tomorrow", "week", "weekend", "term"] as const
export type DatePreset = (typeof DATE_PRESETS)[number]

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  weekend: "Weekend",
  term: "Rest of term",
}

export type DayRange = {
  /** `YYYY-MM-DD`, inclusive. */
  first: string
  /** `YYYY-MM-DD`, inclusive. */
  last: string
}

export function isDatePreset(value: string | undefined): value is DatePreset {
  return (DATE_PRESETS as readonly string[]).includes(value ?? "")
}

/**
 * The days a preset covers, seen from `today`:
 *  - today, tomorrow: that one day;
 *  - week: today to Sunday;
 *  - weekend: the coming Saturday and Sunday (from today when it is one);
 *  - term: today to the last day of the current Full Term (`termEnd`), or
 *    undefined in the vacation (there is no "rest of term" then).
 */
export function presetRange(
  preset: DatePreset,
  today: string,
  termEnd?: string,
): DayRange | undefined {
  const weekday = weekdayIndex(today) // 0 = Monday … 6 = Sunday
  switch (preset) {
    case "today":
      return { first: today, last: today }
    case "tomorrow": {
      const day = addDays(today, 1)
      return { first: day, last: day }
    }
    case "week":
      return { first: today, last: addDays(today, 6 - weekday) }
    case "weekend":
      return weekday >= 5
        ? { first: today, last: addDays(today, 6 - weekday) }
        : { first: addDays(today, 5 - weekday), last: addDays(today, 6 - weekday) }
    case "term":
      return termEnd && termEnd >= today ? { first: today, last: termEnd } : undefined
  }
}

/** The last day of the Full Term `today` falls in (Week 0 included), or
 * undefined in the vacation. */
export function currentTermEnd(today: string, terms: readonly TermDatesRow[]): string | undefined {
  // termClock takes an instant; noon UTC is always on `today` in London.
  const clock = termClock(Date.parse(`${today}T12:00:00Z`), terms)
  return clock.kind === "term" ? clock.fullTermEnd : undefined
}

/** Which of two presets with the same range stays: the narrower name ("Today"
 * over "This week" on a Sunday, "Weekend" over "This week" on a Saturday). */
const DEDUPE_ORDER: readonly DatePreset[] = ["today", "tomorrow", "weekend", "week", "term"]

/**
 * The presets that make sense today, in chip order: all but "Rest of term"
 * in the vacation, and none that covers the same days as another chip (at
 * the weekend "This week" and "Weekend" shrink onto "Today" or each other).
 * `selected` is always kept, so a shared `?preset=week` link still shows its
 * chip as on.
 */
export function availablePresets(
  today: string,
  termEnd?: string,
  selected?: DatePreset,
): DatePreset[] {
  const seen = new Set<string>()
  const kept = new Set<DatePreset>()
  for (const preset of DEDUPE_ORDER) {
    const range = presetRange(preset, today, termEnd)
    if (!range) continue
    const id = `${range.first}/${range.last}`
    if (seen.has(id) && preset !== selected) continue
    seen.add(id)
    kept.add(preset)
  }
  return DATE_PRESETS.filter((preset) => kept.has(preset))
}
