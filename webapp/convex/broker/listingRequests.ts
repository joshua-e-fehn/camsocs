import { v } from "convex/values"
import { LISTING_REQUEST_STATUSES } from "../../lib/vocab"
import { mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { brokerOrgRefs, orgRefValidator } from "../lib/brokerRows"
import { withoutSystemFields } from "../lib/ingest"
import { literalUnion } from "../lib/validators"
import { listingRequestFields } from "../schema"

/**
 * The inbox of claim / correct / remove / object / add requests from the
 * public form (`listingRequests.submit`). The broker reads them, links them
 * to the listing, and sets their status; a remove or object request is acted
 * on with `broker.orgs.setHidden` (and, for outreach, the profile's
 * `suppressed`). Turning an accepted correction into `owner_submitted` claims
 * is not done here.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX = 500

export const list = query({
  args: { status: v.optional(literalUnion(LISTING_REQUEST_STATUSES)) },
  returns: v.array(v.object({ ...listingRequestFields, org: v.union(v.null(), orgRefValidator) })),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const status = args.status
    const rows = status
      ? await ctx.db
          .query("listingRequests")
          .withIndex("by_status_createdAt", (q) => q.eq("status", status))
          .order("desc")
          .take(MAX)
      : await ctx.db.query("listingRequests").order("desc").take(MAX)
    const refs = brokerOrgRefs(ctx)
    const out = []
    for (const row of rows) {
      out.push({
        ...withoutSystemFields<"listingRequests">(row),
        org: row.orgKey ? await refs(row.orgKey) : null,
      })
    }
    return out
  },
})

export const setStatus = mutation({
  args: { key: v.string(), status: literalUnion(LISTING_REQUEST_STATUSES) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const row = await ctx.db
      .query("listingRequests")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()
    if (!row) throw new Error("That request was not found")
    await ctx.db.patch("listingRequests", row._id, {
      status: args.status,
      resolvedAt: args.status === "open" ? undefined : Date.now(),
    })
    return null
  },
})
