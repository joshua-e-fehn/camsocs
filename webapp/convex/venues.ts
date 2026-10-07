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
