import type { EntityType } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { TermDates } from "./derived"
import { sameFields } from "./ingest"
import { type DeriveContext, materialise } from "./materialise"
import type { FieldMeta } from "./resolve"

/**
 * Reading and writing the keyed entity tables. Shared by the claims ingestion
 * (convex/ingest/claims.ts) and derivation (convex/derive.ts), so "how an
 * organisation's derived fields and directory card are refreshed" exists once.
 */

export const ENTITY_TABLES = {
  organisation: "organisations",
  event: "events",
  team: "teams",
  session: "sessions",
  venue: "venues",
} as const satisfies Record<EntityType, string>

export type EntityTable = (typeof ENTITY_TABLES)[EntityType]
export type EntityDoc = Doc<EntityTable>

export async function findEntity(
  ctx: QueryCtx,
  entityType: EntityType,
  key: string,
): Promise<EntityDoc | null> {
  const table = ENTITY_TABLES[entityType]
  return (await ctx.db
    .query(table)
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()) as EntityDoc | null
}

export async function findOrganisation(
  ctx: QueryCtx,
  key: string,
): Promise<Doc<"organisations"> | null> {
  return await ctx.db
    .query("organisations")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

/** Every term's Full Term dates (a handful of rows). */
export async function loadTerms(ctx: QueryCtx): Promise<TermDates[]> {
  const rows = await ctx.db.query("termDates").take(100)
  return rows.map(({ academicYear, term, fullTermStart, fullTermEnd }) => ({
    academicYear,
    term,
    fullTermStart,
    fullTermEnd,
  }))
}

/** Start of the latest event before `now` that `orgKey` organised or co-hosted. */
export async function latestPastEventAt(
  ctx: QueryCtx,
  orgKey: string,
  now: number,
): Promise<number | undefined> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_org_startsAt", (q) => q.eq("orgKey", orgKey).lte("startsAt", now))
    .order("desc")
    .take(5)
  return rows.find((row) => row.role !== "sponsor")?.startsAt
}

/** The public directory card of an organisation (schema.ts `orgCardFields`). */
export function orgCardOf(
  org: Doc<"organisations">,
): Omit<Doc<"orgCards">, "_id" | "_creationTime"> {
  return {
    key: org.key,
    slug: org.slug,
    name: org.name,
    nameSort: org.name.trim().toLowerCase(),
    shortName: org.shortName,
    shortDescription: org.shortDescription,
    orgType: org.orgType,
    level: org.level,
    status: org.status,
    isCounterpart: org.isCounterpart,
    collegeKeys: org.collegeKeys,
    categories: org.categories,
    activityTypes: org.activityTypes,
    audiences: org.audiences,
    beginnerFriendly: org.beginnerFriendly,
    sport: org.sport
      ? {
          sport: org.sport.sport,
          blueStatus: org.sport.blueStatus,
          genderCategories: org.sport.genderCategories,
        }
      : undefined,
    logoStorageId: org.logo?.storageId,
    searchText: org.searchText,
    updatedAt: org.updatedAt,
  }
}

/** Inserts or patches the card for `org`; writes nothing when it is current. */
export async function writeOrgCard(ctx: MutationCtx, org: Doc<"organisations">): Promise<void> {
  const card = orgCardOf(org)
  const existing = await ctx.db
    .query("orgCards")
    .withIndex("by_key", (q) => q.eq("key", org.key))
    .unique()
  if (!existing) {
    await ctx.db.insert("orgCards", card)
    return
  }
  const { updatedAt: _ignored, ...comparable } = card
  if (sameFields(existing, comparable)) return
  await ctx.db.patch("orgCards", existing._id, card)
}

/**
 * Re-derives an organisation without re-resolving any field — for when only
 * the clock or its events changed. Returns whether the row changed.
 */
export async function refreshOrganisation(
  ctx: MutationCtx,
  org: Doc<"organisations">,
  context: Omit<DeriveContext, "latestEventAt">,
): Promise<boolean> {
  const latestEventAt = await latestPastEventAt(ctx, org.key, context.now)
  const row = materialise("organisation", org.key, org, {}, { ...context, latestEventAt })
  if (sameFields(org, row)) {
    await writeOrgCard(ctx, org)
    return false
  }
  await ctx.db.patch("organisations", org._id, { ...row, updatedAt: context.now } as Partial<
    Doc<"organisations">
  >)
  const updated = await ctx.db.get("organisations", org._id)
  if (updated) await writeOrgCard(ctx, updated)
  return true
}

/** Keeps the event's denormalised copies on `eventOrganisers` in step. */
export async function syncEventOrganiserRows(
  ctx: MutationCtx,
  event: Pick<Doc<"events">, "key" | "startsAt" | "visibility">,
): Promise<string[]> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_event", (q) => q.eq("eventKey", event.key))
    .take(200)
  for (const row of rows) {
    if (row.startsAt !== event.startsAt || row.visibility !== event.visibility) {
      await ctx.db.patch("eventOrganisers", row._id, {
        startsAt: event.startsAt,
        visibility: event.visibility,
      })
    }
  }
  return rows.map((row) => row.orgKey)
}

export type MetaMap = Record<string, FieldMeta>
