import type { EntityType } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { isWithdrawn, type TermDates } from "./derived"
import { sameFields } from "./ingest"
import { type DeriveContext, type LatestEvent, materialise } from "./materialise"
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

/**
 * How far back `latestPastEvent` looks through an organisation's event rows.
 * The rows carry what it filters on, so this is a cap on small index rows,
 * not on event reads: a calendar importing a CTF a day (the Cyber Security
 * Society's, 445 of 458 entries) never hides the society's own events.
 */
export const LATEST_EVENT_SCAN = 2_000

/**
 * The latest *public* event before `now` that `orgKey` organised or
 * co-hosted: its start and the provenance of that start. Feeds the public
 * `lastActiveAt` and `status`, so a `cam_only` or `members_only` event — or a
 * sponsorship — never moves them (nor reveals when such an event happened),
 * and neither does someone else's event it only takes part in (`hosting:
 * takes_part`, decision D6: a CTF a feed imports says nothing of the society).
 */
export async function latestPastEvent(
  ctx: QueryCtx,
  orgKey: string,
  now: number,
): Promise<LatestEvent | undefined> {
  const rows = ctx.db
    .query("eventOrganisers")
    .withIndex("by_org_startsAt", (q) => q.eq("orgKey", orgKey).lte("startsAt", now))
    .order("desc")
  let scanned = 0
  for await (const row of rows) {
    if (++scanned > LATEST_EVENT_SCAN) break
    if (row.role === "sponsor" || row.visibility !== "public" || row.hosting === "takes_part") {
      continue
    }
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (q) => q.eq("key", row.eventKey))
      .unique()
    // A row from before the copy: the event says (the derivation fills it in).
    if (row.hosting === undefined && event?.hosting === "takes_part") continue
    return { startsAt: row.startsAt, meta: event?.meta.startsAt }
  }
  return undefined
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

/**
 * Inserts or patches the card for `org`; writes nothing when it is current.
 * A hidden organisation (`broker.orgs.setHidden`) has no card: every public
 * query lists, names and links organisations through the cards, so removing
 * it is what takes the listing off the site.
 */
export async function writeOrgCard(ctx: MutationCtx, org: Doc<"organisations">): Promise<void> {
  const existing = await ctx.db
    .query("orgCards")
    .withIndex("by_key", (q) => q.eq("key", org.key))
    .unique()
  if (org.hidden === true) {
    if (existing) await ctx.db.delete("orgCards", existing._id)
    return
  }
  const card = orgCardOf(org)
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
  context: Omit<DeriveContext, "latestEvent">,
): Promise<boolean> {
  const latestEvent = await latestPastEvent(ctx, org.key, context.now)
  const row = materialise("organisation", org.key, org, {}, { ...context, latestEvent })
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

/** The fields `eventOrganisers` rows copy from their event. */
export type EventOrganiserCopy = Pick<
  Doc<"events">,
  "startsAt" | "spanEndsAt" | "visibility" | "hosting"
>

export function eventOrganiserCopy(event: EventOrganiserCopy): EventOrganiserCopy {
  return {
    startsAt: event.startsAt,
    spanEndsAt: event.spanEndsAt,
    visibility: event.visibility,
    hosting: event.hosting ?? "hosts",
  }
}

/** Whether an event's copied fields changed between two versions; a row or
 * event without `hosting` hosts (every row from before decision D6). */
export function organiserCopyChanged(before: EventOrganiserCopy, after: EventOrganiserCopy) {
  return (
    before.startsAt !== after.startsAt ||
    before.spanEndsAt !== after.spanEndsAt ||
    before.visibility !== after.visibility ||
    (before.hosting ?? "hosts") !== (after.hosting ?? "hosts")
  )
}

/** Keeps the event's denormalised copies on `eventOrganisers` in step. */
export async function syncEventOrganiserRows(
  ctx: MutationCtx,
  event: Pick<Doc<"events">, "key"> & EventOrganiserCopy,
): Promise<string[]> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_event", (q) => q.eq("eventKey", event.key))
    .take(200)
  for (const row of rows) {
    if (organiserCopyChanged(row, event)) {
      await ctx.db.patch("eventOrganisers", row._id, eventOrganiserCopy(event))
    }
  }
  return rows.map((row) => row.orgKey)
}

/**
 * Whether an event was withdrawn by its listing (lib/derived.ts
 * `isWithdrawn`): its listing still being read, but no longer showing it.
 * Looks each listing's newest sighting up once per query.
 */
export function withdrawnCheck(ctx: QueryCtx, now: number) {
  const newest = new Map<string, Promise<number | undefined>>()
  return async (event: Doc<"events">): Promise<boolean> => {
    const group = event.sweepGroup
    if (group === undefined || event.startsAt < now) return false
    let found = newest.get(group)
    if (!found) {
      found = ctx.db
        .query("events")
        .withIndex("by_sweepGroup_lastSeenAt", (q) => q.eq("sweepGroup", group))
        .order("desc")
        .first()
        .then((row) => row?.lastSeenAt)
      newest.set(group, found)
    }
    return isWithdrawn(event, await found, now)
  }
}

export type MetaMap = Record<string, FieldMeta>
