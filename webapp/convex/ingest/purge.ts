import { v } from "convex/values"
import { ENTITY_TYPES } from "../../lib/vocab"
import type { TableNames } from "../_generated/dataModel"
import { internalMutation, type MutationCtx } from "../_generated/server"
import { ENTITY_TABLES, findEntity, loadTerms, refreshOrganisation } from "../lib/entityStore"
import { FIELD_SPECS, hostOf } from "../lib/fields"
import { literalUnion } from "../lib/validators"
import { reresolveEntity } from "./claims"

/**
 * Deleting pipeline data. Two tools, both internal:
 *
 *  - `purge` (`POST /api/pipeline/purge`) empties every pipeline-owned table
 *    on the **dev** deployment, to reset it before a full harvest. It refuses
 *    unless the body says `{"confirm": "PURGE-DEV"}` *and* the deployment's
 *    own `CONVEX_CLOUD_URL` names the dev deployment — a production URL can
 *    never match, whatever key or body reaches it. It deletes at most
 *    `PURGE_BUDGET` rows, and reads about `PURGE_READ_BYTES`, per call and
 *    reports `done: false` until nothing is left, so the caller loops.
 *  - `removeEntity` deletes one entity, its claims and what hangs off it
 *    (an organisation's card, edges, organiser links — and its key from those
 *    events' organiser lists — `orgInternal` and the `sources` rows it owns).
 *    Not routed over HTTP: run it with `bunx convex run ingest/purge:removeEntity`.
 *  - `removeSources` deletes the `sources` rows of one host (optionally of
 *    one listing): a fetch recorded under a policy since corrected (the
 *    army.mod.uk pages once read as a society's, 2026-10-09).
 *  - `rejectSourceClaims` sets aside (`reviewStatus: rejected`) every live
 *    claim one entity has from one host and re-resolves the entity: readings
 *    of a site the pipeline no longer reads as the organisation's own (the
 *    national CMF's cmf.org.uk for the Cambridge branch, review 2026-10-10),
 *    which no later run would ever supersede.
 *
 * Kept: `harvestRuns` (the run log is evidence), `inboundEmails` and
 * `listingRequests` (written by people, not the pipeline), and every
 * broker-owned row (`interactions`, `introductions`, `manual` people,
 * confirmed needs/offers and notes).
 */

/** The dev deployment (AGENTS.md). Production has a different name. */
export const DEV_DEPLOYMENT = "hushed-rhinoceros-215"

/** Rows deleted per call: under Convex's per-transaction write limit. */
export const PURGE_BUDGET = 4_000

/**
 * Bytes read per call, estimated from each row's JSON: well under Convex's
 * 16 MiB read limit per transaction. `fieldClaims` rows carry descriptions
 * (`value` and `valueRaw`, up to 20,000 characters each), so a row count alone
 * overran it once the claim log grew (2026-10-09).
 */
export const PURGE_READ_BYTES = 6_000_000

function approxBytes(row: unknown): number {
  return JSON.stringify(row).length
}

const PIPELINE_TABLES = [
  "fieldClaims",
  "eventOrganisers",
  "relationships",
  "orgCards",
  "organisations",
  "events",
  "teams",
  "sessions",
  "venues",
  "sources",
  "orgInternal",
  "termDates",
  "storedFiles",
] as const satisfies readonly TableNames[]

export function isDevDeployment(cloudUrl: string | undefined): boolean {
  return cloudUrl !== undefined && new RegExp(`^https://${DEV_DEPLOYMENT}\\.`).test(cloudUrl)
}

export const purge = internalMutation({
  args: { confirm: v.literal("PURGE-DEV") },
  returns: v.object({ deleted: v.record(v.string(), v.number()), done: v.boolean() }),
  handler: async (ctx) => {
    if (!isDevDeployment(process.env.CONVEX_CLOUD_URL)) {
      throw new Error(`Refusing to purge: this is not the dev deployment (${DEV_DEPLOYMENT})`)
    }
    let budget = PURGE_BUDGET
    let bytes = 0
    const full = () => budget <= 0 || bytes >= PURGE_READ_BYTES
    const deleted: Record<string, number> = {}

    for (const table of PIPELINE_TABLES) {
      if (full()) break
      let count = 0
      // Row by row, so the call stops before the read limit, not at a count.
      for await (const row of ctx.db.query(table)) {
        if (table === "storedFiles") {
          await ctx.storage.delete(
            (row as { storageId: Parameters<typeof ctx.storage.delete>[0] }).storageId,
          )
        }
        await ctx.db.delete(table, row._id as never)
        count++
        budget--
        bytes += approxBytes(row)
        if (full()) break
      }
      if (count > 0) deleted[table] = count
    }

    let more = full()
    if (!more) more = await purgeBrokerInferences(ctx, budget, deleted)
    return { deleted, done: !more }
  },
})

/**
 * Pipeline-owned broker rows: `parser`/`llm` people, and inferred needs/offers
 * (a profile with nothing broker-owned left is deleted). Returns whether a
 * full page was read, i.e. whether another call may find more.
 */
async function purgeBrokerInferences(
  ctx: MutationCtx,
  budget: number,
  deleted: Record<string, number>,
): Promise<boolean> {
  const limit = Math.max(1, Math.floor(budget / 2))
  let used = 0
  const people = await ctx.db.query("people").take(limit)
  for (const person of people) {
    if (person.method === "manual") continue
    await ctx.db.delete("people", person._id)
    used++
  }
  const profiles = await ctx.db.query("orgBrokerProfiles").take(limit)
  for (const profile of profiles) {
    const needs = profile.needs.filter((entry) => entry.status === "confirmed")
    const offers = profile.offers.filter((entry) => entry.status === "confirmed")
    if (needs.length === profile.needs.length && offers.length === profile.offers.length) continue
    const brokerOwned =
      needs.length > 0 ||
      offers.length > 0 ||
      profile.notes !== undefined ||
      profile.sponsorNotes !== undefined ||
      profile.ethicsFlags.length > 0 ||
      profile.suppressed ||
      Object.keys(profile.optIns).length > 0
    if (brokerOwned) await ctx.db.patch("orgBrokerProfiles", profile._id, { needs, offers })
    else await ctx.db.delete("orgBrokerProfiles", profile._id)
    used++
  }
  if (used > 0) deleted.brokerInferences = used
  // Broker-owned rows survive, so a full page means "maybe more", not "more".
  return used > 0 && (people.length === limit || profiles.length === limit)
}

export const removeEntity = internalMutation({
  args: { entityType: literalUnion(ENTITY_TYPES), key: v.string() },
  returns: v.object({ deleted: v.record(v.string(), v.number()) }),
  handler: async (ctx, args) => {
    const deleted: Record<string, number> = {}
    const count = (table: string) => {
      deleted[table] = (deleted[table] ?? 0) + 1
    }

    const entity = await findEntity(ctx, args.entityType, args.key)
    if (entity) {
      await ctx.db.delete(ENTITY_TABLES[args.entityType], entity._id as never)
      count(ENTITY_TABLES[args.entityType])
    }
    for (const field of Object.keys(FIELD_SPECS[args.entityType])) {
      const claims = await ctx.db
        .query("fieldClaims")
        .withIndex("by_entity_field", (q) =>
          q.eq("entityType", args.entityType).eq("entityKey", args.key).eq("field", field),
        )
        .take(2_000)
      for (const claim of claims) {
        await ctx.db.delete("fieldClaims", claim._id)
        count("fieldClaims")
      }
    }

    const affectedOrgs = new Set<string>()
    if (args.entityType === "organisation") {
      const card = await ctx.db
        .query("orgCards")
        .withIndex("by_key", (q) => q.eq("key", args.key))
        .unique()
      if (card) {
        await ctx.db.delete("orgCards", card._id)
        count("orgCards")
      }
      for (const index of ["by_from", "by_to"] as const) {
        const edges = await ctx.db
          .query("relationships")
          .withIndex(index, (q) => q.eq(index === "by_from" ? "fromKey" : "toKey", args.key))
          .take(1_000)
        for (const edge of edges) {
          await ctx.db.delete("relationships", edge._id)
          count("relationships")
        }
      }
      const links = await ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (q) => q.eq("orgKey", args.key))
        .take(2_000)
      for (const link of links) {
        await ctx.db.delete("eventOrganisers", link._id)
        count("eventOrganisers")
        // The event no longer names it among its organisers either.
        const event = await ctx.db
          .query("events")
          .withIndex("by_key", (q) => q.eq("key", link.eventKey))
          .unique()
        if (event) {
          const without = (keys: string[]) => keys.filter((key) => key !== args.key)
          await ctx.db.patch("events", event._id, {
            organiserKeys: without(event.organiserKeys),
            coHostKeys: without(event.coHostKeys),
            sponsorKeys: without(event.sponsorKeys),
            updatedAt: Date.now(),
          })
        }
      }
      const owned = await ctx.db
        .query("sources")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", args.key))
        .take(2_000)
      for (const row of owned) {
        await ctx.db.delete("sources", row._id)
        count("sources")
      }
      const internal = await ctx.db
        .query("orgInternal")
        .withIndex("by_orgKey", (q) => q.eq("orgKey", args.key))
        .unique()
      if (internal) {
        await ctx.db.delete("orgInternal", internal._id)
        count("orgInternal")
      }
    }
    if (args.entityType === "event") {
      const links = await ctx.db
        .query("eventOrganisers")
        .withIndex("by_event", (q) => q.eq("eventKey", args.key))
        .take(200)
      for (const link of links) {
        affectedOrgs.add(link.orgKey)
        await ctx.db.delete("eventOrganisers", link._id)
        count("eventOrganisers")
      }
    }

    const now = Date.now()
    const terms = await loadTerms(ctx)
    for (const orgKey of affectedOrgs) {
      const org = await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", orgKey))
        .unique()
      if (org) await refreshOrganisation(ctx, org, { now, terms })
    }
    return { deleted }
  },
})

export const removeSources = internalMutation({
  args: { host: v.string(), orgKey: v.optional(v.string()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sources")
      .withIndex("by_host", (q) => q.eq("host", args.host))
      .take(2_000)
    let deleted = 0
    for (const row of rows) {
      if (args.orgKey !== undefined && row.orgKey !== args.orgKey) continue
      await ctx.db.delete("sources", row._id)
      deleted++
    }
    return { deleted }
  },
})

export const rejectSourceClaims = internalMutation({
  args: { entityType: literalUnion(ENTITY_TYPES), key: v.string(), host: v.string() },
  returns: v.object({ rejected: v.number(), fields: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const host = args.host.toLowerCase().replace(/^www\./, "")
    const fields = new Set<string>()
    let rejected = 0
    for (const reviewStatus of ["accepted", "proposed"] as const) {
      const claims = await ctx.db
        .query("fieldClaims")
        .withIndex("by_entity_review", (q) =>
          q
            .eq("entityType", args.entityType)
            .eq("entityKey", args.key)
            .eq("reviewStatus", reviewStatus),
        )
        .take(4_000)
      for (const claim of claims) {
        if (hostOf(claim.sourceUrl) !== host) continue
        await ctx.db.patch("fieldClaims", claim._id, { reviewStatus: "rejected" })
        fields.add(claim.field)
        rejected++
      }
    }
    if (fields.size > 0) await reresolveEntity(ctx, args.entityType, args.key, [...fields])
    return { rejected, fields: [...fields].sort() }
  },
})
