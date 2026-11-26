import { v } from "convex/values"
import { internal } from "./_generated/api"
import { internalMutation } from "./_generated/server"
import { relatedCards } from "./lib/orgActivity"
import { MAX_CARDS } from "./orgs"

/**
 * Each listing's related listings, precomputed (ENG-279). `orgs.related`
 * used to read every directory card on every profile view to rank a handful
 * (~700 KB a call on production, the largest single reader of the
 * deployment); it now reads the listing's `relatedOrgs` row and the cards it
 * names, and re-checks each with `relatedScore` so a card archived, hidden or
 * turned counterpart since the walk drops out.
 *
 * The ranking is `relatedCards` over the same cards `orgs.related` read, so
 * the lists are the same, as of the last walk: `daily` (convex/crons.ts)
 * after the morning derivation. A listing without a row yet (new since the
 * walk) is ranked live, as before.
 */

/** Keys kept per listing: twice what a profile shows, so one that drops out
 * at read time (archived, hidden) leaves the list full. */
export const STORED_RELATED = 12
/** Listings ranked per transaction; each page reads every card once. */
const PAGE = 100

export const recompute = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ processed: v.number(), changed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const listed = () =>
      ctx.db
        .query("orgCards")
        .withIndex("by_isCounterpart_nameSort", (i) => i.eq("isCounterpart", false))
    const cards = await listed().take(MAX_CARDS)
    const page = await listed().paginate({ numItems: PAGE, cursor: args.cursor ?? null })
    const now = Date.now()
    let changed = 0
    for (const base of page.page) {
      const relatedKeys = relatedCards(base, cards, STORED_RELATED).map((card) => card.key)
      const row = await ctx.db
        .query("relatedOrgs")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", base.key))
        .unique()
      if (!row) {
        await ctx.db.insert("relatedOrgs", { orgKey: base.key, relatedKeys, updatedAt: now })
        changed++
      } else if (row.relatedKeys.join("\n") !== relatedKeys.join("\n")) {
        await ctx.db.patch("relatedOrgs", row._id, { relatedKeys, updatedAt: now })
        changed++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.related.recompute, { cursor: page.continueCursor })
    } else {
      // The last page: rows of listings no longer listed (hidden, merged
      // away, turned counterpart) go.
      const keys = new Set(cards.map((card) => card.key))
      for (const row of await ctx.db.query("relatedOrgs").take(MAX_CARDS)) {
        if (!keys.has(row.orgKey)) {
          await ctx.db.delete("relatedOrgs", row._id)
          changed++
        }
      }
    }
    return { processed: page.page.length, changed, done: page.isDone }
  },
})

/** The daily cron's entry point (convex/crons.ts `related-daily`). */
export const daily = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.related.recompute, {})
    return null
  },
})
