import { unstable_rethrow } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { londonIsoDate } from "./calendar"
import type { EventListItem } from "./public-api"
import { publicQuery } from "./public-data"

/**
 * Recurring event series pages (ENG-282): `/events/series` lists every
 * series, `/events/series/<slug>` is one series with this year's edition and
 * the earlier ones still held. The series come from Convex
 * (convex/lib/eventSeries.ts derives them, convex/eventSeries.ts reads them).
 */

export { SERIES_INDEX_PATH, seriesPath } from "./event-series-path"

export type SeriesRef = { slug: string; name: string }

/** The series an event page links to. Decoration: a failed read shows none. */
export async function loadSeriesOf(eventKey: string): Promise<SeriesRef | null> {
  try {
    return await publicQuery(api.eventSeries.ofEvent, { key: eventKey })
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/** One edition: the nights of one year's event, by date. */
export type SeriesEdition = { year: number; events: EventListItem[] }

/** The year an edition is named after: the year in its title ("Greek Play
 * 2026"), else the London year it starts in. */
export function editionYearOf(event: Pick<EventListItem, "title" | "startsAt">): number {
  const named = /\b(20\d{2})\b/.exec(event.title)
  return named ? Number(named[1]) : Number(londonIsoDate(event.startsAt).slice(0, 4))
}

/** A series' events as editions, newest year first, each by date. */
export function editionsOf(events: readonly EventListItem[]): SeriesEdition[] {
  const byYear = new Map<number, EventListItem[]>()
  for (const event of events) {
    const year = editionYearOf(event)
    byYear.set(year, [...(byYear.get(year) ?? []), event])
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, list]) => ({ year, events: [...list].sort((a, b) => a.startsAt - b.startsAt) }))
}

/** The edition a page leads with: the soonest one still to come (or on now),
 * else the latest held. Undefined for a series with no edition held. */
export function leadEdition(
  editions: readonly SeriesEdition[],
  now: number,
): { edition: SeriesEdition; upcoming: boolean } | undefined {
  const upcoming = [...editions]
    .reverse()
    .find((edition) => edition.events.some((event) => (event.endsAt ?? event.startsAt) >= now))
  if (upcoming) return { edition: upcoming, upcoming: true }
  return editions[0] ? { edition: editions[0], upcoming: false } : undefined
}

/** A series page's title: "The Cambridge Greek Play 2026: dates & every year". */
export function seriesTitle(name: string, year?: number): string {
  return year ? `${name} ${year}: dates & every year` : `${name}: dates & every year`
}

/** A series page's description. */
export function seriesDescription(name: string, org?: string, year?: number): string {
  const who = org ? `, run by ${org}` : ""
  const which = year ? `${name} ${year}` : name
  return `When and where ${which} is on in Cambridge${who}: this year's dates and booking, with earlier editions. One page every year.`
}
