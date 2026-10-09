import { sourceKey } from "../../lib/keys"
import type { ListingRequestKind } from "../../lib/vocab"
import { internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import { emptyProfile } from "../ingest/broker"
import { type ClaimInput, reresolveEntity } from "../ingest/claims"
import { findOrganisation, writeOrgCard } from "./entityStore"
import {
  carriesSuppressedAddress,
  indexSuppressions,
  MAX_SUPPRESSIONS,
  type SuppressionTarget,
  suppressedClaim,
  suppressionKey,
  suppressionSourceUrl,
} from "./suppressions"

/**
 * What creating or lifting a suppression does to the data already stored
 * (convex/lib/suppressions.ts says what a suppression is). Used by the
 * broker's listing-request inbox (convex/broker/listingRequests.ts).
 *
 * Creating one:
 *  - `organisation`: hides the listing (`hidden`, the same switch as
 *    `broker.orgs.setHidden`) and suppresses it from outreach (the broker
 *    profile's `suppressed`);
 *  - `field`: sets the field's value claims aside (`reviewStatus: rejected`)
 *    and records a manual negative claim, so the field reads `missing` /
 *    `not_published`;
 *  - `contact`: sets aside every live claim of the listing whose value
 *    carries the address, the same way, field by field;
 *  - `person`: deletes the broker `people` row.
 *
 * Lifting one deletes the row and undoes the claim side (set-aside claims are
 * accepted again unless another suppression still forbids them; the negative
 * claim is withdrawn). A lifted listing stays hidden until the broker shows it
 * again — showing a listing is a decision of its own.
 */

/** Claims read per entity when looking for set-aside candidates. */
const CLAIMS_CAP = 4_000
const LIVE = ["accepted", "proposed"] as const

export type SuppressionRequest = { key: string; kind: ListingRequestKind }

/** Creates (or finds) the suppression for `target` and enforces it. */
export async function createSuppression(
  ctx: MutationCtx,
  target: SuppressionTarget,
  request?: SuppressionRequest,
): Promise<{ key: string; created: boolean }> {
  const key = suppressionKey(target)
  const existing = await ctx.db
    .query("suppressions")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  if (!existing) {
    await ctx.db.insert("suppressions", {
      key,
      scope: target.scope,
      orgKey: target.orgKey,
      field: target.field,
      valueHash: target.valueHash,
      personKey: target.personKey,
      requestKey: request?.key,
      requestKind: request?.kind,
      createdAt: Date.now(),
    })
  }
  await enforce(ctx, { ...target, key })
  return { key, created: !existing }
}

async function enforce(ctx: MutationCtx, row: SuppressionTarget & { key: string }) {
  if (row.scope === "organisation" && row.orgKey) {
    await hideListing(ctx, row.orgKey)
    return
  }
  if (row.scope === "person" && row.personKey) {
    const people = await ctx.db
      .query("people")
      .withIndex("by_key", (q) => q.eq("key", row.personKey as string))
      .take(10)
    for (const person of people) await ctx.db.delete("people", person._id)
    return
  }
  if (!row.orgKey) return
  const index = indexSuppressions([row])
  const claims = await liveOrganisationClaims(ctx, row.orgKey)
  const affected = new Set<string>()
  for (const claim of claims) {
    if (claim.value === undefined) continue
    const hit =
      row.scope === "field"
        ? claim.field === row.field
        : carriesSuppressedAddress(claim.value, index.contacts)
    if (!hit) continue
    await ctx.db.patch("fieldClaims", claim._id, { reviewStatus: "rejected" })
    affected.add(claim.field)
  }
  if (row.scope === "field" && row.field) affected.add(row.field)
  if (affected.size === 0) return
  // A manual negative claim per field: it re-resolves the field without the
  // set-aside readings, and says why it is empty (`not_published`).
  const url = suppressionSourceUrl(row.key)
  const negatives: ClaimInput[] = [...affected].map((field) => ({
    entityType: "organisation",
    entityKey: row.orgKey as string,
    field,
    status: "missing",
    missingReason: "not_published",
    evidence: "primary",
    method: "manual",
    extractor: "suppression",
    sourceKey: sourceKey(url),
    sourceUrl: url,
    sourceType: "manual",
    retrievedAt: Date.now(),
  }))
  const result = await ctx.runMutation(internal.ingest.claims.ingest, { claims: negatives })
  // No listing yet: nothing is stored to set aside, and the suppression
  // itself keeps everything out from now on.
  if (!(await findOrganisation(ctx, row.orgKey))) return
  if (result.rejected.length > 0) {
    throw new Error(`Could not record the suppression: ${result.rejected[0].reason}`)
  }
  // Also when the negative claims were already on record (the same
  // suppression accepted again): the set-aside readings must leave the row.
  await reresolveEntity(ctx, "organisation", row.orgKey, [...affected])
}

async function hideListing(ctx: MutationCtx, orgKey: string) {
  const org = await findOrganisation(ctx, orgKey)
  const now = Date.now()
  if (org && org.hidden !== true) {
    await ctx.db.patch("organisations", org._id, { hidden: true, updatedAt: now })
    const updated = await ctx.db.get("organisations", org._id)
    if (updated) await writeOrgCard(ctx, updated)
  }
  const profile = await ctx.db
    .query("orgBrokerProfiles")
    .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
    .unique()
  if (profile) {
    if (!profile.suppressed) {
      await ctx.db.patch("orgBrokerProfiles", profile._id, { suppressed: true, updatedAt: now })
    }
  } else if (org) {
    await ctx.db.insert("orgBrokerProfiles", {
      ...emptyProfile(orgKey),
      suppressed: true,
      createdAt: now,
      updatedAt: now,
    })
  }
}

async function liveOrganisationClaims(ctx: MutationCtx, orgKey: string) {
  const out: Doc<"fieldClaims">[] = []
  for (const reviewStatus of LIVE) {
    out.push(
      ...(await ctx.db
        .query("fieldClaims")
        .withIndex("by_entity_review", (q) =>
          q
            .eq("entityType", "organisation")
            .eq("entityKey", orgKey)
            .eq("reviewStatus", reviewStatus),
        )
        .take(CLAIMS_CAP)),
    )
  }
  return out
}

/** Deletes a suppression and undoes its claim side (module docstring). */
export async function liftSuppression(ctx: MutationCtx, key: string): Promise<boolean> {
  const row = await ctx.db
    .query("suppressions")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  if (!row) return false
  await ctx.db.delete("suppressions", row._id)
  if ((row.scope !== "field" && row.scope !== "contact") || !row.orgKey) return true

  const orgKey = row.orgKey
  const remaining = indexSuppressions(await ctx.db.query("suppressions").take(MAX_SUPPRESSIONS))
  const lifted = indexSuppressions([row])
  const affected = new Set<string>()
  const rejected = await ctx.db
    .query("fieldClaims")
    .withIndex("by_entity_review", (q) =>
      q.eq("entityType", "organisation").eq("entityKey", orgKey).eq("reviewStatus", "rejected"),
    )
    .take(CLAIMS_CAP)
  for (const claim of rejected) {
    const ours =
      row.scope === "field"
        ? claim.field === row.field
        : carriesSuppressedAddress(claim.value, lifted.contacts)
    if (!ours || suppressedClaim(claim, remaining) !== null) continue
    await ctx.db.patch("fieldClaims", claim._id, { reviewStatus: "accepted" })
    affected.add(claim.field)
  }
  // Withdraw the suppression's own negative claims.
  const url = suppressionSourceUrl(row.key)
  for (const claim of await liveOrganisationClaims(ctx, orgKey)) {
    if (claim.sourceUrl !== url) continue
    await ctx.db.patch("fieldClaims", claim._id, { reviewStatus: "rejected" })
    affected.add(claim.field)
  }
  if (affected.size > 0) await reresolveEntity(ctx, "organisation", orgKey, [...affected])
  return true
}
