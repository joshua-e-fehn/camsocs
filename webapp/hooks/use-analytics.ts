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
 * Search events for one search box (ENG-5): once a query has settled —
 * `resultCount` is defined only when the results for `query` are in, not
 * while loading or stale — sends `search_performed` with the query's length
 * and the result count, and `search_zero_results` when there are none. Once
 * per query: a live update of the same query's results sends nothing more;
 * clearing the box and searching again does.
 *
 * ⚠ The query's text never leaves this hook: only its length is sent.
 */
export function useTrackSearch(
  surface: SearchSurface,
  query: string | undefined,
  resultCount: number | undefined,
) {
  const text = query?.trim() ?? ""
  const sentFor = useRef<string | null>(null)
  useEffect(() => {
    if (!text) {
      sentFor.current = null
      return
    }
    if (resultCount === undefined || sentFor.current === text) return
    sentFor.current = text
    const queryLength = Array.from(text).length
    track("search_performed", { surface, queryLength, resultCount })
    if (resultCount === 0) track("search_zero_results", { surface, queryLength })
  }, [surface, text, resultCount])
}
