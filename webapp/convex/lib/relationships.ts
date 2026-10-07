import { relationshipKey } from "../../lib/keys"
import {
  type ClaimMethod,
  type EvidenceKind,
  PUBLICABLE_RELATIONSHIP_TYPES,
  type QuoteCheck,
  type RelationshipType,
  type RelationshipVisibility,
} from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import { hostOf } from "./fields"
import { sameFields, type UpsertOutcome } from "./ingest"
import { baseConfidence, storedStatus } from "./resolve"

/**
 * Upserting one graph edge (data-model §2 `relationships`), shared by the
 * relationships route and the event-organiser route (co-hosts and sponsors
 * create edges).
 *
 *  - The key is minted here, `rel-<sha1(from:type:to)>`, never accepted.
 *  - Evidence accumulates: de-duplicated by (sourceUrl, eventKey), newest
 *    first, at most `MAX_EVIDENCE`.
 *  - Confidence is by rule (§1.1): each sighting stores the confidence of its
 *    method and evidence kind; the edge takes the best sighting's, plus .05
 *    per additional independent host among the evidence, capped at .99.
 *  - Visibility defaults to `internal`. An edge becomes `public` only for
 *    `sponsors` / `co_hosted`, only on primary evidence (the organisation
 *    published it), and only when the caller asked; once public it stays so.
 */

export const MAX_EVIDENCE = 50

export type RelationshipSighting = {
  fromKey: string
  toKey: string
  type: RelationshipType
  evidence: { sourceUrl: string; eventKey?: string; note?: string; seenAt: number }
  method: ClaimMethod
  evidenceKind: EvidenceKind
  quoteCheck?: QuoteCheck
  /** Requested; granted only under the rules above. */
  visibility?: RelationshipVisibility
}

export function canBePublic(type: RelationshipType, evidenceKind: EvidenceKind): boolean {
  return (
    (PUBLICABLE_RELATIONSHIP_TYPES as readonly string[]).includes(type) &&
    evidenceKind === "primary"
  )
}

export async function upsertRelationship(
  ctx: MutationCtx,
  sighting: RelationshipSighting,
  now: number,
): Promise<UpsertOutcome> {
  if (sighting.fromKey === sighting.toKey) throw new Error("A relationship needs two parties")
  const key = relationshipKey(sighting.fromKey, sighting.type, sighting.toKey)
  const existing = await ctx.db
    .query("relationships")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()

  const status = storedStatus({
    method: sighting.method,
    quoteCheck: sighting.quoteCheck,
    hasQuote: sighting.quoteCheck !== undefined && sighting.quoteCheck !== "absent",
    hasValue: true,
  })
  const base = baseConfidence({ method: sighting.method, status, evidence: sighting.evidenceKind })

  const sameEvidence = (e: Doc<"relationships">["evidence"][number]) =>
    e.sourceUrl === sighting.evidence.sourceUrl && e.eventKey === sighting.evidence.eventKey
  const evidence = [
    { ...sighting.evidence, confidence: base },
    ...(existing?.evidence ?? []).filter((e) => !sameEvidence(e)),
  ]
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_EVIDENCE)

  // The best single sighting, plus .05 per additional independent host.
  const best = Math.max(...evidence.map((e) => e.confidence ?? 0.5))
  const hosts = new Set(evidence.map((e) => hostOf(e.sourceUrl))).size
  const confidence = Math.round(Math.min(0.99, best + 0.05 * (hosts - 1)) * 100) / 100

  const goesPublic =
    sighting.visibility === "public" && canBePublic(sighting.type, sighting.evidenceKind)
  const visibility: RelationshipVisibility =
    existing?.visibility === "public" || goesPublic ? "public" : "internal"

  const fields = {
    key,
    fromKey: sighting.fromKey,
    toKey: sighting.toKey,
    type: sighting.type,
    evidence,
    firstSeenAt: Math.min(
      existing?.firstSeenAt ?? sighting.evidence.seenAt,
      sighting.evidence.seenAt,
    ),
    lastSeenAt: Math.max(
      existing?.lastSeenAt ?? sighting.evidence.seenAt,
      sighting.evidence.seenAt,
    ),
    confidence,
    visibility,
  }
  if (existing) {
    if (sameFields(existing, fields)) return "unchanged"
    await ctx.db.patch("relationships", existing._id, { ...fields, updatedAt: now })
    return "updated"
  }
  await ctx.db.insert("relationships", { ...fields, createdAt: now, updatedAt: now })
  return "inserted"
}
