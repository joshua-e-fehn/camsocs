import { addDays, londonIsoDate, londonMidnight } from "./calendar"
import { MAP_PIN_BOUNDS } from "./map-style"
import type { MapDay, MapItem } from "./public-api"
import { EVENT_TYPE_LABELS, TALK_KIND_LABELS } from "./vocab"

/**
 * The map's day, worked out without the map (docs/locations-and-map.md §0.5,
 * §0.6): which items are over or on now, which share a pin, and which go in
 * the "Away from Cambridge", "Online" and "Location TBC" sections. Pure, so
 * the page organism, the canvas and the tests share it.
 */

const HOUR_MS = 60 * 60 * 1000

export type MapVenue = MapDay["venues"][number]
export type MapShowKinds = "all" | "events" | "talks"

/** Over, on now, or still to come. */
export type MapStatus = "past" | "now" | "upcoming"

/** An item's end: `endsAt`, else the end of its day for an all-day item, else
 * `startsAt` + 1 h (owner decision 5). */
export function itemEnd(item: Pick<MapItem, "startsAt" | "endsAt" | "allDay">): number {
  if (item.endsAt !== null && item.endsAt > item.startsAt) return item.endsAt
  if (item.allDay) return londonMidnight(addDays(londonIsoDate(item.startsAt), 1))
  return item.startsAt + HOUR_MS
}

/**
 * An item's state on the map of the day `[from, to)` at `now`: every item on a
 * past day is over and none on a future day is (a multi-day event that runs
 * on is still grey on the days behind it); on today, by its own times.
 */
export function itemStatus(
  item: Pick<MapItem, "startsAt" | "endsAt" | "allDay">,
  now: number,
  day: { from: number; to: number },
): MapStatus {
  if (now >= day.to) return "past"
  if (now < day.from) return "upcoming"
  if (now >= itemEnd(item)) return "past"
  if (now >= item.startsAt) return "now"
  return "upcoming"
}

/** The words for a status, so it is never colour alone. */
export const STATUS_LABELS: Record<MapStatus, string | undefined> = {
  past: "Ended",
  now: "Now",
  upcoming: undefined,
}

/** Whether a venue is placed inside the region pins are drawn in
 * (`MAP_PIN_BOUNDS`). A venue without coordinates is not. */
export function pinnable(venue: Pick<MapVenue, "lat" | "lng"> | undefined): boolean {
  if (!venue || venue.lat === undefined || venue.lng === undefined) return false
  const [west, south, east, north] = MAP_PIN_BOUNDS
  return venue.lat >= south && venue.lat <= north && venue.lng >= west && venue.lng <= east
}

/** Whether a venue is placed, but beyond the pin region (an away fixture). */
export function farAway(venue: Pick<MapVenue, "lat" | "lng"> | undefined): boolean {
  return venue?.lat !== undefined && venue.lng !== undefined && !pinnable(venue)
}

/** The items a toggle leaves on the map. */
export function shownItems(items: readonly MapItem[], show: MapShowKinds): MapItem[] {
  if (show === "all") return [...items]
  const kind = show === "events" ? "event" : "talk"
  return items.filter((item) => item.kind === kind)
}

/** One pin: every shown item at one venue (owner decision 6). */
export type MapPin = {
  venueKey: string
  venue: MapVenue
  lat: number
  lng: number
  items: MapItem[]
  /** Talks only: a square ink pin; else a round teal one. */
  kind: "event" | "talk"
  /** Now if any item is on now; past once all are over; else upcoming. */
  status: MapStatus
  /** "Isaac Newton Institute: 2 events, 1 talk, one on now"; for one item,
   * its type too: "ADC Theatre: 1 event (Performance), on now". */
  label: string
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "2 events, 1 talk". */
export function countPhrase(items: readonly Pick<MapItem, "kind">[]): string {
  const events = items.filter((item) => item.kind === "event").length
  const talks = items.length - events
  return [
    events > 0 ? plural(events, "event", "events") : undefined,
    talks > 0 ? plural(talks, "talk", "talks") : undefined,
  ]
    .filter(Boolean)
    .join(", ")
}

/** An item's type in words: "Performance", "Seminar"; "Event" or "Talk"
 * when the source gave none. The map's rows show it beside the type icon. */
export function itemTypeLabel(item: Pick<MapItem, "kind" | "eventType" | "talkKind">): string {
  if (item.kind === "talk") return item.talkKind ? TALK_KIND_LABELS[item.talkKind] : "Talk"
  return item.eventType ? EVENT_TYPE_LABELS[item.eventType] : "Event"
}

/** A pin's count in words. A pin of one item shows that item's type icon,
 * so its name says the type too ("1 event (Performance)"): the icon is never
 * the only carrier of the type (DESIGN.md "Iconography"). */
function pinCount(pinned: readonly MapItem[]): string {
  const count = countPhrase(pinned)
  if (pinned.length !== 1) return count
  const only = pinned[0]
  const typed = only.kind === "talk" ? only.talkKind : only.eventType
  return typed ? `${count} (${itemTypeLabel(only)})` : count
}

/** The day's pins, one per venue with coordinates inside the pin region, in
 * the order of each venue's first item. Items whose `venueKey` is not among
 * `venues`, or whose venue is far from Cambridge, get none. */
export function mapPins(
  items: readonly MapItem[],
  venues: readonly MapVenue[],
  now: number,
  day: { from: number; to: number },
): MapPin[] {
  const byKey = new Map(venues.map((venue) => [venue.key, venue]))
  const grouped = new Map<string, MapItem[]>()
  for (const item of items) {
    if (!item.venueKey || item.precision === "online" || item.precision === "film") continue
    const venue = byKey.get(item.venueKey)
    if (!pinnable(venue)) continue
    const list = grouped.get(item.venueKey) ?? []
    list.push(item)
    grouped.set(item.venueKey, list)
  }
  return [...grouped.entries()].map(([venueKey, pinned]) => {
    const venue = byKey.get(venueKey) as MapVenue
    const statuses = pinned.map((item) => itemStatus(item, now, day))
    const status: MapStatus = statuses.includes("now")
      ? "now"
      : statuses.every((value) => value === "past")
        ? "past"
        : "upcoming"
    const onNow = statuses.filter((value) => value === "now").length
    const state =
      status === "now"
        ? `, ${onNow === 1 ? "one" : onNow} on now`
        : status === "past"
          ? ", ended"
          : ""
    return {
      venueKey,
      venue,
      lat: venue.lat as number,
      lng: venue.lng as number,
      items: pinned,
      kind: pinned.every((item) => item.kind === "talk") ? "talk" : "event",
      status,
      label: `${venue.name}: ${pinCount(pinned)}${state}`,
    }
  })
}

/** Where a film with no screening venue is (a short film, a shoot: precision
 * `film`), on the map's rows and an item's "Where" row. */
export const FILM_PLACE = "Film — no screening venue listed"

/** The list's sections: what has a place in or near Cambridge (pinned or
 * not), what is far from it ("Away from Cambridge": a placed venue beyond the
 * pin region, listed with its place and directions, no pin), what is online,
 * films with no screening venue (a short film, a shoot: no pin), and what
 * has no place yet ("Location TBC"). Each keeps start order. */
export function mapSections(
  items: readonly MapItem[],
  venues: readonly MapVenue[] = [],
): {
  placed: MapItem[]
  away: MapItem[]
  online: MapItem[]
  films: MapItem[]
  tbc: MapItem[]
} {
  const byKey = new Map(venues.map((venue) => [venue.key, venue]))
  const placed: MapItem[] = []
  const away: MapItem[] = []
  const online: MapItem[] = []
  const films: MapItem[] = []
  const tbc: MapItem[] = []
  for (const item of items) {
    if (item.precision === "online") online.push(item)
    else if (item.precision === "film" && !item.venueKey) films.push(item)
    else if (item.precision === "unknown" && !item.venueKey) tbc.push(item)
    else if (item.venueKey && farAway(byKey.get(item.venueKey))) away.push(item)
    else placed.push(item)
  }
  return { placed, away, online, films, tbc }
}

/** An item's identity across kinds (events and talks may share nothing else). */
export function itemId(item: Pick<MapItem, "kind" | "key">): string {
  return `${item.kind}:${item.key}`
}
