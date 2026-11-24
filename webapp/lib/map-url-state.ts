import { isIsoDate } from "./calendar"
import { firstParam, type SearchParams } from "./url-state"

/**
 * The map's URL (`/map`, docs/locations-and-map.md §0.4, §4): one London day,
 * `?d=YYYY-MM-DD` (absent: today), and which kinds of item it shows, `?show=`
 * `events` or `talks` (absent: both). Parsed and written alike on the server
 * (the page and its metadata) and in the browser (the page organism writes it
 * with `history.replaceState` / `pushState`, as events-calendar.tsx does).
 *
 * Only the bare `/map` is indexable: every parameter view is noindex, follow,
 * canonical to `/map`, and robots.txt disallows `/map?` (lib/crawl-traps.ts).
 */

export const MAP_PATH = "/map"

/** Which kinds of item the map shows. */
export const MAP_SHOWS = ["all", "events", "talks"] as const
export type MapShow = (typeof MAP_SHOWS)[number]

export type MapState = {
  /** A London date, or undefined for today. */
  date?: string
  show: MapShow
}

/** How far from today a `?d=` may reach: a year either way. Further is
 * nothing to show and only a crawler would ask for it. */
export const MAP_MAX_DAYS = 366

/** The URL's state; a malformed `?d=` or `?show=` is ignored. */
export function parseMapParams(params: SearchParams): MapState {
  const d = firstParam(params, "d")
  const show = firstParam(params, "show")
  return {
    date: d && isIsoDate(d) ? d : undefined,
    show: show === "events" || show === "talks" ? show : "all",
  }
}

/** Whole days from `from` to `to` (ISO dates). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** The day the map shows: the URL's, when it is within `MAP_MAX_DAYS` of
 * today, else today. */
export function mapDate(state: MapState, today: string): string {
  if (!state.date) return today
  return Math.abs(daysBetween(today, state.date)) <= MAP_MAX_DAYS ? state.date : today
}

/** The map's URL for a state: today's date and "all" are left out, so the
 * plain map is `/map`. */
export function mapHref(state: MapState, today: string): string {
  const params = new URLSearchParams()
  if (state.date && state.date !== today) params.set("d", state.date)
  if (state.show !== "all") params.set("show", state.show)
  const query = params.toString()
  return query ? `${MAP_PATH}?${query}` : MAP_PATH
}

/** Whether a request's view is the indexable `/map`: no parameters at all
 * (the page reads its raw search params, so `/map?d=` counts as one). */
export function mapIndexing(params: SearchParams): { canonical: string; index: boolean } {
  const index = Object.values(params).every((value) => value === undefined)
  return { canonical: MAP_PATH, index }
}

/** The map of one day, for a link from an item's page ("See on the map"). */
export function mapDayHref(date: string): string {
  return `${MAP_PATH}?d=${date}`
}
