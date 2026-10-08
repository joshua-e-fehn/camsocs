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
 *
 * Three limits, in order:
 *  1. per address (`LINKS_PER_ADDRESS` per 15 minutes);
 *  2. per client (`LINKS_PER_CLIENT` an hour), keyed by a sha256 of the
 *     caller's IP as the HTTP action saw it in `x-forwarded-for` — so one
 *     sender cycling through made-up `xx123@cam.ac.uk` addresses is stopped
 *     long before the overall cap;
 *  3. overall (`LINKS_PER_HOUR`), which an address that has signed in before
 *     (`knownUser`) never hits: a flood of strangers' addresses cannot lock
 *     out the Cambridge tier for people already using it.
 */

export const LINKS_PER_ADDRESS = 3
export const ADDRESS_WINDOW_MS = 15 * 60 * 1000
export const LINKS_PER_CLIENT = 10
export const LINKS_PER_HOUR = 60
const HOUR_MS = 60 * 60 * 1000
const KEEP_MS = 24 * HOUR_MS
const PRUNE_BATCH = 50

export const reserveSignInLink = internalMutation({
  args: {
    email: v.string(),
    /** The caller's IP (or another client identifier); stored only hashed. */
    client: v.optional(v.string()),
    /** The address already belongs to a verified account. */
    knownUser: v.optional(v.boolean()),
  },
  returns: v.union(
    v.literal("ok"),
    v.literal("address_limit"),
    v.literal("client_limit"),
    v.literal("global_limit"),
  ),
  handler: async (ctx, args) => {
    const now = Date.now()
    const emailHash = sha256Hex(args.email.trim().toLowerCase())
    const client = args.client?.trim().toLowerCase()
    const clientHash = client ? sha256Hex(`client:${client}`) : undefined

    const recentForAddress = await ctx.db
      .query("signInLinkSends")
      .withIndex("by_emailHash_sentAt", (q) =>
        q.eq("emailHash", emailHash).gt("sentAt", now - ADDRESS_WINDOW_MS),
      )
      .take(LINKS_PER_ADDRESS)
    if (recentForAddress.length >= LINKS_PER_ADDRESS) return "address_limit"

    if (clientHash) {
      const recentForClient = await ctx.db
        .query("signInLinkSends")
        .withIndex("by_clientHash_sentAt", (q) =>
          q.eq("clientHash", clientHash).gt("sentAt", now - HOUR_MS),
        )
        .take(LINKS_PER_CLIENT)
      if (recentForClient.length >= LINKS_PER_CLIENT) return "client_limit"
    }

    if (args.knownUser !== true) {
      const recentOverall = await ctx.db
        .query("signInLinkSends")
        .withIndex("by_sentAt", (q) => q.gt("sentAt", now - HOUR_MS))
        .take(LINKS_PER_HOUR)
      if (recentOverall.length >= LINKS_PER_HOUR) return "global_limit"
    }

    await ctx.db.insert("signInLinkSends", { emailHash, clientHash, sentAt: now })
    const expired = await ctx.db
      .query("signInLinkSends")
      .withIndex("by_sentAt", (q) => q.lt("sentAt", now - KEEP_MS))
      .take(PRUNE_BATCH)
    for (const row of expired) await ctx.db.delete("signInLinkSends", row._id)
    return "ok"
  },
})
