import { sourceKey } from "../../lib/keys"
import { type ListingRequestKind, REVIEW_STATUSES } from "../../lib/vocab"
import { internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import { emptyProfile } from "../ingest/broker"
import { type ClaimInput, reresolveEntity } from "../ingest/claims"
import { deleteFileIfUnused } from "../retention"
import { findOrganisation, loadTerms, refreshOrganisation, writeOrgCard } from "./entityStore"
import {
  carriesSuppressedAddress,
  indexSuppressions,
  MAX_SUPPRESSIONS,
  type SuppressionTarget,
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
 *  - `field`: sets the field's value claims aside and records a manual
 *    negative claim, so the field reads `missing` / `not_published`;
 *  - `contact`: sets aside every live claim of the listing whose value
 *    carries the address, the same way, field by field — then, a page at a
 *    time, every other claim that carries it, of any listing, event or
 *    session (`ingest/suppressions:setAsideAddress`);
 *  - `person`: deletes the broker `people` row;
 *  - `event`: deletes the event, its claims and organiser links (its
 *    organisers are re-derived); no later harvest records it again;
 *  - `name`: sets aside, a page at a time, every claim whose value names the
 *    person (`ingest/suppressions:setAsideAddress` with scope `name`).
 *
 * A claim set aside keeps only its place in the log (entity, field, source,
 * status, fingerprint, `setAsideBy`): its value, original text and quote are
 * cleared, so what was removed on request is not kept (the privacy notice:
 * "a minimal record").
 *
 * Lifting one deletes the row and undoes the claim side: the set-aside
 * claims are deleted (the next harvest records those readings afresh) and the
 * negative claim is withdrawn. A lifted listing stays hidden until the broker
 * shows it again — showing a listing is a decision of its own — but outreach,
 * which the suppression turned off (`outreachSuppressed`), is turned back on.
 */

/** What setting a claim aside keeps of it: its place in the log, never its
 * value, original text or quote. */
export function setAsidePatch(key: string) {
  return {
    reviewStatus: "rejected" as const,
    setAsideBy: key,
    value: undefined,
    valueRaw: undefined,
    evidenceQuote: undefined,
  }
}

/** Set-aside claims deleted per call when a suppression is lifted. */
const DROP_PAGE = 500

/** Deletes the claims suppression `key` set aside, a page now and the rest
 * scheduled (`ingest/suppressions:dropSetAside`). Returns whether all went. */
export async function dropSetAsideClaims(ctx: MutationCtx, key: string): Promise<boolean> {
  const claims = await ctx.db
    .query("fieldClaims")
    .withIndex("by_setAsideBy", (q) => q.eq("setAsideBy", key))
    .take(DROP_PAGE + 1)
  for (const claim of claims.slice(0, DROP_PAGE)) await ctx.db.delete("fieldClaims", claim._id)
  if (claims.length <= DROP_PAGE) return true
  await ctx.scheduler.runAfter(0, internal.ingest.suppressions.dropSetAside, { key })
  return false
}

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
      eventKey: target.eventKey,
      requestKey: request?.key,
      requestKind: request?.kind,
      createdAt: Date.now(),
    })
  }
  await enforce(ctx, { ...target, key })
  return { key, created: !existing }
}

async function enforce(ctx: MutationCtx, row: SuppressionTarget & { key: string }) {
  if (row.scope === "event" && row.eventKey) {
    await removeEvent(ctx, row.eventKey)
    return
  }
  if (row.scope === "name" && row.valueHash) {
    await ctx.scheduler.runAfter(0, internal.ingest.suppressions.setAsideAddress, {
      key: row.key,
      valueHash: row.valueHash,
      scope: "name",
      cursor: null,
    })
    return
  }
  if (row.scope === "organisation" && row.orgKey) {
    if (await hideListing(ctx, row.orgKey)) {
      const stored = await ctx.db
        .query("suppressions")
        .withIndex("by_key", (q) => q.eq("key", row.key))
        .unique()
      if (stored) await ctx.db.patch("suppressions", stored._id, { outreachSuppressed: true })
    }
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
  if (row.scope === "contact" && row.valueHash) {
    // Every other listing, event and session quoting the address, a page at a time.
    await ctx.scheduler.runAfter(0, internal.ingest.suppressions.setAsideAddress, {
      key: row.key,
      valueHash: row.valueHash,
      cursor: null,
    })
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
    await ctx.db.patch("fieldClaims", claim._id, setAsidePatch(row.key))
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

/** Deletes an event removed on request: its claims, organiser links, row and
 * (when nothing else shows it) its stored image; its organisers are
 * re-derived. */
async function removeEvent(ctx: MutationCtx, eventKey: string): Promise<void> {
  for (const reviewStatus of REVIEW_STATUSES) {
    const claims = await ctx.db
      .query("fieldClaims")
      .withIndex("by_entity_review", (q) =>
        q.eq("entityType", "event").eq("entityKey", eventKey).eq("reviewStatus", reviewStatus),
      )
      .take(2_000)
    for (const claim of claims) await ctx.db.delete("fieldClaims", claim._id)
  }
  const links = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_event", (q) => q.eq("eventKey", eventKey))
    .take(200)
  for (const link of links) await ctx.db.delete("eventOrganisers", link._id)
  const event = await ctx.db
    .query("events")
    .withIndex("by_key", (q) => q.eq("key", eventKey))
    .unique()
  if (event) {
    await ctx.db.delete("events", event._id)
    if (event.image?.storageId) await deleteFileIfUnused(ctx, event.image.storageId)
  }
  const now = Date.now()
  const terms = await loadTerms(ctx)
  for (const orgKey of new Set(links.map((link) => link.orgKey))) {
    const org = await findOrganisation(ctx, orgKey)
    if (org) await refreshOrganisation(ctx, org, { now, terms })
  }
}

/** Hides a listing and takes it out of outreach. Returns whether it turned
 * outreach off (it was on), so lifting the suppression can turn it back on. */
async function hideListing(ctx: MutationCtx, orgKey: string): Promise<boolean> {
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
      return true
    }
    return false
  }
  if (org) {
    await ctx.db.insert("orgBrokerProfiles", {
      ...emptyProfile(orgKey),
      suppressed: true,
      createdAt: now,
      updatedAt: now,
    })
    return true
  }
  return false
}

/** Puts a listing back into outreach when its lifted suppression took it out
 * and no other organisation suppression of it remains. */
async function restoreOutreach(ctx: MutationCtx, row: Doc<"suppressions">): Promise<void> {
  if (!row.outreachSuppressed || !row.orgKey) return
  const orgKey = row.orgKey
  const others = await ctx.db
    .query("suppressions")
    .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
    .take(MAX_SUPPRESSIONS)
  if (others.some((other) => other.scope === "organisation")) return
  const profile = await ctx.db
    .query("orgBrokerProfiles")
    .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
    .unique()
  if (profile?.suppressed) {
    await ctx.db.patch("orgBrokerProfiles", profile._id, {
      suppressed: false,
      updatedAt: Date.now(),
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
  if (row.scope === "organisation") {
    // The listing stays hidden until the broker shows it again; outreach,
    // which the suppression alone turned off, is back on.
    await restoreOutreach(ctx, row)
    return true
  }
  if (row.scope === "event") return true // the next harvest records it again
  if (row.scope !== "field" && row.scope !== "contact" && row.scope !== "name") return true
  // The set-aside readings kept no value: they go, and the next harvest
  // records them afresh (their fingerprints would otherwise keep them out).
  await dropSetAsideClaims(ctx, row.key)
  if (!row.orgKey) return true

  const orgKey = row.orgKey
  const affected = new Set<string>()
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
