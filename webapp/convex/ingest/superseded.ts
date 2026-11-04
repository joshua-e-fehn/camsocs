import { type Infer, v } from "convex/values"
import type { Doc } from "../_generated/dataModel"
import { internalMutation, type MutationCtx } from "../_generated/server"
import { loadTerms, refreshOrganisation, syncEventOrganiserRows } from "../lib/entityStore"
import { assertBatchSize } from "../lib/ingest"

/**
 * `POST /api/pipeline/events/superseded` — event keys a higher-ranked source
 * took over (ENG-47).
 *
 * An event key is `evt-<sha1(source:externalId)>`, so one evening read from a
 * society's page and from the University's programme is two keys; the load
 * folds the lower-ranked reading into the other's event
 * (pipeline events/duplicates.py) and posts its claims there. The page's key
 * may already hold an event from a load before the University listed the
 * evening (ENG-24): nothing posts under it again, so its listing never sights
 * it and it would show beside the survivor until its date passed. Each load
 * therefore posts every folded reading's own key with its primary's, and this
 * records `supersededBy` on the old event:
 *
 * - every public list, page and the sitemap leave it out (lib/entityStore.ts
 *   `withdrawnCheck`), activity counts skip it (`eventOrganisers.superseded`),
 *   and `/events/<key>` answers with a 308 to the survivor (`events.locate`,
 *   proxy.ts);
 * - its claims, organiser links and row stay, so nothing is lost and
 *   retention deletes it a year after it ended, as any event;
 * - it comes back when its own reading is the primary again (the University
 *   dropped the evening): the load then posts its identity claims, and the
 *   claims route clears `supersededBy` (`revive`).
 *
 * Most posted keys never had an event of their own (the reading was folded
 * from its first load): they are counted `unknown` and nothing is written.
 * A survivor this deployment does not have is `unknown` too. Re-posting the
 * same pair is `unchanged`.
 */

const EVENT_KEY = /^evt-[0-9a-f]{40}$/

const pairValidator = v.object({
  /** The key the folded reading would have had. */
  key: v.string(),
  /** The event it was folded into. */
  by: v.string(),
})

const resultValidator = v.object({
  updated: v.number(),
  unchanged: v.number(),
  /** Pairs naming an old key or a survivor this deployment does not have. */
  unknown: v.number(),
  rejected: v.array(v.object({ index: v.number(), key: v.string(), reason: v.string() })),
})
type Result = Infer<typeof resultValidator>

async function eventByKey(ctx: MutationCtx, key: string): Promise<Doc<"events"> | null> {
  return await ctx.db
    .query("events")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

/** Keeps the organiser rows' copy in step and re-derives their organisations
 * (`lastActiveAt`, activity), after `supersededBy` changed. */
async function afterChange(ctx: MutationCtx, event: Doc<"events">, now: number): Promise<void> {
  const orgKeys = new Set(await syncEventOrganiserRows(ctx, event))
  if (orgKeys.size === 0) return
  const terms = await loadTerms(ctx)
  for (const orgKey of orgKeys) {
    const org = await ctx.db
      .query("organisations")
      .withIndex("by_key", (q) => q.eq("key", orgKey))
      .unique()
    if (org) await refreshOrganisation(ctx, org, { now, terms })
  }
}

export const supersede = internalMutation({
  args: { events: v.array(pairValidator) },
  returns: resultValidator,
  handler: async (ctx, args) => {
    assertBatchSize(args.events.length, "superseded events")
    const now = Date.now()
    const result: Result = { updated: 0, unchanged: 0, unknown: 0, rejected: [] }
    for (const [index, pair] of args.events.entries()) {
      const reason = !EVENT_KEY.test(pair.key)
        ? "key is not an event key"
        : !EVENT_KEY.test(pair.by)
          ? "by is not an event key"
          : pair.key === pair.by
            ? "an event cannot supersede itself"
            : null
      if (reason) {
        result.rejected.push({ index, key: pair.key.slice(0, 200), reason })
        continue
      }
      const old = await eventByKey(ctx, pair.key)
      const survivor = old ? await eventByKey(ctx, pair.by) : null
      if (!old || !survivor) {
        result.unknown++
        continue
      }
      if (old.supersededBy === pair.by) {
        result.unchanged++
        continue
      }
      await ctx.db.patch("events", old._id, { supersededBy: pair.by, supersededAt: now })
      await afterChange(ctx, { ...old, supersededBy: pair.by, supersededAt: now }, now)
      result.updated++
    }
    return result
  },
})

/**
 * Brings a superseded event back (the claims route, convex/ingest/claims.ts):
 * its own identity claims were posted, so this load read it as a primary
 * again. A no-op for an event that is not superseded.
 */
export async function revive(ctx: MutationCtx, event: Doc<"events">, now: number): Promise<void> {
  if (event.supersededBy === undefined) return
  await ctx.db.patch("events", event._id, { supersededBy: undefined, supersededAt: undefined })
  await afterChange(ctx, { ...event, supersededBy: undefined, supersededAt: undefined }, now)
}
