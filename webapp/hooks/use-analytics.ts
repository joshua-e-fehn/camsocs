import { useEffect, useRef } from "react"
import { type AnalyticsEvent, type EventProps, track } from "@/lib/analytics"
import type { SearchSurface } from "@/lib/analytics-events"

/**
 * Sends a view event once for each distinct `props` while mounted (a sheet
 * switching from one event to the next sends again); null sends nothing (no
 * data yet, or nothing open) and ends the view, so closing a sheet and
 * opening the same item again counts again. A remount in React's StrictMode
 * keeps the ref, so development does not double-count.
 */
export function useTrackView<E extends AnalyticsEvent>(event: E, props: EventProps<E> | null) {
  const json = props === null ? null : JSON.stringify(props)
  const sent = useRef<string | null>(null)
  useEffect(() => {
    if (json === null) {
      sent.current = null
      return
    }
    if (sent.current === `${event}:${json}`) return
    sent.current = `${event}:${json}`
    track(event, JSON.parse(json) as EventProps<E>)
  }, [event, json])
}

/**
 * The query each surface last sent, for this page load. Module state, not a
 * ref: it outlives the search box, so a box that mounts again with `?q=`
 * already in the URL and its results in (Back from a result, a shared link)
 * does not count the same search again. App Router navigation keeps it.
 */
const lastSearch = new Map<SearchSurface, string>()

/** Forgets the queries sent (tests only). */
export function resetSearchTrackingForTests(): void {
  lastSearch.clear()
}

/**
 * Search events for one search box (ENG-5): once a query has settled —
 * `resultCount` is defined only when the results for `query` are in, not
 * while loading or stale — sends `search_performed` with the query's length
 * and the result count, and `search_zero_results` when there are none. Once
 * per query and surface: a live update of the same query's results, or the
 * box mounting again with the same query, sends nothing more; clearing the
 * box (an empty or undefined `query`) and searching again does.
 *
 * ⚠ The query's text never leaves this hook: only its length is sent.
 */
export function useTrackSearch(
  surface: SearchSurface,
  query: string | undefined,
  resultCount: number | undefined,
) {
  const text = query?.trim() ?? ""
  useEffect(() => {
    if (!text) {
      lastSearch.delete(surface)
      return
    }
    if (resultCount === undefined || lastSearch.get(surface) === text) return
    lastSearch.set(surface, text)
    const queryLength = Array.from(text).length
    track("search_performed", { surface, queryLength, resultCount })
    if (resultCount === 0) track("search_zero_results", { surface, queryLength })
  }, [surface, text, resultCount])
}
