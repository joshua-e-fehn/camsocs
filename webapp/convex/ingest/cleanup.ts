import { v } from "convex/values"
import { EVENT_HOSTING, EVENT_VISIBILITIES } from "../../lib/vocab"
import { internalMutation, internalQuery } from "../_generated/server"
import { literalUnion } from "../lib/validators"
import { deleteEntity } from "./purge"

/**
 * Taking stored events back off a deployment when a corrected reader will
 * never restate them: the calendar notices (decision D6) and the titles an
 * earlier D1 redaction wrote ("I someone"), posted before those fixes, whose
 * readings lie in the past and are read no more (review 2026-10-10). The
 * operator runs it as `camsocs clean-events` (docs/deploy.md §7): a dry run
 * lists the candidates, `--env prod --apply` removes them.
 *
 *  - `eventsPage` (`POST /api/pipeline/events/scan`) reads every event, a
 *    page at a time, with what the pipeline's rules judge it by: title,
 *    venue, the start of its description, source, hosting, organisers,
 *    listing and last sighting. Internal: it reads past the public gate
 *    (`cam_only` notices are noise too).
 *  - `removeEvents` (`POST /api/pipeline/events/remove`) deletes events by
 *    key, as `ingest/purge:removeEntity` does (claims, organiser links, the
 *    row; the organisers re-derived) — events only, at most
 *    `MAX_REMOVALS` a call, and only with `confirm: "REMOVE-EVENTS"`.
 */

/** Events a scan call returns at most. */
export const SCAN_PAGE = 200
/** Events one removal call deletes at most (each with every claim it has). */
export const MAX_REMOVALS = 25
/** How much of a description a scan returns: enough for the rules. */
export const SCAN_DESCRIPTION = 1_000

export const eventsPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  returns: v.object({
    page: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
        venueText: v.optional(v.string()),
        startsAt: v.number(),
        source: v.string(),
        sourceUrl: v.string(),
        visibility: literalUnion(EVENT_VISIBILITIES),
        hosting: v.optional(literalUnion(EVENT_HOSTING)),
        organiserKeys: v.array(v.string()),
        sweepGroup: v.optional(v.string()),
        lastSeenAt: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(SCAN_PAGE, Math.floor(args.limit ?? SCAN_PAGE)))
    const result = await ctx.db
      .query("events")
      .withIndex("by_startsAt")
      .paginate({ numItems: limit, cursor: args.cursor ?? null })
    return {
      page: result.page.map((event) => ({
        key: event.key,
        title: event.title,
        description: event.description?.slice(0, SCAN_DESCRIPTION),
        venueText: event.venueText,
        startsAt: event.startsAt,
        source: event.source,
        sourceUrl: event.sourceUrl,
        visibility: event.visibility,
        hosting: event.hosting,
        organiserKeys: [...event.organiserKeys, ...event.coHostKeys],
        sweepGroup: event.sweepGroup,
        lastSeenAt: event.lastSeenAt,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})

export const removeEvents = internalMutation({
  args: { keys: v.array(v.string()), confirm: v.literal("REMOVE-EVENTS") },
  returns: v.object({ removed: v.array(v.string()), missing: v.array(v.string()) }),
  handler: async (ctx, args) => {
    if (args.keys.length > MAX_REMOVALS) {
      throw new Error(`At most ${MAX_REMOVALS} events per call`)
    }
    const removed: string[] = []
    const missing: string[] = []
    for (const key of new Set(args.keys)) {
      if (!key.startsWith("evt-")) throw new Error(`Not an event key: ${key}`)
      const deleted = await deleteEntity(ctx, "event", key)
      if (deleted.events) removed.push(key)
      else missing.push(key)
    }
    return { removed, missing }
  },
})
