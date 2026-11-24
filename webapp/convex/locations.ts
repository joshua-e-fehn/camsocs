import { v } from "convex/values"
import { venueDisplayName } from "../lib/venue-name"
import { ITEM_LOCATION_KINDS, ITEM_LOCATION_PRECISIONS } from "../lib/vocab"
import { query } from "./_generated/server"
import { shownEvent } from "./lib/eventWindow"
import { itemLocationOf, precisionNeedsVenue, venueCache } from "./lib/locations"
import { orgRefCache, venuePublic, venuePublicValidator } from "./lib/projections"
import { loadContactHashes, loadNameHashes, scrubAddresses } from "./lib/suppressions"
import { literalUnion } from "./lib/validators"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * One item's resolved place (docs/locations-and-map.md §1d, §3): the "Where"
 * row of an event's or a talk's page. Null when the item has no location row
 * yet, or when the viewer may not see the item (the event gate of
 * `events.get`; a talk must be listed). The talk variant is called only from
 * `/talks/...` pages (G1). `venue` is null for `online`, `unknown` and `film` rows,
 * and for a venue that no longer exists. The venue's name is its display
 * name (lib/venue-name.ts: no "(University of Cambridge)" suffix); its key
 * is unchanged.
 */
export const forItem = query({
  args: { kind: literalUnion(ITEM_LOCATION_KINDS), itemKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      precision: literalUnion(ITEM_LOCATION_PRECISIONS),
      room: v.optional(v.string()),
      areaLabel: v.optional(v.string()),
      venue: v.union(v.null(), venuePublicValidator),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.kind === "event") {
      const tiers = visibleEventTiers(await getViewer(ctx))
      if (!(await shownEvent(ctx, args.itemKey, tiers, orgRefCache(ctx)))) return null
    } else {
      const talk = await ctx.db
        .query("talks")
        .withIndex("by_key", (q) => q.eq("key", args.itemKey))
        .unique()
      if (!talk || talk.listing !== "listed") return null
    }
    const row = await itemLocationOf(ctx, args.kind, args.itemKey)
    if (!row) return null
    const placed = precisionNeedsVenue(row.precision)
    const venue = placed && row.venueKey ? await venueCache(ctx)(row.venueKey) : null
    const shown = scrubAddresses(
      { room: placed ? row.room : undefined, areaLabel: placed ? row.areaLabel : undefined },
      await loadContactHashes(ctx),
      await loadNameHashes(ctx),
    )
    return {
      precision: row.precision,
      ...(shown.room ? { room: shown.room } : {}),
      ...(shown.areaLabel ? { areaLabel: shown.areaLabel } : {}),
      venue: venue ? { ...venuePublic(venue), name: venueDisplayName(venue.name) } : null,
    }
  },
})
