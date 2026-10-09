import { v } from "convex/values"
import {
  CLAIM_METHODS,
  EVENT_ORGANISER_ROLES,
  EVIDENCE_KINDS,
  QUOTE_CHECKS,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_VISIBILITIES,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import { internalMutation } from "../_generated/server"
import { eventOrganiserCopy, loadTerms } from "../lib/entityStore"
import { isHttpUrl, isOrgKey } from "../lib/fields"
import { assertBatchSize, emptyBatchResult, recordBatch } from "../lib/ingest"
import { upsertRelationship } from "../lib/relationships"
import { loadSuppressionIndex } from "../lib/suppressions"
import { literalUnion } from "../lib/validators"
import { relationshipEvidenceValidator } from "../schema"
import { refreshOrganisations } from "./claims"

/**
 * `POST /api/pipeline/relationships` — graph edges between organisations,
 * upserted by the server-minted key with evidence merged (convex/lib/relationships.ts).
 *
 * `POST /api/pipeline/eventOrganisers` — replaces the organiser set of each
 * event: the `eventOrganisers` join rows, the event's `organiserKeys` /
 * `coHostKeys` / `sponsorKeys`, and the edges they imply (each co-host
 * `co_hosted` with each organiser; each sponsor `sponsors` each organiser).
 *
 * A listing removed on request (convex/lib/suppressions.ts) is no edge's end
 * and no event's organiser: such edges are skipped (`suppressed`) and such
 * organisers left out of the set — the pipeline filters them first; this is
 * the backstop.
 */

export const relationshipInputValidator = v.object({
  fromKey: v.string(),
  toKey: v.string(),
  type: literalUnion(RELATIONSHIP_TYPES),
  evidence: relationshipEvidenceValidator,
  method: literalUnion(CLAIM_METHODS),
  evidenceKind: literalUnion(EVIDENCE_KINDS),
  quoteCheck: v.optional(literalUnion(QUOTE_CHECKS)),
  visibility: v.optional(literalUnion(RELATIONSHIP_VISIBILITIES)),
})

const batchResult = v.object({
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  /** Edges skipped because an end was removed on request. */
  suppressed: v.number(),
})

export const upsert = internalMutation({
  args: { relationships: v.array(relationshipInputValidator) },
  returns: batchResult,
  handler: async (ctx, args) => {
    assertBatchSize(args.relationships.length, "relationships")
    const now = Date.now()
    const result = { ...emptyBatchResult(), suppressed: 0 }
    const suppressions = await loadSuppressionIndex(ctx)
    for (const relationship of args.relationships) {
      if (!isOrgKey(relationship.fromKey) || !isOrgKey(relationship.toKey)) {
        throw new Error(`Relationship ends must be organisation keys`)
      }
      if (!isHttpUrl(relationship.evidence.sourceUrl)) {
        throw new Error(`Evidence sourceUrl must be http(s): ${relationship.evidence.sourceUrl}`)
      }
      if (
        suppressions.organisations.has(relationship.fromKey) ||
        suppressions.organisations.has(relationship.toKey)
      ) {
        result.suppressed++
        continue
      }
      recordBatch(result, await upsertRelationship(ctx, relationship, now))
    }
    return result
  },
})

export const eventOrganiserSetValidator = v.object({
  eventKey: v.string(),
  organisers: v.array(v.object({ orgKey: v.string(), role: literalUnion(EVENT_ORGANISER_ROLES) })),
  /** `replace` (default): the set is the event's whole organiser list, and
   * rows not in it are removed. `merge`: the sender could not resolve every
   * organiser the source names, so it only adds — nothing known is removed. */
  mode: v.optional(v.union(v.literal("replace"), v.literal("merge"))),
})

export const setEventOrganisers = internalMutation({
  args: { events: v.array(eventOrganiserSetValidator) },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    missingEvents: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    assertBatchSize(args.events.length, "events")
    const now = Date.now()
    const result = { ...emptyBatchResult(), missingEvents: [] as string[] }
    const touchedOrgs = new Set<string>()
    const suppressions = await loadSuppressionIndex(ctx)

    for (const sent of args.events) {
      if (sent.organisers.length > 50) throw new Error(`${sent.eventKey}: at most 50 organisers`)
      for (const { orgKey } of sent.organisers) {
        if (!isOrgKey(orgKey)) throw new Error(`Not an organisation key: ${orgKey}`)
      }
      const set = {
        ...sent,
        organisers: sent.organisers.filter((o) => !suppressions.organisations.has(o.orgKey)),
      }
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", set.eventKey))
        .unique()
      if (!event) {
        result.missingEvents.push(set.eventKey)
        continue
      }

      const merge = set.mode === "merge"
      const wanted = new Map(set.organisers.map((o) => [`${o.orgKey}:${o.role}`, o]))
      const current = await ctx.db
        .query("eventOrganisers")
        .withIndex("by_event", (q) => q.eq("eventKey", event.key))
        .take(200)
      const kept: { orgKey: string; role: string }[] = []
      let changed = false
      for (const row of current) {
        touchedOrgs.add(row.orgKey)
        if (wanted.delete(`${row.orgKey}:${row.role}`) || merge) {
          kept.push(row)
          continue
        }
        await ctx.db.delete("eventOrganisers", row._id)
        changed = true
      }
      for (const organiser of wanted.values()) {
        await ctx.db.insert("eventOrganisers", {
          eventKey: event.key,
          orgKey: organiser.orgKey,
          role: organiser.role,
          ...eventOrganiserCopy(event),
        })
        kept.push(organiser)
        touchedOrgs.add(organiser.orgKey)
        changed = true
      }

      // The event mirrors what is now in the join table (in the order sent,
      // then any kept rows the sender did not name).
      const all = [...set.organisers, ...kept]
      const byRole = (role: string) => [
        ...new Set(all.filter((o) => o.role === role).map((o) => o.orgKey)),
      ]
      const keys = {
        organiserKeys: byRole("organiser"),
        coHostKeys: byRole("co_host"),
        sponsorKeys: byRole("sponsor"),
      }
      if (
        changed ||
        keys.organiserKeys.join() !== event.organiserKeys.join() ||
        keys.coHostKeys.join() !== event.coHostKeys.join() ||
        keys.sponsorKeys.join() !== event.sponsorKeys.join()
      ) {
        await ctx.db.patch("events", event._id, { ...keys, updatedAt: now })
        result.updated++
      } else {
        result.unchanged++
      }
      await recordEdges(ctx, event, keys, now)
    }

    await refreshOrganisations(ctx, touchedOrgs, { now, terms: await loadTerms(ctx) })
    return result
  },
})

/** The edges an event's organiser set implies, evidenced by the event itself. */
async function recordEdges(
  ctx: Parameters<typeof upsertRelationship>[0],
  event: Doc<"events">,
  keys: { organiserKeys: string[]; coHostKeys: string[]; sponsorKeys: string[] },
  now: number,
): Promise<void> {
  const evidenceKind = event.meta.title?.evidence ?? "secondary"
  const method = event.meta.title?.method ?? "parser"
  const sighting = {
    evidence: { sourceUrl: event.sourceUrl, eventKey: event.key, seenAt: event.lastSeenAt },
    method,
    evidenceKind,
    // Published on a public event by the organiser: eligible to be shown.
    visibility: event.visibility === "public" ? ("public" as const) : ("internal" as const),
  }
  for (const organiser of keys.organiserKeys) {
    for (const coHost of keys.coHostKeys) {
      if (coHost === organiser) continue
      await upsertRelationship(
        ctx,
        { ...sighting, fromKey: organiser, toKey: coHost, type: "co_hosted" },
        now,
      )
    }
    for (const sponsor of keys.sponsorKeys) {
      if (sponsor === organiser) continue
      await upsertRelationship(
        ctx,
        { ...sighting, fromKey: sponsor, toKey: organiser, type: "sponsors" },
        now,
      )
    }
  }
}
