import { v } from "convex/values"
import { query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"

/**
 * The private brokering area's entry point.
 *
 * ⚠ Rule for this directory: **every** function under `convex/broker/` calls
 * `requireBrokerUser` before touching data. Brokering data (people,
 * interactions, introductions) never appears in a public query, a static asset
 * or a bundle.
 */

/** The signed-in broker, or a thrown "Not authorized" for anyone else. */
export const me = query({
  args: {},
  returns: v.object({ email: v.string(), name: v.string() }),
  handler: async (ctx) => {
    const broker = await requireBrokerUser(ctx)
    return { email: broker.email, name: broker.name }
  },
})
