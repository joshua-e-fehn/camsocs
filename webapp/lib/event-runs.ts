import { formatDayShort, londonIsoDate } from "./calendar"

/**
 * Two ways a list of events gets repetitive, and how the pages fold them:
 *
 *  - **Runs.** A show plays night after night: Camdram lists each night as its
 *    own event, all with the show's page as `sourceUrl` (data-model §2
 *    "Series"). A profile lists the run once — "Top Girls, Tue 27 Oct – Sat
 *    31 Oct, 6 performances" — instead of six cards.
 *  - **Ongoing.** A multi-day event that began before the dates on screen (a
 *    film listed May–December is one all-day event) would sit on every day
 *    of a week or month. Calendars show it once, above the days.
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

/** Splits a window's events into those already running at its start and the rest. */
export function splitOngoing<T extends { startsAt: number }>(
  events: readonly T[],
  from: number,
): { ongoing: T[]; starting: T[] } {
  const ongoing: T[] = []
  const starting: T[] = []
  for (const event of events) (isOngoing(event, from) ? ongoing : starting).push(event)
  return { ongoing, starting }
}
