// Hooks for the map (/map) and the "Where" row of item pages
// (docs/locations-and-map.md §1d, §3, §4). Thin wrappers over convex/react,
// like ./index.ts.
import { type Preloaded, useQuery } from "convex/react"
import type { FunctionArgs } from "convex/server"
import { useEffect, useMemo, useState } from "react"
import { api } from "@/convex/_generated/api"
import type { MapDay } from "@/lib/public-api"
import { useStickyQuery } from "./use-sticky-query"

export type MapDayArgs = FunctionArgs<typeof api.map.day>

/**
 * One day of the map (`map.day`), live. The server preloads `{date, talks:
 * "exclude", talksCam: "exclude"}` (G1: no talk text in the HTML); after a
 * day change the previous day stays on screen, `stale`, until the new one
 * arrives.
 */
export function useMapDay(args: MapDayArgs | "skip", preloaded?: Preloaded<typeof api.map.day>) {
  return useStickyQuery(api.map.day, args, preloaded)
}

/**
 * The union of several `map.day` answers for one date (the preload and the
 * talks side): items by kind and key, venues by key, sorted by start, counts
 * recomputed. Undefined answers are skipped; undefined when none is given.
 */
export function mergeMapDays(...days: (MapDay | undefined)[]): MapDay | undefined {
  const present = days.filter((day): day is MapDay => day !== undefined)
  if (present.length === 0) return undefined
  const items = new Map<string, MapDay["items"][number]>()
  const venues = new Map<string, MapDay["venues"][number]>()
  for (const day of present) {
    for (const item of day.items) items.set(`${item.kind}:${item.key}`, item)
    for (const venue of day.venues) venues.set(venue.key, venue)
  }
  const merged = [...items.values()].sort(
    (a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title),
  )
  return {
    date: present[0].date,
    from: present[0].from,
    to: present[0].to,
    venues: [...venues.values()].sort((a, b) => a.name.localeCompare(b.name)),
    items: merged,
    counts: {
      events: merged.filter((item) => item.kind === "event").length,
      talks: merged.filter((item) => item.kind === "talk").length,
      online: merged.filter((item) => item.precision === "online").length,
      unknown: merged.filter((item) => item.precision === "unknown").length,
    },
  }
}

/**
 * The talks side of a map day (owner decision G1, lib/talks-boundary.ts):
 * the talks and talks.cam-derived events (`talks: "include"`, `talksCam:
 * "only"`) and, with `talks: true`, every other talk too — read only in the
 * browser once hydrated, never in the server render, as `useTalksSideEvents`
 * does on /events. Undefined until then (and while loading).
 *
 * `map.day` returns one side of the boundary per call, so this reads two:
 * `{talksCam: "only"}` (talks.cam talks and talks.cam-derived events) and
 * `{talks: "include", talksCam: "exclude"}` (the other talks, which the
 * preload left out; its events repeat the preload's), merged. Merge the
 * result with the preload (`mergeMapDays(day, side)`).
 */
export function useMapDayTalksSide(date: string | "skip") {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  const ready = hydrated && date !== "skip"
  const talksCam = useQuery(
    api.map.day,
    ready ? { date, talks: "include" as const, talksCam: "only" as const } : "skip",
  )
  const otherTalks = useQuery(
    api.map.day,
    ready ? { date, talks: "include" as const, talksCam: "exclude" as const } : "skip",
  )
  return useMemo(
    () => (talksCam && otherTalks ? mergeMapDays(otherTalks, talksCam) : undefined),
    [talksCam, otherTalks],
  )
}

/** How many events and talks each day of the strip has (`map.weekCounts`). */
export function useMapWeekCounts(
  args: FunctionArgs<typeof api.map.weekCounts> | "skip",
  preloaded?: Preloaded<typeof api.map.weekCounts>,
) {
  return useStickyQuery(api.map.weekCounts, args, preloaded).data
}

/**
 * One item's resolved place (`locations.forItem`): undefined while loading,
 * null when it has none (or the viewer may not see the item). Call the talk
 * variant only from `/talks/...` pages (G1).
 */
export function useItemLocation(kind: "event" | "talk", itemKey: string | undefined) {
  return useQuery(api.locations.forItem, itemKey ? { kind, itemKey } : "skip")
}
