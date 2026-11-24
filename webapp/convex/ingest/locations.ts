import { v } from "convex/values"
import {
  ITEM_LOCATION_KINDS,
  ITEM_LOCATION_METHODS,
  ITEM_LOCATION_PRECISIONS,
  type ItemLocationKind,
} from "../../lib/vocab"
import { internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server"
import { DAY_MS } from "../lib/derived"
import { MAX_SPANNING } from "../lib/eventWindow"
import { assertBatchSize, pageLimit, valuesEqual } from "../lib/ingest"
import {
  ITEM_KEY_PREFIXES,
  isVenueKey,
  itemLocationOf,
  LOCATION_LIMITS,
  locationCoverage,
  locationSummaryValidator,
  precisionNeedsVenue,
  venueCache,
} from "../lib/locations"
import { carriesSuppressedName, loadNameHashes, loadSuppressedEvents } from "../lib/suppressions"
import { literalUnion } from "../lib/validators"

/**
 * The pipeline's `locate` stage (docs/locations-and-map.md §1c, §2), behind
 * `POST /api/pipeline/locations/*` and `venues/all` (convex/http.ts):
 *
 *  - `pending` (`locations/pending`): the items to place in [from, to), a
 *    page at a time: events of every tier but `members_only` that are not
 *    cancelled, superseded or suppressed — those starting in the window,
 *    then the multi-day ones that started before it and are still running
 *    (as `map.day` shows them) — then listed, not cancelled talks; each with
 *    what the stage reads and its stored row's hash and start.
 *  - `venuesAll` (`venues/all`): every venue, a page at a time.
 *  - `batch` (`locations/batch`): rows upserted by (kind, itemKey), each
 *    written whole; ≤ 500 a call (`MAX_BATCH`).
 *  - `summary` (`locations/summary`): coverage of the next 14 days, for the
 *    monitor's `location_unresolved_share` shadow check.
 *  - `prune`: the daily cron (`locations-prune-daily`) deleting rows that
 *    started over 60 days ago or whose item is gone.
 *
 * Internal: these read past the public gate (a `cam_only` event needs a
 * place too); nothing here is reachable without `PIPELINE_API_KEY`.
 */

/** Items a pending page returns at most (each may read its talk's abstract). */
export const PENDING_PAGE = 100
/** Venues a `venues/all` page returns at most. */
export const VENUES_PAGE = 500
/** How much of a description or abstract the stage reads. */
export const PENDING_DESCRIPTION = 1_500
/** The widest pending window: the stage asks for now − 1 day … now + 120 days. */
export const MAX_PENDING_WINDOW_MS = 186 * DAY_MS
/** Rows kept after their item started (owner decision, §1b). */
export const LOCATION_RETENTION_MS = 60 * DAY_MS
/** Rows one prune call reads (the cron reschedules itself until done). */
export const PRUNE_PAGE = 200

const storedValidator = v.object({
  inputHash: v.string(),
  precision: literalUnion(ITEM_LOCATION_PRECISIONS),
  venueKey: v.optional(v.string()),
  /** The start the row was written with: a rescheduled item is placed again. */
  startsAt: v.number(),
})

export const pendingItemValidator = v.object({
  kind: literalUnion(ITEM_LOCATION_KINDS),
  itemKey: v.string(),
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  allDay: v.optional(v.boolean()),
  title: v.string(),
  /** ≤ 1,500 characters: an event's description, a talk's abstract. */
  description: v.optional(v.string()),
  /** Events: the (redacted) venue text. */
  venueText: v.optional(v.string()),
  /** Events: the source's own venue key. */
  venueKey: v.optional(v.string()),
  /** Talks: the venue as the source wrote it. */
  venue: v.optional(v.string()),
  /** Talks: whether the talk is online. */
  online: v.optional(v.boolean()),
  /** Organisation names (events), or the departments' names and the series (talks). */
  organisers: v.array(v.string()),
  /** An event's `source` (EVENT_SOURCES), a talk's `sourceType` (TALK_SOURCE_TYPES). */
  sourceType: v.string(),
  sourceUrl: v.optional(v.string()),
  /** The stored row, when there is one: skip the item while its hash is equal. */
  stored: v.optional(storedValidator),
})
export type PendingItem = typeof pendingItemValidator.type

/** A cursor over the reads in turn: events starting in the window, then the
 * multi-day events still running at its start (one bounded page), then talks. */
type PendingCursor = { phase: "events" | "spanning" | "talks"; cursor: string | null }

/** The tiers the stage places (every one but `members_only`). */
const PENDING_TIERS = ["public", "cam_only"] as const

function parseCursor(raw: string | null | undefined): PendingCursor {
  if (!raw) return { phase: "events", cursor: null }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCursor>
    if (parsed.phase === "events" || parsed.phase === "spanning" || parsed.phase === "talks") {
      return {
        phase: parsed.phase,
        cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      }
    }
  } catch {
    // fall through
  }
  throw new Error("Invalid cursor")
}

function stored(row: Doc<"itemLocations"> | null): PendingItem["stored"] {
  if (!row) return undefined
  return {
    inputHash: row.inputHash,
    precision: row.precision,
    ...(row.venueKey ? { venueKey: row.venueKey } : {}),
    startsAt: row.startsAt,
  }
}

function clip(text: string | undefined | null, limit: number): string | undefined {
  const trimmed = text?.trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

async function orgName(ctx: QueryCtx, key: string): Promise<string | null> {
  const org = await ctx.db
    .query("organisations")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  return org?.name ?? null
}

export const pending = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Epoch ms, inclusive. */
    from: v.number(),
    /** Epoch ms, exclusive; at most 186 days after `from`. */
    to: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    page: v.array(pendingItemValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!(args.to > args.from)) throw new Error("`to` must be after `from`")
    if (args.to - args.from > MAX_PENDING_WINDOW_MS) {
      throw new Error("The window is limited to 186 days")
    }
    const numItems = Math.min(PENDING_PAGE, pageLimit(args.limit, PENDING_PAGE))
    const at = parseCursor(args.cursor)
    const page: PendingItem[] = []

    const pushEvents = async (events: Doc<"events">[]) => {
      const suppressed = await loadSuppressedEvents(ctx)
      for (const event of events) {
        if (event.visibility === "members_only" || event.cancelled) continue
        if (event.supersededBy !== undefined || suppressed.has(event.key)) continue
        const organisers: string[] = []
        for (const key of [...event.organiserKeys, ...event.coHostKeys]) {
          const name = await orgName(ctx, key)
          if (name && !organisers.includes(name)) organisers.push(name)
        }
        page.push({
          kind: "event",
          itemKey: event.key,
          startsAt: event.startsAt,
          ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
          allDay: event.allDay,
          title: event.title,
          ...(clip(event.description, PENDING_DESCRIPTION)
            ? { description: clip(event.description, PENDING_DESCRIPTION) }
            : {}),
          ...(event.venueText ? { venueText: event.venueText } : {}),
          ...(event.venueKey ? { venueKey: event.venueKey } : {}),
          organisers,
          sourceType: event.source,
          sourceUrl: event.sourceUrl,
          stored: stored(await itemLocationOf(ctx, "event", event.key)),
        })
      }
    }

    if (at.phase === "events") {
      const result = await ctx.db
        .query("events")
        .withIndex("by_startsAt", (q) => q.gte("startsAt", args.from).lt("startsAt", args.to))
        .paginate({ numItems, cursor: at.cursor })
      await pushEvents(result.page)
      const next: PendingCursor = result.isDone
        ? { phase: "spanning", cursor: null }
        : { phase: "events", cursor: result.continueCursor }
      return { page, continueCursor: JSON.stringify(next), isDone: false }
    }

    if (at.phase === "spanning") {
      // Multi-day events that started before the window and still run in it:
      // the starting range above has not seen them. Bounded like the
      // calendar's spanning read (`MAX_SPANNING` per tier).
      const running: Doc<"events">[] = []
      for (const tier of PENDING_TIERS) {
        const rows = await ctx.db
          .query("events")
          .withIndex("by_visibility_spanEndsAt", (q) =>
            q.eq("visibility", tier).gt("spanEndsAt", args.from),
          )
          .take(MAX_SPANNING)
        running.push(...rows.filter((event) => event.startsAt < args.from))
      }
      await pushEvents(running)
      const next: PendingCursor = { phase: "talks", cursor: null }
      return { page, continueCursor: JSON.stringify(next), isDone: false }
    }

    const result = await ctx.db
      .query("talks")
      .withIndex("by_listing_startsAt", (q) =>
        q.eq("listing", "listed").gte("startsAt", args.from).lt("startsAt", args.to),
      )
      .paginate({ numItems, cursor: at.cursor })
    for (const talk of result.page) {
      if (talk.cancelled) continue
      const organisers: string[] = []
      for (const key of talk.departmentKeys) {
        const department = await ctx.db
          .query("departments")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (department && !organisers.includes(department.name)) organisers.push(department.name)
      }
      if (talk.series && !organisers.includes(talk.series)) organisers.push(talk.series)
      const details = await ctx.db
        .query("talkDetails")
        .withIndex("by_talkKey", (q) => q.eq("talkKey", talk.key))
        .unique()
      const abstract = clip(details?.abstract, PENDING_DESCRIPTION)
      page.push({
        kind: "talk",
        itemKey: talk.key,
        startsAt: talk.startsAt,
        ...(talk.endsAt !== null ? { endsAt: talk.endsAt } : {}),
        allDay: talk.allDay,
        title: talk.title,
        ...(abstract ? { description: abstract } : {}),
        ...(talk.venue ? { venue: talk.venue } : {}),
        online: talk.online,
        organisers,
        sourceType: talk.sourceType,
        sourceUrl: talk.url,
        stored: stored(await itemLocationOf(ctx, "talk", talk.key)),
      })
    }
    const next: PendingCursor = { phase: "talks", cursor: result.continueCursor }
    return { page, continueCursor: JSON.stringify(next), isDone: result.isDone }
  },
})

export const venueRowValidator = v.object({
  key: v.string(),
  name: v.string(),
  aliases: v.array(v.string()),
  address: v.optional(v.string()),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
  collegeKey: v.optional(v.string()),
  googlePlaceId: v.optional(v.string()),
})

export const venuesAll = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())), limit: v.optional(v.number()) },
  returns: v.object({
    page: v.array(venueRowValidator),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("venues")
      .withIndex("by_key")
      .paginate({
        numItems: Math.min(VENUES_PAGE, pageLimit(args.limit, VENUES_PAGE)),
        cursor: args.cursor ?? null,
      })
    return {
      page: result.page.map((venue) => ({
        key: venue.key,
        name: venue.name,
        aliases: venue.aliases,
        ...(venue.address !== undefined ? { address: venue.address } : {}),
        ...(venue.lat !== undefined ? { lat: venue.lat } : {}),
        ...(venue.lng !== undefined ? { lng: venue.lng } : {}),
        ...(venue.collegeKey !== undefined ? { collegeKey: venue.collegeKey } : {}),
        ...(venue.googlePlaceId !== undefined ? { googlePlaceId: venue.googlePlaceId } : {}),
      })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    }
  },
})

export const itemLocationInputValidator = v.object({
  kind: literalUnion(ITEM_LOCATION_KINDS),
  itemKey: v.string(),
  startsAt: v.number(),
  precision: literalUnion(ITEM_LOCATION_PRECISIONS),
  venueKey: v.optional(v.string()),
  room: v.optional(v.string()),
  areaLabel: v.optional(v.string()),
  note: v.optional(v.string()),
  method: literalUnion(ITEM_LOCATION_METHODS),
  model: v.optional(v.string()),
  promptVersion: v.optional(v.string()),
  inputHash: v.string(),
})
export type ItemLocationInput = typeof itemLocationInputValidator.type

const INPUT_HASH = /^[A-Za-z0-9:_-]+$/

/** What is wrong with a row before any read, or null. */
export function checkLocationInput(input: ItemLocationInput): string | null {
  const prefix = ITEM_KEY_PREFIXES[input.kind]
  if (
    !input.itemKey.startsWith(prefix) ||
    input.itemKey.length > LOCATION_LIMITS.itemKey ||
    !/^[a-z0-9-]+$/.test(input.itemKey)
  ) {
    return `itemKey: not a ${input.kind} key`
  }
  if (!Number.isFinite(input.startsAt)) return "startsAt: not a number"
  if (
    !input.inputHash ||
    input.inputHash.length > LOCATION_LIMITS.inputHash ||
    !INPUT_HASH.test(input.inputHash)
  ) {
    return "inputHash: must be 1..128 characters of [A-Za-z0-9:_-]"
  }
  if (precisionNeedsVenue(input.precision)) {
    if (!input.venueKey) return `venueKey: required for precision ${input.precision}`
    if (!isVenueKey(input.venueKey)) return "venueKey: not a venue key"
  } else if (input.venueKey !== undefined) {
    return `venueKey: not allowed for precision ${input.precision}`
  }
  if (input.precision === "area" && !input.areaLabel) {
    return "areaLabel: required for precision area"
  }
  const texts = [
    ["room", input.room],
    ["areaLabel", input.areaLabel],
    ["note", input.note],
    ["model", input.model],
    ["promptVersion", input.promptVersion],
  ] as const
  for (const [field, value] of texts) {
    if (value === undefined) continue
    const limit = LOCATION_LIMITS[field]
    if (value.trim().length === 0 || value.length > limit || /[\r\n]/.test(value)) {
      return `${field}: must be one line of 1..${limit} characters`
    }
  }
  return null
}

async function itemExists(ctx: QueryCtx, kind: ItemLocationKind, key: string): Promise<boolean> {
  if (kind === "event") {
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique()
    return event !== null
  }
  const talk = await ctx.db
    .query("talks")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  return talk !== null
}

/** The fields of a stored row, as written (no system fields, no `resolvedAt`). */
function contentOf(input: ItemLocationInput): Omit<Doc<"itemLocations">, "_id" | "_creationTime"> {
  const row: Record<string, unknown> = {
    kind: input.kind,
    itemKey: input.itemKey,
    startsAt: input.startsAt,
    precision: input.precision,
    method: input.method,
    inputHash: input.inputHash,
    resolvedAt: 0,
  }
  for (const field of [
    "venueKey",
    "room",
    "areaLabel",
    "note",
    "model",
    "promptVersion",
  ] as const) {
    const value = input[field]
    if (value !== undefined) row[field] = field === "venueKey" ? value : value.trim()
  }
  return row as Omit<Doc<"itemLocations">, "_id" | "_creationTime">
}

function sameRow(
  existing: Doc<"itemLocations">,
  next: Omit<Doc<"itemLocations">, "_id" | "_creationTime">,
): boolean {
  const { _id, _creationTime, resolvedAt: _a, ...left } = existing
  const { resolvedAt: _b, ...right } = next
  return valuesEqual(left, right)
}

export const batch = internalMutation({
  args: { locations: v.array(itemLocationInputValidator) },
  returns: v.object({
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    rejected: v.array(v.object({ itemKey: v.string(), reason: v.string() })),
  }),
  handler: async (ctx, args) => {
    assertBatchSize(args.locations.length, "locations")
    const now = Date.now()
    const venues = venueCache(ctx)
    const [suppressed, names] = await Promise.all([loadSuppressedEvents(ctx), loadNameHashes(ctx)])
    const out = {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      rejected: [] as { itemKey: string; reason: string }[],
    }
    const seen = new Set<string>()
    for (const input of args.locations) {
      const reject = (reason: string) => out.rejected.push({ itemKey: input.itemKey, reason })
      const problem = checkLocationInput(input)
      if (problem) {
        reject(problem)
        continue
      }
      const id = `${input.kind}:${input.itemKey}`
      if (seen.has(id)) {
        reject("duplicate item in this batch")
        continue
      }
      seen.add(id)
      if (input.kind === "event" && suppressed.has(input.itemKey)) {
        reject("suppressed event")
        continue
      }
      if (carriesSuppressedName([input.room, input.areaLabel, input.note], names)) {
        reject("names a suppressed person")
        continue
      }
      if (input.venueKey && !(await venues(input.venueKey))) {
        reject(`venueKey: venue ${input.venueKey} does not exist`)
        continue
      }
      if (!(await itemExists(ctx, input.kind, input.itemKey))) {
        reject(`no ${input.kind} with this key`)
        continue
      }
      const next = contentOf(input)
      const existing = await itemLocationOf(ctx, input.kind, input.itemKey)
      if (existing && sameRow(existing, next)) {
        out.unchanged++
        continue
      }
      const row = { ...next, resolvedAt: now }
      if (existing) {
        await ctx.db.replace(existing._id, row)
        out.updated++
      } else {
        await ctx.db.insert("itemLocations", row)
        out.inserted++
      }
    }
    return out
  },
})

export const summary = internalQuery({
  args: {},
  returns: locationSummaryValidator,
  handler: async (ctx) => (await locationCoverage(ctx, Date.now())).summary,
})

/**
 * The daily prune (convex/crons.ts `locations-prune-daily`): a page of rows by
 * start, oldest first; a row that started over 60 days ago, or whose event or
 * talk no longer exists, is deleted. Reschedules itself with its cursor until
 * the table is walked.
 */
export const prune = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - LOCATION_RETENTION_MS
    const result = await ctx.db
      .query("itemLocations")
      .withIndex("by_startsAt")
      .paginate({ numItems: PRUNE_PAGE, cursor: args.cursor ?? null })
    let deleted = 0
    for (const row of result.page) {
      if (row.startsAt < cutoff || !(await itemExists(ctx, row.kind, row.itemKey))) {
        await ctx.db.delete(row._id)
        deleted++
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.locations.prune, {
        cursor: result.continueCursor,
      })
    }
    return { deleted, isDone: result.isDone }
  },
})
