import { formatDayShort, londonIsoDate, londonTime } from "./calendar"
import { groupRuns } from "./event-runs"

/**
 * "Next from <society>" on an event's page (event indexing, 2026-11-07,
 * Joshua's OK): the three events that host has coming after this one, as
 * links. Each upcoming event then links the next ones, so a society's whole
 * programme hangs off the event its profile lists first: the crawl of 7 Nov
 * found 311 of 612 upcoming events with no link from any indexed page (a
 * profile shows 8, its calendar four weeks). A University listing gets the
 * University's next ones the same way.
 *
 * Runs count once (a show's nights share one link, `groupRuns`), the run this
 * event belongs to is skipped, and cancelled events are left out.
 */

export const NEXT_EVENTS = 3

type Listed = {
  key: string
  title: string
  startsAt: number
  endsAt?: number
  allDay: boolean
  sourceUrl?: string
  eventType?: string
  cancelled: boolean
}

export type NextEvent = { key: string; title: string; when: string }

/** "Sat 14 Nov, 20:00", or the day alone for an all-day event. */
export function nextEventWhen(event: { startsAt: number; allDay: boolean }): string {
  const day = formatDayShort(londonIsoDate(event.startsAt))
  return event.allDay ? day : `${day}, ${londonTime(event.startsAt)}`
}

/**
 * The next `count` runs after `current` among `listed` (the host's events
 * from `current`'s day on, any order): those starting after it, or at the
 * same moment but listed later; for an event that has ended, those not yet
 * started at `now`.
 */
export function nextEvents(
  current: { key: string; startsAt: number },
  listed: readonly Listed[],
  now: number,
  count = NEXT_EVENTS,
): NextEvent[] {
  const sorted = [...listed]
    .filter((event) => !event.cancelled)
    .sort((a, b) => a.startsAt - b.startsAt || a.key.localeCompare(b.key))
  const runs = groupRuns(sorted)
  const own = runs.find((run) => run.events.some((event) => event.key === current.key))
  const after = (event: Listed) =>
    event.startsAt > current.startsAt ||
    (event.startsAt === current.startsAt && event.key.localeCompare(current.key) > 0)
  return runs
    .filter((run) => run !== own)
    .map((run) => run.events.find((event) => after(event) && event.startsAt >= now) ?? null)
    .filter((event): event is Listed => event !== null)
    .slice(0, count)
    .map((event) => ({ key: event.key, title: event.title, when: nextEventWhen(event) }))
}
