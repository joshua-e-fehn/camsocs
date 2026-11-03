// Hooks for the events pillar (/events). Thin wrappers over convex/react,
// like ./index.ts; the argument builders live in lib/url-state.ts so the
// server preload asks for exactly the same.
import { type Preloaded, useConvexAuth, useQuery } from "convex/react"
import { useEffect, useState } from "react"
import { api } from "@/convex/_generated/api"
import type { EventListArgs } from "@/lib/url-state"
import { useStickyQuery } from "./use-sticky-query"

/**
 * The events of the window on screen (`events.list`), live. The server's
 * preload fills the first paint; after a change (a filter, "Show next week")
 * the previous events stay on screen, `stale`, until the new ones arrive.
 */
export function useEventWindow(
  args: EventListArgs | "skip",
  preloaded?: Preloaded<typeof api.events.list>,
) {
  return useStickyQuery(api.events.list, args, preloaded)
}

/** How many Cambridge-only events the viewer may not see around these dates
 * (`events.restrictedCount`), or undefined while counting. */
export function useRestrictedCount(
  args: EventListArgs | "skip",
  preloaded?: Preloaded<typeof api.events.restrictedCount>,
) {
  return useStickyQuery(api.events.restrictedCount, args, preloaded).data?.camOnly
}

/**
 * The talks.cam-derived society events of the same window (owner decision
 * G1, lib/talks-boundary.ts), read only in the browser once hydrated: the
 * server render of /events never lists them, so none of their words reach
 * its HTML or RSC payload, while a reader still sees them in the calendar.
 * Undefined until then (and while loading).
 */
export function useTalksSideEvents(args: EventListArgs | "skip") {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return useQuery(
    api.events.list,
    hydrated && args !== "skip" ? { ...args, talksCam: "only" as const } : "skip",
  )
}

/**
 * What only a signed-in reader adds to a cached public page (docs/webapp.md
 * "Caching"): the server renders every public page anonymously, so a
 * verified @cam.ac.uk reader's Cambridge-only events arrive here, in the
 * browser, once the Convex client holds the session. Skipped for everyone
 * else, so a signed-out view costs no extra read. Undefined until then.
 */
function useSignedIn<Args>(args: Args | "skip"): Args | "skip" {
  const { isAuthenticated } = useConvexAuth()
  return isAuthenticated ? args : "skip"
}

/** `events.list` for a signed-in reader only (see `useSignedIn`). */
export function useSignedInEventWindow(args: EventListArgs | "skip") {
  return useQuery(api.events.list, useSignedIn(args))
}

/** `events.get` for a signed-in reader only (see `useSignedIn`): an event a
 * signed-out reader is told is not available. Null when this reader may not
 * see it either. */
export function useSignedInEvent(key: string) {
  return useQuery(api.events.get, useSignedIn({ key }))
}
