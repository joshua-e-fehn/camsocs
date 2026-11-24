import { v } from "convex/values"
import { venueDisplayName } from "../../lib/venue-name"
import type { ItemLocationKind, ItemLocationPrecision } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { DAY_MS } from "./derived"
import { loadSuppressedEvents } from "./suppressions"

/**
 * Item locations (docs/locations-and-map.md §1b): the shared pieces of
 * `locations.forItem`, `map.day`, the pipeline routes (convex/ingest/
 * locations.ts) and the broker's coverage card.
 */

/** Text limits of an `itemLocations` row, in characters. */
export const LOCATION_LIMITS = {
  room: 120,
  areaLabel: 120,
  note: 200,
  model: 100,
  promptVersion: 40,
  inputHash: 128,
  itemKey: 200,
} as const

/** The key prefix of each kind's items (lib/keys.ts, pipeline talks/model.py). */
export const ITEM_KEY_PREFIXES: Record<ItemLocationKind, string> = {
  event: "evt-",
  talk: "talk-",
}

const VENUE_KEY = /^ven-[a-z0-9-]+$/

export function isVenueKey(value: string): boolean {
  return VENUE_KEY.test(value)
}

/** Whether a precision needs a venue (`exact`, `building`, `area`). */
export function precisionNeedsVenue(precision: ItemLocationPrecision): boolean {
  return precision !== "online" && precision !== "unknown"
}

/** How far ahead coverage looks (the monitor and the dashboard card). */
export const COVERAGE_WINDOW_DAYS = 14
/** The share of upcoming items that may stay unresolved (owner decision 1). */
export const UNRESOLVED_TARGET = 0.02
/** Rows read per table for coverage: far above 14 days of items. */
const COVERAGE_READ = 3_000
/** Unknown items the dashboard lists at most. */
export const COVERAGE_UNKNOWN_LIST = 20

/** The location row of one item, or null. */
export async function itemLocationOf(
  ctx: QueryCtx,
  kind: ItemLocationKind,
  itemKey: string,
): Promise<Doc<"itemLocations"> | null> {
  return await ctx.db
    .query("itemLocations")
    .withIndex("by_kind_item", (q) => q.eq("kind", kind).eq("itemKey", itemKey))
    .unique()
}

/** A memoised venue lookup by key for one query (items share venues). */
export function venueCache(ctx: QueryCtx) {
  const cache = new Map<string, Promise<Doc<"venues"> | null>>()
  return (key: string): Promise<Doc<"venues"> | null> => {
    let hit = cache.get(key)
    if (!hit) {
      hit = ctx.db
        .query("venues")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique()
      cache.set(key, hit)
    }
    return hit
  }
}

/**
 * What to print for an item's place: "Seminar Room 1, Isaac Newton
 * Institute" (room, venue name); for an `area` row its area label; else the
 * source's own venue text; else "". Online items without any text read
 * "Online". The venue's name is printed without its "(University of
 * Cambridge)"-style suffix (lib/venue-name.ts).
 */
export function placeLabel(
  row: Pick<Doc<"itemLocations">, "precision" | "room" | "areaLabel"> | null,
  venueName: string | undefined,
  rawText: string | null | undefined,
): string {
  const raw = rawText?.trim() ?? ""
  if (!row || row.precision === "unknown") return raw
  if (row.precision === "online") return raw || "Online"
  if (row.precision === "area" && row.areaLabel) return row.areaLabel
  const name = venueName ? venueDisplayName(venueName) : undefined
  if (name) return row.room ? `${row.room}, ${name}` : name
  return row.areaLabel ?? raw
}

export const precisionCountsValidator = v.object({
  exact: v.number(),
  building: v.number(),
  area: v.number(),
  online: v.number(),
  unknown: v.number(),
  /** Upcoming items with no row yet (the pipeline has not reached them). */
  missing: v.number(),
})
export type PrecisionCounts = typeof precisionCountsValidator.type

export const locationSummaryValidator = v.object({
  from: v.number(),
  to: v.number(),
  /** Events (not members-only, not cancelled, not superseded) and listed talks. */
  upcoming: v.number(),
  /** Upcoming items whose row is not `unknown`. */
  resolved: v.number(),
  /** Upcoming items with an `unknown` row or none at all. */
  unknown: v.number(),
  byPrecision: precisionCountsValidator,
  /** `unknown / upcoming`, 0 when nothing is upcoming. */
  unresolvedShare: v.number(),
  /** Whether a read reached its cap (the counts are then a lower bound). */
  truncated: v.boolean(),
})
export type LocationSummary = typeof locationSummaryValidator.type

export type UnknownItem = {
  kind: ItemLocationKind
  key: string
  title: string
  note?: string
}

/**
 * Location coverage of the items starting in the next 14 days: every event
 * the pipeline resolves (all tiers but `members_only`, not cancelled, not
 * superseded or suppressed) and every listed, not cancelled talk, joined to
 * their rows by key. Bounded reads only (≤ 3,000 rows per table).
 */
export async function locationCoverage(
  ctx: QueryCtx,
  now: number,
): Promise<{ summary: LocationSummary; unknownItems: UnknownItem[] }> {
  const from = now
  const to = now + COVERAGE_WINDOW_DAYS * DAY_MS
  const [publicEvents, camEvents, talks, rows, suppressed] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_visibility_startsAt", (q) =>
        q.eq("visibility", "public").gte("startsAt", from).lt("startsAt", to),
      )
      .take(COVERAGE_READ),
    ctx.db
      .query("events")
      .withIndex("by_visibility_startsAt", (q) =>
        q.eq("visibility", "cam_only").gte("startsAt", from).lt("startsAt", to),
      )
      .take(COVERAGE_READ),
    ctx.db
      .query("talks")
      .withIndex("by_listing_startsAt", (q) =>
        q.eq("listing", "listed").gte("startsAt", from).lt("startsAt", to),
      )
      .take(COVERAGE_READ),
    ctx.db
      .query("itemLocations")
      .withIndex("by_startsAt", (q) => q.gte("startsAt", from).lt("startsAt", to))
      .take(COVERAGE_READ * 2),
    loadSuppressedEvents(ctx),
  ])
  const truncated =
    publicEvents.length === COVERAGE_READ ||
    camEvents.length === COVERAGE_READ ||
    talks.length === COVERAGE_READ ||
    rows.length === COVERAGE_READ * 2
  const byItem = new Map(rows.map((row) => [`${row.kind}:${row.itemKey}`, row]))

  const items: { kind: ItemLocationKind; key: string; title: string; startsAt: number }[] = []
  for (const event of [...publicEvents, ...camEvents]) {
    if (event.cancelled || event.supersededBy !== undefined || suppressed.has(event.key)) continue
    items.push({ kind: "event", key: event.key, title: event.title, startsAt: event.startsAt })
  }
  for (const talk of talks) {
    if (talk.cancelled) continue
    items.push({ kind: "talk", key: talk.key, title: talk.title, startsAt: talk.startsAt })
  }
  items.sort((a, b) => a.startsAt - b.startsAt)

  const byPrecision: PrecisionCounts = {
    exact: 0,
    building: 0,
    area: 0,
    online: 0,
    unknown: 0,
    missing: 0,
  }
  const unknownItems: UnknownItem[] = []
  for (const item of items) {
    const row = byItem.get(`${item.kind}:${item.key}`)
    if (row) byPrecision[row.precision] += 1
    else byPrecision.missing += 1
    if ((!row || row.precision === "unknown") && unknownItems.length < COVERAGE_UNKNOWN_LIST) {
      unknownItems.push({
        kind: item.kind,
        key: item.key,
        title: item.title,
        ...(row?.note ? { note: row.note } : row ? {} : { note: "Not resolved yet" }),
      })
    }
  }
  const upcoming = items.length
  const unknown = byPrecision.unknown + byPrecision.missing
  return {
    summary: {
      from,
      to,
      upcoming,
      resolved: upcoming - unknown,
      unknown,
      byPrecision,
      unresolvedShare: upcoming === 0 ? 0 : Math.round((unknown / upcoming) * 10_000) / 10_000,
      truncated,
    },
    unknownItems,
  }
}
