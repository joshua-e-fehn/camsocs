import { DAY_MS, eventDays, formatDayShort, londonIsoDate } from "./calendar"

/**
 * Two ways a list of events gets repetitive, and how the pages fold them:
 *
 *  - **Runs.** A show plays night after night: Camdram lists each night as its
 *    own event, all with the show's page as `sourceUrl` (data-model §2
 *    "Series"). A profile lists the run once — "Top Girls, Tue 27 Oct – Sat
 *    31 Oct, 6 performances" — instead of six cards.
 *  - **Ongoing.** A multi-day event that began before the dates on screen (a
 *    film listed May–December is one all-day event) would sit on every day
 *    of a week or month. Calendars show it once, in a folded "N ongoing" strip
 *    above the days, soonest to end first.
 *  - **Long runs.** An event longer than `LONG_RUN_DAYS` (an exhibition, a
 *    month-long online competition) is never spread over each day it covers:
 *    it sits on its first day only, and once it has begun, in the strip.
 */

type Listed = {
  key: string
  title: string
  startsAt: number
  endsAt?: number
  sourceUrl?: string
  eventType?: string
}

export type EventRun<T extends Listed> = {
  /** The first event's key. */
  key: string
  /** In start order; at least one. */
  events: T[]
}

/** Events grouped into runs: the same title from the same page. Order is
 * kept (each run sits where its first event was). */
export function groupRuns<T extends Listed>(events: readonly T[]): EventRun<T>[] {
  const runs = new Map<string, EventRun<T>>()
  for (const event of events) {
    const id = event.sourceUrl
      ? `${event.title.trim().toLowerCase()}\u0000${event.sourceUrl}`
      : event.key
    const run = runs.get(id)
    if (run) run.events.push(event)
    else runs.set(id, { key: event.key, events: [event] })
  }
  return [...runs.values()]
}

/** "Tue 27 Oct – Sat 31 Oct · 6 performances" style label for a run of more
 * than one event: its first and last day and how many there are
 * ("performances" for shows, else "dates"). */
export function runSummary(run: EventRun<Listed>): string {
  const noun = run.events[0].eventType === "performance" ? "performances" : "dates"
  const first = londonIsoDate(run.events[0].startsAt)
  const last = londonIsoDate(run.events[run.events.length - 1].startsAt)
  const days =
    first === last ? formatDayShort(first) : `${formatDayShort(first)} – ${formatDayShort(last)}`
  return `${days} · ${run.events.length} ${noun}`
}

/** Whether an event began before `from` and is still on: shown once as
 * ongoing rather than on each day. */
export function isOngoing(event: { startsAt: number }, from: number): boolean {
  return event.startsAt < from
}

/** Longer than this (in days), an event is a long run: never on each day it covers. */
export const LONG_RUN_DAYS = 14

/** Whether an event lasts longer than `LONG_RUN_DAYS`. */
export function isLongRun(event: { startsAt: number; endsAt?: number }): boolean {
  return event.endsAt !== undefined && event.endsAt - event.startsAt > LONG_RUN_DAYS * DAY_MS
}

/** The London date an event ends on (an end at midnight belongs to the day
 * before); its start date when it has no end. */
export function lastDayOf(event: { startsAt: number; endsAt?: number }): string {
  return event.endsAt !== undefined && event.endsAt > event.startsAt
    ? londonIsoDate(event.endsAt - 1)
    : londonIsoDate(event.startsAt)
}

/** Splits a window's events into those already running at its start —
 * soonest to end first, then by title — and the rest, in their order. */
export function splitOngoing<T extends { startsAt: number; endsAt?: number; title: string }>(
  events: readonly T[],
  from: number,
): { ongoing: T[]; starting: T[] } {
  const ongoing: T[] = []
  const starting: T[] = []
  for (const event of events) (isOngoing(event, from) ? ongoing : starting).push(event)
  ongoing.sort(
    (a, b) =>
      (a.endsAt ?? a.startsAt) - (b.endsAt ?? b.startsAt) ||
      a.title.localeCompare(b.title, "en-GB"),
  )
  return { ongoing, starting }
}

/**
 * Events by the London day they are listed under, days in order: each on its
 * first day in view, and — with `spread` (the week and month grids) — on every
 * other day it covers too, unless it is a long run. Pass the events that start
 * in view (`splitOngoing(…).starting`).
 */
export function eventsByDay<T extends { startsAt: number; endsAt?: number }>(
  events: readonly T[],
  viewDays: readonly string[],
  spread: boolean,
): Map<string, T[]> {
  const first = viewDays[0]
  const last = viewDays[viewDays.length - 1]
  const days = new Map<string, T[]>()
  for (const event of events) {
    const covered = eventDays(event).filter((day) => day >= first && day <= last)
    if (covered.length === 0) covered.push(londonIsoDate(event.startsAt))
    for (const day of spread && !isLongRun(event) ? covered : covered.slice(0, 1)) {
      days.set(day, [...(days.get(day) ?? []), event])
    }
  }
  return new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
