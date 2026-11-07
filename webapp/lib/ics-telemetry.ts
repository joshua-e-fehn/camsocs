import { after } from "next/server"
import { captureServerEvent } from "@/lib/posthog-server"
import { isTalkKey } from "@/lib/talks-url-state"
import { isEventKey } from "@/lib/url-state"

/**
 * The calendar-feed count (ENG-7; spec "Server-side events without consent",
 * law report §7, record of processing P12): each `.ics` response a route
 * handler serves sends `ics_feed_fetched { feed, key? }` to PostHog through
 * `captureServerEvent` (fixed distinct id `camsocs-server`, no person
 * profile, allow-list `SERVER_EVENTS`).
 *
 *  - Only the feed kind and, for one event or talk, its key: never the
 *    `/talks.ics` filters (`q` is free text), a header, the user agent or the
 *    client address. A key that is not a valid event / talk key is dropped.
 *  - Inside Next's `after()`: the send starts once the response is finished,
 *    so the response, its status and its caching headers are exactly what
 *    they were without the count, and it adds no latency.
 *  - Never throws (a count must not break the download it counts), and a
 *    no-op without `NEXT_PUBLIC_POSTHOG_KEY` (`captureServerEvent`).
 *  - ⚠ A lower bound: the feeds are cached at the edge for an hour per URL
 *    (`s-maxage=3600`, then `stale-while-revalidate`), and a cache hit never
 *    reaches the function. Read the numbers as "at least", and trends only.
 */

export const ICS_FEED_FETCHED = "ics_feed_fetched"

export type IcsFeed = "talks" | "events" | "event" | "talk" | "personal"

/** The event's properties: the feed, plus the key when it is a valid key of
 * that feed's kind (the `talks` feed never has one). */
export function icsFeedProperties(feed: IcsFeed, key?: string): { feed: IcsFeed; key?: string } {
  const valid =
    key !== undefined &&
    ((feed === "event" && isEventKey(key)) || (feed === "talk" && isTalkKey(key)))
  return valid ? { feed, key } : { feed }
}

type Deps = {
  after: (task: () => Promise<void>) => void
  capture: typeof captureServerEvent
}

/**
 * Counts one served `.ics` response, after it is sent. Call it on the success
 * path, just before returning the response; `deps` is for tests.
 */
export function countIcsFetch(
  feed: IcsFeed,
  key?: string,
  deps: Deps = { after, capture: captureServerEvent },
): void {
  try {
    const props = icsFeedProperties(feed, key)
    deps.after(async () => {
      try {
        await deps.capture(ICS_FEED_FETCHED, props)
      } catch {
        // captureServerEvent never rejects; this guards a replacement.
      }
    })
  } catch {
    // `after()` outside a request scope throws; the response must not care.
  }
}
