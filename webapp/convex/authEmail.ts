import { v } from "convex/values"
import { sha256Hex } from "../lib/hash"
import { internalMutation } from "./_generated/server"

/**
 * Throttle for the `@cam.ac.uk` sign-in link (convex/betterAuth/auth.ts).
 *
 * Better Auth's own rate limiter keeps its counters in memory, which in Convex
 * is per isolate and so no limit at all. Without one, anyone could use the
 * form to mail a stranger's @cam.ac.uk inbox repeatedly or burn the Resend
 * quota. Each send is recorded as a sha256 of the normalised address — never
 * the address itself — and the rows are pruned after a day.
 */

export const LINKS_PER_ADDRESS = 3
export const ADDRESS_WINDOW_MS = 15 * 60 * 1000
export const LINKS_PER_HOUR = 60
const HOUR_MS = 60 * 60 * 1000
const KEEP_MS = 24 * HOUR_MS
const PRUNE_BATCH = 50

export const reserveSignInLink = internalMutation({
  args: { email: v.string() },
  returns: v.union(v.literal("ok"), v.literal("address_limit"), v.literal("global_limit")),
  handler: async (ctx, args) => {
    const now = Date.now()
    const emailHash = sha256Hex(args.email.trim().toLowerCase())

    const recentForAddress = await ctx.db
      .query("signInLinkSends")
      .withIndex("by_emailHash_sentAt", (q) =>
        q.eq("emailHash", emailHash).gt("sentAt", now - ADDRESS_WINDOW_MS),
      )
      .take(LINKS_PER_ADDRESS)
    if (recentForAddress.length >= LINKS_PER_ADDRESS) return "address_limit"

    const recentOverall = await ctx.db
      .query("signInLinkSends")
      .withIndex("by_sentAt", (q) => q.gt("sentAt", now - HOUR_MS))
      .take(LINKS_PER_HOUR)
    if (recentOverall.length >= LINKS_PER_HOUR) return "global_limit"

    await ctx.db.insert("signInLinkSends", { emailHash, sentAt: now })
    const expired = await ctx.db
      .query("signInLinkSends")
      .withIndex("by_sentAt", (q) => q.lt("sentAt", now - KEEP_MS))
      .take(PRUNE_BATCH)
    for (const row of expired) await ctx.db.delete("signInLinkSends", row._id)
    return "ok"
  },
})
