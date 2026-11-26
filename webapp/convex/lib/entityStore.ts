import { isTalksDerivedEvent } from "../../lib/talks-boundary"
import type { EntityType } from "../../lib/vocab"
import type { Doc, Id } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { isWithdrawn, type TermDates } from "./derived"
import { sameContent, sameFields } from "./ingest"
import { type DeriveContext, type LatestEvent, materialise } from "./materialise"
import { runKeyOf } from "./orgActivity"
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
    if (
      row.role === "sponsor" ||
      row.visibility !== "public" ||
      row.hosting === "takes_part" ||
      row.superseded === true
    ) {
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

/** An event's list card (schema.ts `eventCardFields`, ENG-280). */
export type EventCard = Omit<Doc<"eventCards">, "_id" | "_creationTime">

/** The list card of an event: the event without `meta` and `description`,
 * with the talks boundary's verdict and the start's provenance taken from
 * them. Pure, so a read before the backfill builds the same card. */
export function eventCardOf(event: Doc<"events">): EventCard {
  const { _id, _creationTime, meta, description: _description, ...rest } = event
  const start = meta.startsAt
  return {
    ...rest,
    talksDerived: isTalksDerivedEvent(event),
    ...(start
      ? {
          startsAtMeta: {
            status: start.status,
            ...(start.method ? { method: start.method } : {}),
            ...(start.sourceType ? { sourceType: start.sourceType } : {}),
          },
        }
      : {}),
  }
}

async function eventCardByKey(ctx: QueryCtx, key: string): Promise<Doc<"eventCards"> | null> {
  return await ctx.db
    .query("eventCards")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
}

/**
 * Inserts or replaces the card of `event`; writes nothing when it is current.
 * Replaced, not patched, so a field the event lost (a cleared
 * `supersededBy`) leaves the card too. Every write to `events` ends here or
 * in `deleteEventCard`.
 */
export async function writeEventCard(ctx: MutationCtx, event: Doc<"events">): Promise<void> {
  const card = eventCardOf(event)
  const existing = await eventCardByKey(ctx, event.key)
  if (!existing) {
    await ctx.db.insert("eventCards", card)
    return
  }
  const { _id, _creationTime, ...stored } = existing
  if (sameFields(stored, card) && sameFields(card, stored)) return
  await ctx.db.replace("eventCards", _id, card)
}

/** Re-reads an event after a patch and brings its card in line. */
export async function refreshEventCard(ctx: MutationCtx, id: Id<"events">): Promise<void> {
  const event = await ctx.db.get("events", id)
  if (event) await writeEventCard(ctx, event)
}

/** Removes the card of a deleted event. */
export async function deleteEventCard(ctx: MutationCtx, key: string): Promise<void> {
  const existing = await eventCardByKey(ctx, key)
  if (existing) await ctx.db.delete("eventCards", existing._id)
}

/** The `projectionBackfills` row of the event cards. */
export const EVENT_CARDS_BACKFILL = "eventCards"

/**
 * Whether every event has a card: a full walk of `derive.recomputeEvents`
 * that began with the card writes in place has finished
 * (`markBackfilled`). Until then the window read takes full events and
 * builds the cards in memory (lib/eventWindow.ts), so no list is short.
 */
export async function eventCardsReady(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db
    .query("projectionBackfills")
    .withIndex("by_name", (q) => q.eq("name", EVENT_CARDS_BACKFILL))
    .unique()
  return row !== null
}

/** Records that a projection's backfill walk has finished (once). */
export async function markBackfilled(ctx: MutationCtx, name: string, now: number): Promise<void> {
  const row = await ctx.db
    .query("projectionBackfills")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique()
  if (!row) await ctx.db.insert("projectionBackfills", { name, completedAt: now })
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
  const updatedAt = sameContent(org, row) ? org.updatedAt : context.now
  await ctx.db.patch("organisations", org._id, { ...row, updatedAt } as Partial<
    Doc<"organisations">
  >)
  const updated = await ctx.db.get("organisations", org._id)
  if (updated) await writeOrgCard(ctx, updated)
  return true
}

/** What an `eventOrganisers` row copies from its event. */
export type EventOrganiserSource = Pick<
  Doc<"events">,
  "startsAt" | "spanEndsAt" | "visibility" | "hosting" | "title" | "cancelled" | "supersededBy"
>

/** The fields `eventOrganisers` rows hold copied from their event. */
export type EventOrganiserCopy = Pick<
  Doc<"eventOrganisers">,
  "startsAt" | "spanEndsAt" | "visibility" | "hosting" | "runKey" | "cancelled" | "superseded"
>

export function eventOrganiserCopy(event: EventOrganiserSource): EventOrganiserCopy {
  return {
    startsAt: event.startsAt,
    spanEndsAt: event.spanEndsAt,
    visibility: event.visibility,
    hosting: event.hosting ?? "hosts",
    runKey: runKeyOf(event.title),
    cancelled: event.cancelled,
    // Absent unless superseded, so no row of a live event changes (ENG-47).
    superseded: event.supersededBy !== undefined ? true : undefined,
  }
}

/** Whether a row's copy differs from `copy`; a row without `hosting` hosts
 * (every row from before decision D6), and one without `runKey` or
 * `cancelled` predates those copies (so it differs, and is filled in). */
function copyDiffers(row: EventOrganiserCopy, copy: EventOrganiserCopy): boolean {
  return (
    row.startsAt !== copy.startsAt ||
    row.spanEndsAt !== copy.spanEndsAt ||
    row.visibility !== copy.visibility ||
    (row.hosting ?? "hosts") !== (copy.hosting ?? "hosts") ||
    row.runKey !== copy.runKey ||
    row.cancelled !== copy.cancelled ||
    row.superseded !== copy.superseded
  )
}

/** Whether an event's copied fields changed between two versions. */
export function organiserCopyChanged(before: EventOrganiserSource, after: EventOrganiserSource) {
  return copyDiffers(eventOrganiserCopy(before), eventOrganiserCopy(after))
}

/** Keeps the event's denormalised copies on `eventOrganisers` in step. */
export async function syncEventOrganiserRows(
  ctx: MutationCtx,
  event: Pick<Doc<"events">, "key"> & EventOrganiserSource,
): Promise<string[]> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_event", (q) => q.eq("eventKey", event.key))
    .take(200)
  const copy = eventOrganiserCopy(event)
  for (const row of rows) {
    if (copyDiffers(row, copy)) await ctx.db.patch("eventOrganisers", row._id, copy)
  }
  return rows.map((row) => row.orgKey)
}

/**
 * Whether an event was withdrawn by its listing (lib/derived.ts
 * `isWithdrawn`): its listing still being read, but no longer showing it —
 * or superseded by another source's event (`supersededBy`, ENG-47), past or
 * future. Every public list and page asks this, so a superseded key leaves
 * them all at once. Looks each listing's newest sighting up once per query.
 */
export function withdrawnCheck(ctx: QueryCtx, now: number) {
  const newest = new Map<string, Promise<number | undefined>>()
  return async (
    event: Pick<Doc<"events">, "supersededBy" | "sweepGroup" | "startsAt" | "lastSeenAt">,
  ): Promise<boolean> => {
    if (event.supersededBy !== undefined) return true
    const group = event.sweepGroup
    if (group === undefined || event.startsAt < now) return false
    let found = newest.get(group)
    if (!found) {
      found = newestSighting(ctx, group)
      newest.set(group, found)
    }
    return isWithdrawn(event, await found, now)
  }
}

/** A sweep group's newest sighting: its `sweepGroupSightings` row (about
 * 0.1 KB), else its newest event (a full event, ~4 KB; a group the daily
 * derivation has not yet recorded). The row is never behind the events: every
 * write that advances an event's `lastSeenAt` raises it (`noteSweepSighting`). */
async function newestSighting(ctx: QueryCtx, group: string): Promise<number | undefined> {
  const row = await ctx.db
    .query("sweepGroupSightings")
    .withIndex("by_sweepGroup", (q) => q.eq("sweepGroup", group))
    .unique()
  if (row) return row.lastSeenAt
  const event = await ctx.db
    .query("events")
    .withIndex("by_sweepGroup_lastSeenAt", (q) => q.eq("sweepGroup", group))
    .order("desc")
    .first()
  return event?.lastSeenAt
}

/** Raises the event's sweep group's newest sighting to its `lastSeenAt`
 * (`newestSighting`); writes nothing when the row is already as new. A new
 * row starts from the group's newest event, so it is never behind one the
 * write did not touch. */
export async function noteSweepSighting(
  ctx: MutationCtx,
  event: Pick<Doc<"events">, "sweepGroup" | "lastSeenAt">,
): Promise<void> {
  const group = event.sweepGroup
  if (group === undefined) return
  const row = await ctx.db
    .query("sweepGroupSightings")
    .withIndex("by_sweepGroup", (q) => q.eq("sweepGroup", group))
    .unique()
  if (row) {
    if (event.lastSeenAt > row.lastSeenAt) {
      await ctx.db.patch("sweepGroupSightings", row._id, { lastSeenAt: event.lastSeenAt })
    }
    return
  }
  const newestEvent = await ctx.db
    .query("events")
    .withIndex("by_sweepGroup_lastSeenAt", (q) => q.eq("sweepGroup", group))
    .order("desc")
    .first()
  await ctx.db.insert("sweepGroupSightings", {
    sweepGroup: group,
    lastSeenAt: Math.max(event.lastSeenAt, newestEvent?.lastSeenAt ?? 0),
  })
}

export type MetaMap = Record<string, FieldMeta>
