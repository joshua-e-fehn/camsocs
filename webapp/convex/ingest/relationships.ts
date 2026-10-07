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
import { loadTerms } from "../lib/entityStore"
import { isHttpUrl } from "../lib/fields"
import { assertBatchSize, emptyBatchResult, recordBatch } from "../lib/ingest"
import { upsertRelationship } from "../lib/relationships"
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
 */

const ORG_KEY = /^org-[a-z0-9-]+$/

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

const batchResult = v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() })

export const upsert = internalMutation({
  args: { relationships: v.array(relationshipInputValidator) },
  returns: batchResult,
  handler: async (ctx, args) => {
    assertBatchSize(args.relationships.length, "relationships")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const relationship of args.relationships) {
      if (!ORG_KEY.test(relationship.fromKey) || !ORG_KEY.test(relationship.toKey)) {
        throw new Error(`Relationship ends must be organisation keys`)
      }
      if (!isHttpUrl(relationship.evidence.sourceUrl)) {
        throw new Error(`Evidence sourceUrl must be http(s): ${relationship.evidence.sourceUrl}`)
      }
      recordBatch(result, await upsertRelationship(ctx, relationship, now))
    }
    return result
  },
})

export const eventOrganiserSetValidator = v.object({
  eventKey: v.string(),
  organisers: v.array(v.object({ orgKey: v.string(), role: literalUnion(EVENT_ORGANISER_ROLES) })),
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

    for (const set of args.events) {
      if (set.organisers.length > 50) throw new Error(`${set.eventKey}: at most 50 organisers`)
      for (const { orgKey } of set.organisers) {
        if (!ORG_KEY.test(orgKey)) throw new Error(`Not an organisation key: ${orgKey}`)
      }
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", set.eventKey))
        .unique()
      if (!event) {
        result.missingEvents.push(set.eventKey)
        continue
      }

      const wanted = new Map(set.organisers.map((o) => [`${o.orgKey}:${o.role}`, o]))
      const current = await ctx.db
        .query("eventOrganisers")
        .withIndex("by_event", (q) => q.eq("eventKey", event.key))
        .take(200)
      let changed = false
      for (const row of current) {
        touchedOrgs.add(row.orgKey)
        if (wanted.delete(`${row.orgKey}:${row.role}`)) continue
        await ctx.db.delete("eventOrganisers", row._id)
        changed = true
      }
      for (const organiser of wanted.values()) {
        await ctx.db.insert("eventOrganisers", {
          eventKey: event.key,
          orgKey: organiser.orgKey,
          role: organiser.role,
          startsAt: event.startsAt,
          visibility: event.visibility,
        })
        touchedOrgs.add(organiser.orgKey)
        changed = true
      }

      const byRole = (role: string) => [
        ...new Set(set.organisers.filter((o) => o.role === role).map((o) => o.orgKey)),
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
