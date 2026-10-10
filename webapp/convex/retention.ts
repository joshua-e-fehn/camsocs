import { v } from "convex/values"
import { REVIEW_STATUSES } from "../lib/vocab"
import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalMutation, type MutationCtx } from "./_generated/server"
import { DAY_MS, londonIsoDate } from "./lib/derived"
import { loadTerms, refreshOrganisation } from "./lib/entityStore"

/**
 * The retention schedule, enforced (docs/compliance/retention.md; the
 * privacy notice states the same periods). `daily` (convex/crons.ts) starts
 * one walk per rule; each walk reads a page of what has expired, deletes it,
 * and reschedules itself with the cursor until the range is done — so no
 * transaction reads or writes more than a page, and every walk of one day
 * uses the same `now`.
 *
 *  - R3 `purgeEvents`: events (with their claims and organiser links) a year
 *    after they ended, and their stored images once nothing else shows them;
 *    their organisers are re-derived.
 *  - R4 `stripMailBodies`: the body (text, stored HTML, attachments) of a
 *    processed mailing-list mail 30 days after receipt; `purgeMail` the whole
 *    row 90 days after receipt, processed or not.
 *  - R5 `expirePeople`: once `staleAfter` (the handover) has passed, the
 *    broker's own rows are archived (out of the active lists) for a 30-day
 *    grace in which the broker may extend `staleAfter`; 30 days after it,
 *    every person row is deleted — from public sources or the broker's own —
 *    and its key is remembered (`expiredPeople`: key and academic year only)
 *    so a page that still lists last year's committee does not add it back.
 *    Rows held on consent stay.
 *  - R6 `purgeInteractions`: interactions three years old whose organisation
 *    has had none since, and introductions three years old.
 *  - R8 `purgeRequests`: rejected listing requests 90 days after they were
 *    rejected, the rest two years after resolution. Open requests stay until
 *    handled. Suppressions are never deleted.
 *  - R10 `purgeRuns`: run-log rows a year old.
 *
 * Not automated (retention.md says why): R1 listings and R2 their provenance
 * (an organisation is deleted only by hand, `ingest/purge:removeEntity`), R7
 * the pipeline host's cache (`camsocs prune-cache`), R9 sign-in accounts.
 */

export const RETENTION = {
  /** R3: an event is kept this long after it ended. */
  eventDays: 365,
  /** R4: a processed mail's body is kept this long after receipt. */
  mailBodyDays: 30,
  /** R4: a mail row is kept this long after receipt. */
  mailDays: 90,
  /** R5: a person is kept this long past `staleAfter`. */
  peopleGraceDays: 30,
  /** R6: interactions / introductions. */
  interactionDays: 3 * 365,
  /** R8: a rejected request. */
  rejectedRequestDays: 90,
  /** R8: any other resolved request. */
  requestDays: 2 * 365,
  /** R10: the run log. */
  runDays: 365,
} as const

/** Rows per page. Events delete their claims too, so their pages are small. */
const PAGE = { events: 25, mail: 100, people: 200, rows: 300 } as const

const walkArgs = {
  /** The clock of this day's walk (tests pin it). */
  now: v.optional(v.number()),
  cursor: v.optional(v.union(v.string(), v.null())),
}
const walkResult = v.object({ processed: v.number(), deleted: v.number(), done: v.boolean() })
type WalkResult = { processed: number; deleted: number; done: boolean }

const daysAgo = (now: number, days: number) => now - days * DAY_MS

// --- R3: events ------------------------------------------------------------------------

export const purgeEvents = internalMutation({
  args: walkArgs,
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const cutoff = daysAgo(now, RETENTION.eventDays)
    const page = await ctx.db
      .query("events")
      .withIndex("by_startsAt", (q) => q.lt("startsAt", cutoff))
      .paginate({ numItems: PAGE.events, cursor: args.cursor ?? null })
    let deleted = 0
    let budget = CLAIMS_PER_CALL
    let unfinished = false
    const organisers = new Set<string>()
    for (const event of page.page) {
      // Multi-day runs count from their end.
      if ((event.spanEndsAt ?? event.endsAt ?? event.startsAt) >= cutoff) continue
      const result = await deleteEvent(ctx, event, budget)
      for (const orgKey of result.organisers) organisers.add(orgKey)
      budget -= result.claims
      if (!result.finished) {
        // More claims than this call may delete: the event stays until a
        // later call has deleted them all (R3: claims go with the event).
        unfinished = true
        break
      }
      deleted++
    }
    if (organisers.size > 0) {
      const terms = await loadTerms(ctx)
      for (const orgKey of organisers) {
        const org = await ctx.db
          .query("organisations")
          .withIndex("by_key", (q) => q.eq("key", orgKey))
          .unique()
        if (org) await refreshOrganisation(ctx, org, { now, terms })
      }
    }
    if (unfinished || !page.isDone) {
      // An unfinished event is read again from the same cursor.
      await ctx.scheduler.runAfter(0, internal.retention.purgeEvents, {
        now,
        cursor: unfinished ? (args.cursor ?? null) : page.continueCursor,
      })
    }
    return { processed: page.page.length, deleted, done: page.isDone && !unfinished }
  },
})

/** Claims one purge call deletes at most (under a mutation's write limits). */
export const CLAIMS_PER_CALL = 2_000

/** Deletes an event's claims (at most `budget`), and once none is left its
 * organiser links, the event and (when nothing else shows it) its stored
 * image. `finished`: the event is gone. */
async function deleteEvent(
  ctx: MutationCtx,
  event: Doc<"events">,
  budget: number,
): Promise<{ organisers: string[]; claims: number; finished: boolean }> {
  let claims = 0
  for (const reviewStatus of REVIEW_STATUSES) {
    const remaining = budget - claims
    const page = await ctx.db
      .query("fieldClaims")
      .withIndex("by_entity_review", (q) =>
        q.eq("entityType", "event").eq("entityKey", event.key).eq("reviewStatus", reviewStatus),
      )
      .take(remaining + 1)
    for (const claim of page.slice(0, remaining)) await ctx.db.delete("fieldClaims", claim._id)
    claims += Math.min(page.length, remaining)
    if (page.length > remaining) return { organisers: [], claims, finished: false }
  }
  const links = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_event", (q) => q.eq("eventKey", event.key))
    .take(200)
  for (const link of links) await ctx.db.delete("eventOrganisers", link._id)
  await ctx.db.delete("events", event._id)
  if (event.image?.storageId) await deleteFileIfUnused(ctx, event.image.storageId)
  return { organisers: links.map((link) => link.orgKey), claims, finished: true }
}

/** Deletes a stored file (and its `storedFiles` row, so the files route never
 * hands out a dead id) unless an event or a logo still shows it. */
async function deleteFileIfUnused(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_imageStorageId", (q) => q.eq("image.storageId", storageId))
    .first()
  if (event) return
  const logo = await ctx.db
    .query("organisations")
    .withIndex("by_logoStorageId", (q) => q.eq("logo.storageId", storageId))
    .first()
  if (logo) return
  const rows = await ctx.db
    .query("storedFiles")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .take(10)
  for (const row of rows) await ctx.db.delete("storedFiles", row._id)
  if (await ctx.db.system.get("_storage", storageId)) await ctx.storage.delete(storageId)
}

// --- R4: mailing-list mail ----------------------------------------------------------------

async function deleteMailFiles(ctx: MutationCtx, mail: Doc<"inboundEmails">): Promise<void> {
  const ids = [
    ...(mail.htmlStorageId ? [mail.htmlStorageId] : []),
    ...mail.attachments.map((file) => file.storageId),
  ]
  for (const id of ids) {
    if (await ctx.db.system.get("_storage", id)) await ctx.storage.delete(id)
  }
}

const PROCESSED = ["done", "skipped", "failed"] as const

export const stripMailBodies = internalMutation({
  args: { ...walkArgs, status: v.optional(v.number()) },
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const cutoff = daysAgo(now, RETENTION.mailBodyDays)
    const statusIndex = args.status ?? 0
    const extraction = PROCESSED[statusIndex]
    const page = await ctx.db
      .query("inboundEmails")
      .withIndex("by_extraction_receivedAt", (q) =>
        q.eq("extraction", extraction).lt("receivedAt", cutoff),
      )
      .paginate({ numItems: PAGE.mail, cursor: args.cursor ?? null })
    let deleted = 0
    for (const mail of page.page) {
      if (mail.bodyDeletedAt !== undefined) continue
      await deleteMailFiles(ctx, mail)
      await ctx.db.patch("inboundEmails", mail._id, {
        text: "",
        htmlStorageId: undefined,
        attachments: [],
        bodyDeletedAt: now,
        updatedAt: now,
      })
      deleted++
    }
    const next = page.isDone
      ? statusIndex + 1 < PROCESSED.length
        ? { now, cursor: null, status: statusIndex + 1 }
        : null
      : { now, cursor: page.continueCursor, status: statusIndex }
    if (next) await ctx.scheduler.runAfter(0, internal.retention.stripMailBodies, next)
    return { processed: page.page.length, deleted, done: next === null }
  },
})

const ALL_EXTRACTIONS = ["pending", ...PROCESSED] as const

export const purgeMail = internalMutation({
  args: { ...walkArgs, status: v.optional(v.number()) },
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const cutoff = daysAgo(now, RETENTION.mailDays)
    const statusIndex = args.status ?? 0
    const extraction = ALL_EXTRACTIONS[statusIndex]
    const page = await ctx.db
      .query("inboundEmails")
      .withIndex("by_extraction_receivedAt", (q) =>
        q.eq("extraction", extraction).lt("receivedAt", cutoff),
      )
      .paginate({ numItems: PAGE.mail, cursor: args.cursor ?? null })
    for (const mail of page.page) {
      await deleteMailFiles(ctx, mail)
      await ctx.db.delete("inboundEmails", mail._id)
    }
    const next = page.isDone
      ? statusIndex + 1 < ALL_EXTRACTIONS.length
        ? { now, cursor: null, status: statusIndex + 1 }
        : null
      : { now, cursor: page.continueCursor, status: statusIndex }
    if (next) await ctx.scheduler.runAfter(0, internal.retention.purgeMail, next)
    return { processed: page.page.length, deleted: page.page.length, done: next === null }
  },
})

// --- R5: people --------------------------------------------------------------------------

export const expirePeople = internalMutation({
  args: { ...walkArgs, stale: v.optional(v.boolean()) },
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const today = londonIsoDate(now)
    const cutoffDate = londonIsoDate(daysAgo(now, RETENTION.peopleGraceDays))
    // Both flag values: the daily flag may not have caught up with the date.
    const stale = args.stale ?? true
    const page = await ctx.db
      .query("people")
      .withIndex("by_stale_staleAfter", (q) => q.eq("stale", stale).lt("staleAfter", today))
      .paginate({ numItems: PAGE.people, cursor: args.cursor ?? null })
    let deleted = 0
    for (const person of page.page) {
      if (person.consentBasis === "consent") continue
      if (person.staleAfter < cutoffDate) {
        await ctx.db.delete("people", person._id)
        deleted++
        // So the next load does not add them back from a page that still
        // lists last year's committee (ingest/broker.ts): the key only.
        const known = await ctx.db
          .query("expiredPeople")
          .withIndex("by_key", (q) => q.eq("key", person.key))
          .unique()
        if (!known) {
          await ctx.db.insert("expiredPeople", {
            key: person.key,
            academicYear: person.academicYear,
            deletedAt: now,
          })
        }
      } else if (person.method === "manual" && !person.archived) {
        await ctx.db.patch("people", person._id, { archived: true, updatedAt: now })
      }
    }
    const next = page.isDone
      ? stale
        ? { now, cursor: null, stale: false }
        : null
      : { now, cursor: page.continueCursor, stale }
    if (next) await ctx.scheduler.runAfter(0, internal.retention.expirePeople, next)
    return { processed: page.page.length, deleted, done: next === null }
  },
})

// --- R6: interactions and introductions ---------------------------------------------------

export const purgeInteractions = internalMutation({
  args: walkArgs,
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const cutoff = daysAgo(now, RETENTION.interactionDays)
    const page = await ctx.db
      .query("interactions")
      .withIndex("by_date", (q) => q.lt("date", cutoff))
      .paginate({ numItems: PAGE.rows, cursor: args.cursor ?? null })
    let deleted = 0
    for (const row of page.page) {
      const orgKey = row.orgKey
      if (orgKey) {
        // Kept while the organisation has a newer interaction.
        const latest = await ctx.db
          .query("interactions")
          .withIndex("by_orgKey_date", (q) => q.eq("orgKey", orgKey))
          .order("desc")
          .first()
        if (latest && latest.date >= cutoff) continue
      }
      await ctx.db.delete("interactions", row._id)
      deleted++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeInteractions, {
        now,
        cursor: page.continueCursor,
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.retention.purgeIntroductions, { now })
    }
    return { processed: page.page.length, deleted, done: page.isDone }
  },
})

export const purgeIntroductions = internalMutation({
  args: walkArgs,
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const page = await ctx.db
      .query("introductions")
      .withIndex("by_date", (q) => q.lt("date", daysAgo(now, RETENTION.interactionDays)))
      .paginate({ numItems: PAGE.rows, cursor: args.cursor ?? null })
    for (const row of page.page) await ctx.db.delete("introductions", row._id)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeIntroductions, {
        now,
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, deleted: page.page.length, done: page.isDone }
  },
})

// --- R8: listing requests ----------------------------------------------------------------

const RESOLVED = ["rejected", "accepted", "done"] as const

export const purgeRequests = internalMutation({
  args: { ...walkArgs, status: v.optional(v.number()) },
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const statusIndex = args.status ?? 0
    const status = RESOLVED[statusIndex]
    const cutoff = daysAgo(
      now,
      status === "rejected" ? RETENTION.rejectedRequestDays : RETENTION.requestDays,
    )
    // Resolution follows creation, so everything due was also created before
    // the cutoff.
    const page = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) => q.eq("status", status).lt("createdAt", cutoff))
      .paginate({ numItems: PAGE.rows, cursor: args.cursor ?? null })
    let deleted = 0
    for (const row of page.page) {
      if ((row.resolvedAt ?? row.createdAt) >= cutoff) continue
      await ctx.db.delete("listingRequests", row._id)
      deleted++
    }
    const next = page.isDone
      ? statusIndex + 1 < RESOLVED.length
        ? { now, cursor: null, status: statusIndex + 1 }
        : null
      : { now, cursor: page.continueCursor, status: statusIndex }
    if (next) await ctx.scheduler.runAfter(0, internal.retention.purgeRequests, next)
    return { processed: page.page.length, deleted, done: next === null }
  },
})

// --- R10: the run log ------------------------------------------------------------------

export const purgeRuns = internalMutation({
  args: walkArgs,
  returns: walkResult,
  handler: async (ctx, args): Promise<WalkResult> => {
    const now = args.now ?? Date.now()
    const page = await ctx.db
      .query("harvestRuns")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", daysAgo(now, RETENTION.runDays)))
      .paginate({ numItems: PAGE.rows, cursor: args.cursor ?? null })
    for (const row of page.page) await ctx.db.delete("harvestRuns", row._id)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeRuns, {
        now,
        cursor: page.continueCursor,
      })
    }
    return { processed: page.page.length, deleted: page.page.length, done: page.isDone }
  },
})

/** The daily cron's entry point: starts every walk with one clock. */
export const daily = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    await ctx.scheduler.runAfter(0, internal.retention.purgeEvents, { now })
    await ctx.scheduler.runAfter(0, internal.retention.stripMailBodies, { now })
    await ctx.scheduler.runAfter(0, internal.retention.purgeMail, { now })
    await ctx.scheduler.runAfter(0, internal.retention.expirePeople, { now })
    await ctx.scheduler.runAfter(0, internal.retention.purgeInteractions, { now })
    await ctx.scheduler.runAfter(0, internal.retention.purgeRequests, { now })
    await ctx.scheduler.runAfter(0, internal.retention.purgeRuns, { now })
    return null
  },
})
