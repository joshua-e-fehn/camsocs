import { v } from "convex/values"
import { LISTING_REQUEST_KINDS, SUPPRESSION_SCOPES } from "../../lib/vocab"
import { mutation, query } from "../_generated/server"
import { requireBrokerUser } from "../lib/auth"
import { liftSuppression } from "../lib/suppressionEffects"
import { literalUnion } from "../lib/validators"

/**
 * The suppression list as the broker sees it (convex/lib/suppressions.ts):
 * what accepted removals and objections took off the site, per listing, and
 * the way to lift one made in error.
 *
 * ⚠ Every function here calls `requireBrokerUser` first.
 */

const MAX = 500

const suppressionRow = v.object({
  key: v.string(),
  scope: literalUnion(SUPPRESSION_SCOPES),
  orgKey: v.optional(v.string()),
  field: v.optional(v.string()),
  /** Scope contact: the address is stored only as a hash, so this says
   * only that there is one. */
  contact: v.boolean(),
  personKey: v.optional(v.string()),
  /** The person's name while the broker row exists (it is deleted on
   * suppression, so usually absent). */
  personName: v.optional(v.string()),
  /** Scope event: the event removed. */
  eventKey: v.optional(v.string()),
  /** Scope name: the name is stored only as a hash, so this says only that
   * there is one. */
  name: v.boolean(),
  requestKey: v.optional(v.string()),
  requestKind: v.optional(literalUnion(LISTING_REQUEST_KINDS)),
  createdAt: v.number(),
})

/** Suppressions of one listing, or the newest ones overall. */
export const list = query({
  args: { orgKey: v.optional(v.string()) },
  returns: v.array(suppressionRow),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    const orgKey = args.orgKey
    const rows = orgKey
      ? await ctx.db
          .query("suppressions")
          .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
          .take(MAX)
      : await ctx.db.query("suppressions").order("desc").take(MAX)
    const out = []
    for (const row of rows) {
      const person = row.personKey
        ? await ctx.db
            .query("people")
            .withIndex("by_key", (q) => q.eq("key", row.personKey as string))
            .first()
        : null
      out.push({
        key: row.key,
        scope: row.scope,
        orgKey: row.orgKey,
        field: row.field,
        contact: row.scope === "contact" && row.valueHash !== undefined,
        name: row.scope === "name",
        eventKey: row.eventKey,
        personKey: row.personKey,
        personName: person?.name,
        requestKey: row.requestKey,
        requestKind: row.requestKind,
        createdAt: row.createdAt,
      })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  },
})

/**
 * Lifts a suppression made in error: the row goes, and claims it set aside
 * count again (unless another suppression still forbids them). A lifted
 * listing stays hidden until the broker shows it again
 * (`broker.orgs.setHidden`).
 */
export const lift = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireBrokerUser(ctx)
    if (!(await liftSuppression(ctx, args.key))) throw new Error("That suppression was not found")
    return null
  },
})
