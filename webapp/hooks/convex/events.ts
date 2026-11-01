// Hooks for the events pillar (/events). Thin wrappers over convex/react,
// like ./index.ts; the argument builders live in lib/url-state.ts so the
// server preload asks for exactly the same.
import type { Preloaded } from "convex/react"
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
