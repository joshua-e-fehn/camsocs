import { v } from "convex/values"
import { query } from "./_generated/server"
import { venuePublic, venuePublicValidator } from "./lib/projections"

/** Every venue, by name — for event and session locations (public). */
export const list = query({
  args: {},
  returns: v.array(venuePublicValidator),
  handler: async (ctx) => {
    const venues = await ctx.db.query("venues").take(2_000)
    return venues.map(venuePublic).sort((a, b) => a.name.localeCompare(b.name))
  },
})

/**
 * One venue by key, or null — for an event's page, which needs one venue's
 * name, address and coordinates (its JSON-LD `Place`), not the whole list
 * (SEO audit "event-location-thin").
 */
export const get = query({
  args: { key: v.string() },
  returns: v.union(v.null(), venuePublicValidator),
  handler: async (ctx, args) => {
    const venue = await ctx.db
      .query("venues")
      .withIndex("by_key", (i) => i.eq("key", args.key))
      .unique()
    return venue ? venuePublic(venue) : null
  },
})
