import { v } from "convex/values"
import { addDays, DAY_MS, londonIsoDate, londonMidnight, startOfWeek } from "../../lib/calendar"
import {
  TALK_KINDS,
  TALK_LISTINGS,
  TALK_RUN_STATUSES,
  TALK_SCHOOLS,
  TALK_SOURCE_TYPES,
} from "../../lib/vocab"
import { internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { internalMutation, type MutationCtx } from "../_generated/server"
import { isHttpUrl, speakerValidator } from "../lib/fields"
import {
  assertBatchSize,
  emptyBatchResult,
  recordBatch,
  sameFields,
  upsertRow,
} from "../lib/ingest"
import { loadContactHashes, loadNameHashes } from "../lib/suppressions"
import {
  MAX_SPEAKERS,
  MAX_TALK_DEPARTMENTS,
  scrubTalkText,
  TALK_LIMITS,
  talkKey,
  talkSearchText,
} from "../lib/talks"
import { literalUnion } from "../lib/validators"
import { talkDepartmentCountValidator } from "../schema"

/**
 * The talks pillar's ingestion (talks-redesign-spec §4, decision D7), behind
 * `POST /api/pipeline/talks/*` (convex/http.ts):
 *
 *  - `departmentsUpsert` (`talks/departments`): the department registry,
 *    upserted by key, at most 500 a call. Never deleted.
 *  - `batch` (`talks/batch`): at most 200 talks a call, upserted by key. A row
 *    whose content is unchanged only gets `lastSeenAt` / `lastRunId` (and
 *    `retrievedAt`) bumped; a changed one is replaced and gets `updatedAt`. A
 *    talk the sweep marked `missing` is `listed` again. The server checks the
 *    caps of spec §3 (in code points, as the pipeline clips) and the key,
 *    drops an impossible end (`storedEnd`), and derives
 *    `primaryDepartmentKey`, `school` (from `departments`) and `searchText`.
 *    Name and contact suppressions are applied before anything is stored
 *    (`scrubTalkText`): a suppressed speaker is dropped and suppressed names
 *    and addresses are cut out of the texts, so no run brings them back.
 *  - `sweep` (`talks/sweep`): for each source read completely this run, every
 *    talk of it starting in [from, to) that this run did not post and that has
 *    not started yet becomes `missing`. Never deletes. Bounded per call; the
 *    HTTP route repeats it until done (see `sweep`).
 *  - `runs` (`talks/runs`): the run summary, upserted by `runId`.
 *
 * Plus three walks, each a page per scheduled mutation: `refreshStats` (the
 * counts the department index and home page read: after a finished sweep and
 * daily), `purgeExpired` (retention: talks and their details 30 days after
 * they ended; daily, convex/crons.ts) and `scrubStored` (accepting a name or
 * contact suppression applies it to the talks already stored,
 * lib/suppressionEffects.ts).
 */

/** Talks per `talks/batch` call (each costs a few reads and two writes). */
export const MAX_TALK_BATCH = 200

/** `talks_cam`, or `<departmentKey>#<sourceIndex>`. */
const SOURCE = /^(talks_cam|dept-[a-z0-9]+(?:-[a-z0-9]+)*#\d+)$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A talk listed over more than this is a feed error, not a talk. */
const MAX_TALK_SPAN_MS = 31 * DAY_MS

// --- departments -------------------------------------------------------------------------

const departmentWire = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  shortName: v.string(),
  school: literalUnion(TALK_SCHOOLS),
  website: v.string(),
  aliases: v.array(v.string()),
})

const batchResult = v.object({ inserted: v.number(), updated: v.number(), unchanged: v.number() })

export const departmentsUpsert = internalMutation({
  args: { departments: v.array(departmentWire) },
  returns: batchResult,
  handler: async (ctx, args) => {
    assertBatchSize(args.departments.length, "departments")
    const now = Date.now()
    const result = emptyBatchResult()
    for (const department of args.departments) {
      if (!SLUG.test(department.slug) || department.slug.length > 120) {
        throw new Error(`Department slug is not a slug: ${department.slug}`)
      }
      if (department.key !== `dept-${department.slug}`) {
        throw new Error(`Department key must be dept-<slug>: ${department.key}`)
      }
      if (!department.name.trim() || department.name.length > 300) {
        throw new Error(`${department.key}: name must be 1..300 characters`)
      }
      if (!department.shortName.trim() || department.shortName.length > 120) {
        throw new Error(`${department.key}: shortName must be 1..120 characters`)
      }
      if (!isHttpUrl(department.website)) {
        throw new Error(`${department.key}: website must be http(s)`)
      }
      if (department.aliases.length > 50 || department.aliases.some((a) => a.length > 200)) {
        throw new Error(`${department.key}: at most 50 aliases of at most 200 characters`)
      }
      const existing = await ctx.db
        .query("departments")
        .withIndex("by_key", (q) => q.eq("key", department.key))
        .unique()
      if (!existing) {
        // A slug is never reused by another key.
        const slugTaken = await ctx.db
          .query("departments")
          .withIndex("by_slug", (q) => q.eq("slug", department.slug))
          .first()
        if (slugTaken) throw new Error(`Slug ${department.slug} belongs to ${slugTaken.key}`)
      }
      const { outcome } = await upsertRow(ctx, "departments", existing, department, now, {
        touchUpdatedAt: true,
      })
      recordBatch(result, outcome)
    }
    if (result.inserted > 0) {
      // `departmentsTotal` changed. A School or short name that changed reaches
      // the talks with their next batch (each re-derives it).
      await ctx.scheduler.runAfter(0, internal.ingest.talks.refreshStats, {})
    }
    return result
  },
})

// --- talks -------------------------------------------------------------------------------

const talkWire = v.object({
  key: v.string(),
  sourceType: literalUnion(TALK_SOURCE_TYPES),
  source: v.string(),
  externalId: v.string(),
  url: v.string(),
  sourceUrl: v.string(),
  title: v.string(),
  speakers: v.array(speakerValidator),
  series: v.optional(v.string()),
  departmentKeys: v.array(v.string()),
  startsAt: v.number(),
  endsAt: v.optional(v.number()),
  allDay: v.boolean(),
  venue: v.optional(v.string()),
  online: v.boolean(),
  kind: literalUnion(TALK_KINDS),
  cancelled: v.boolean(),
  abstract: v.optional(v.string()),
  specialMessage: v.optional(v.string()),
  retrievedAt: v.number(),
})
type TalkWire = typeof talkWire.type

/** Characters as the pipeline counts them (Python `len`: code points, not the
 * UTF-16 units of `.length`), so a clipped abstract with a math letter or an
 * emoji is not refused. */
function codePoints(value: string): number {
  return [...value].length
}

function capped(key: string, field: string, value: string | undefined, limit: number): void {
  if (value !== undefined && codePoints(value) > limit) {
    throw new Error(`${key}: ${field} is longer than ${limit} characters`)
  }
}

/** Rejects a talk the pipeline should never have sent, naming its key, so the
 * whole batch is a 400 rather than a row written half-checked. */
export function checkTalk(talk: TalkWire): void {
  const key = talk.key
  if (key !== talkKey(talk.sourceType, talk.externalId)) {
    throw new Error(`${key}: key is not talk-sha1(sourceType:externalId)[:20]`)
  }
  if (!talk.externalId || codePoints(talk.externalId) > TALK_LIMITS.externalId) {
    throw new Error(`${key}: externalId must be 1..${TALK_LIMITS.externalId} characters`)
  }
  if (!SOURCE.test(talk.source) || talk.source.length > TALK_LIMITS.source) {
    throw new Error(`${key}: source must be talks_cam or <departmentKey>#<index>`)
  }
  if ((talk.source === "talks_cam") !== (talk.sourceType === "talks_cam")) {
    throw new Error(`${key}: only talks.cam talks are swept as talks_cam`)
  }
  if (!isHttpUrl(talk.url) || !isHttpUrl(talk.sourceUrl)) {
    throw new Error(`${key}: url and sourceUrl must be http(s)`)
  }
  if (!talk.title.trim()) throw new Error(`${key}: title is empty`)
  capped(key, "title", talk.title, TALK_LIMITS.title)
  capped(key, "series", talk.series, TALK_LIMITS.series)
  capped(key, "venue", talk.venue, TALK_LIMITS.venue)
  capped(key, "abstract", talk.abstract, TALK_LIMITS.abstract)
  capped(key, "specialMessage", talk.specialMessage, TALK_LIMITS.specialMessage)
  if (talk.speakers.length > MAX_SPEAKERS) {
    throw new Error(`${key}: at most ${MAX_SPEAKERS} speakers`)
  }
  for (const speaker of talk.speakers) {
    if (!speaker.name.trim()) throw new Error(`${key}: a speaker has no name`)
    capped(key, "speaker name", speaker.name, TALK_LIMITS.speakerName)
    capped(key, "speaker affiliation", speaker.affiliation, TALK_LIMITS.speakerAffiliation)
  }
  if (talk.departmentKeys.length > MAX_TALK_DEPARTMENTS) {
    throw new Error(`${key}: at most ${MAX_TALK_DEPARTMENTS} departments`)
  }
  if (new Set(talk.departmentKeys).size !== talk.departmentKeys.length) {
    throw new Error(`${key}: departmentKeys repeats a key`)
  }
  if (!Number.isFinite(talk.startsAt) || !Number.isFinite(talk.retrievedAt)) {
    throw new Error(`${key}: startsAt and retrievedAt must be epoch ms`)
  }
  if (talk.endsAt !== undefined && !Number.isFinite(talk.endsAt)) {
    throw new Error(`${key}: endsAt must be epoch ms`)
  }
}

/** The end the row keeps: none when the source's end is before the start or
 * more than 31 days after it (a feed error, not a talk). Dropped rather than
 * refused, so one bad feed entry does not fail the other talks of its batch;
 * the row's end is then never before its start, which retention relies on. */
export function storedEnd(talk: Pick<TalkWire, "startsAt" | "endsAt">): number | null {
  const { startsAt, endsAt } = talk
  if (endsAt === undefined || endsAt < startsAt || endsAt - startsAt > MAX_TALK_SPAN_MS) {
    return null
  }
  return endsAt
}

/** Drops the keys whose value is `undefined`, so a replaced row has no such field. */
function defined<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T
}

/** Inserts, replaces or deletes a talk's details; whether anything changed. */
async function writeDetails(ctx: MutationCtx, talk: TalkWire): Promise<boolean> {
  const existing = await ctx.db
    .query("talkDetails")
    .withIndex("by_talkKey", (q) => q.eq("talkKey", talk.key))
    .unique()
  const details = defined({
    talkKey: talk.key,
    abstract: talk.abstract,
    specialMessage: talk.specialMessage,
  })
  const empty = details.abstract === undefined && details.specialMessage === undefined
  if (!existing) {
    if (empty) return false
    await ctx.db.insert("talkDetails", details)
    return true
  }
  if (empty) {
    await ctx.db.delete(existing._id)
    return true
  }
  if (
    existing.abstract === details.abstract &&
    existing.specialMessage === details.specialMessage
  ) {
    return false
  }
  await ctx.db.replace(existing._id, details)
  return true
}

export const batch = internalMutation({
  args: { runId: v.string(), talks: v.array(talkWire) },
  returns: batchResult,
  handler: async (ctx, args) => {
    if (args.talks.length > MAX_TALK_BATCH) {
      throw new Error(`Batch too large: ${args.talks.length} talks, maximum is ${MAX_TALK_BATCH}`)
    }
    if (!args.runId.trim() || args.runId.length > 100) {
      throw new Error("runId must be 1..100 characters")
    }
    for (const talk of args.talks) checkTalk(talk)

    // Talks are not claims, so `suppressedClaim` never sees them: a name or
    // address removed on request is cut out here, before anything is stored.
    const [contacts, names] = await Promise.all([loadContactHashes(ctx), loadNameHashes(ctx)])
    const now = Date.now()
    const result = emptyBatchResult()
    const departments = new Map<string, Doc<"departments"> | null>()
    const department = async (key: string) => {
      if (!departments.has(key)) {
        departments.set(
          key,
          await ctx.db
            .query("departments")
            .withIndex("by_key", (q) => q.eq("key", key))
            .unique(),
        )
      }
      return departments.get(key) ?? null
    }

    for (const posted of args.talks) {
      const talk = scrubTalkText(posted, contacts, names)
      const rows: Doc<"departments">[] = []
      for (const key of talk.departmentKeys) {
        const row = await department(key)
        // The registry is posted before the talks (`talks/departments`).
        if (!row) throw new Error(`${talk.key}: department not found: ${key}`)
        rows.push(row)
      }
      const content = defined({
        sourceType: talk.sourceType,
        source: talk.source,
        externalId: talk.externalId,
        url: talk.url,
        sourceUrl: talk.sourceUrl,
        title: talk.title,
        speakers: talk.speakers.map((speaker) => defined({ ...speaker })),
        series: talk.series,
        departmentKeys: talk.departmentKeys,
        primaryDepartmentKey: rows[0]?.key ?? null,
        school: rows[0]?.school ?? null,
        startsAt: talk.startsAt,
        endsAt: storedEnd(talk),
        allDay: talk.allDay,
        venue: talk.venue ?? null,
        online: talk.online,
        kind: talk.kind,
        cancelled: talk.cancelled,
        searchText: talkSearchText(
          talk,
          rows.map((row) => row.shortName),
        ),
      })
      const sighting = { lastSeenAt: now, lastRunId: args.runId, retrievedAt: talk.retrievedAt }

      const existing = await ctx.db
        .query("talks")
        .withIndex("by_key", (q) => q.eq("key", talk.key))
        .unique()
      const detailsChanged = await writeDetails(ctx, talk)
      if (!existing) {
        await ctx.db.insert("talks", {
          key: talk.key,
          ...content,
          ...sighting,
          listing: "listed",
          firstSeenAt: now,
          updatedAt: now,
        })
        recordBatch(result, "inserted")
        continue
      }
      // Only the fields `content` carries are compared; `series` absent on
      // both sides is equal, absent on one is a change.
      const unchanged =
        !detailsChanged &&
        existing.listing === "listed" &&
        sameFields(existing, content) &&
        (existing.series === undefined) === (content.series === undefined)
      if (unchanged) {
        await ctx.db.patch(existing._id, sighting)
        recordBatch(result, "unchanged")
      } else {
        await ctx.db.replace(existing._id, {
          key: talk.key,
          ...content,
          ...sighting,
          listing: "listed",
          firstSeenAt: existing.firstSeenAt,
          updatedAt: now,
        })
        recordBatch(result, "updated")
      }
    }
    return result
  },
})

// --- sweep -------------------------------------------------------------------------------

/** Talks one `sweep` call reads at most (one paginated page, plus whole
 * sources that fit in what is left). */
export const SWEEP_PAGE = 1000
/** The widest window a sweep may cover. */
const MAX_SWEEP_WINDOW_MS = 400 * DAY_MS
const MAX_SWEEP_SOURCES = 500

/** Where a sweep stopped: the index into `sources`, and the paginate cursor
 * inside that source (null: from its start). */
type SweepCursor = { i: number; c: string | null }

function parseSweepCursor(cursor: string | null | undefined, sources: number): SweepCursor {
  if (!cursor) return { i: 0, c: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(cursor)
  } catch {
    throw new Error("cursor is not a sweep cursor")
  }
  const { i, c } = (parsed ?? {}) as Partial<SweepCursor>
  if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i > sources) {
    throw new Error("cursor is not a sweep cursor")
  }
  if (c !== null && typeof c !== "string") throw new Error("cursor is not a sweep cursor")
  return { i, c }
}

/**
 * Marks `missing` every talk of `sources` starting in [from, to) that run
 * `runId` did not post (`lastRunId !== runId`), that is still `listed` and
 * that has not started yet (a source that lists upcoming talks only has
 * dropped the ones that just happened).
 * `missing` counts the rows it changed.
 *
 * Bounded: a call reads one page of the source it stopped in (Convex allows one
 * `.paginate` per function) and then whole sources while they fit in
 * `SWEEP_PAGE`, and returns `{ done: false, cursor }` where it stopped; the
 * caller passes `cursor` back with the same arguments. `POST
 * /api/pipeline/talks/sweep` does that loop itself (convex/http.ts), so the
 * pipeline normally gets `{ missing, done: true, cursor: null }` from one
 * request. When the stats are due (the sweep finished), it schedules them.
 */
export const sweep = internalMutation({
  args: {
    runId: v.string(),
    from: v.number(),
    to: v.number(),
    sources: v.array(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    missing: v.number(),
    done: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    if (!args.runId.trim()) throw new Error("runId is empty")
    if (!(args.to > args.from)) throw new Error("`to` must be after `from`")
    if (args.to - args.from > MAX_SWEEP_WINDOW_MS) {
      throw new Error("A sweep covers at most 400 days")
    }
    if (args.sources.length > MAX_SWEEP_SOURCES) {
      throw new Error(`At most ${MAX_SWEEP_SOURCES} sources a sweep`)
    }
    for (const source of args.sources) {
      if (!SOURCE.test(source)) throw new Error(`Not a talk source: ${source}`)
    }
    const sources = [...new Set(args.sources)]
    let { i, c } = parseSweepCursor(args.cursor, sources.length)
    let budget = SWEEP_PAGE
    let missing = 0

    // A talk that has already started stays listed until retention: many
    // sources list upcoming talks only, so yesterday's (or one under way) has
    // left the page by the run, and hiding it helps no one.
    const now = Date.now()
    const mark = async (rows: Doc<"talks">[]) => {
      for (const talk of rows) {
        if (talk.lastRunId === args.runId || talk.listing !== "listed") continue
        if (talk.startsAt < now) continue
        await ctx.db.patch(talk._id, { listing: "missing" })
        missing++
      }
    }
    const range = (source: string) =>
      ctx.db
        .query("talks")
        .withIndex("by_source_startsAt", (q) =>
          q.eq("source", source).gte("startsAt", args.from).lt("startsAt", args.to),
        )

    let first = true
    while (i < sources.length && budget > 0) {
      if (first) {
        // The one paginated read of this call, resuming where the last stopped.
        first = false
        const page = await range(sources[i]).paginate({ numItems: budget, cursor: c })
        await mark(page.page)
        budget -= page.page.length
        if (!page.isDone) {
          c = page.continueCursor
          break
        }
        i++
        c = null
        continue
      }
      // Later sources only when the whole source fits; otherwise the next call
      // paginates it.
      const rows = await range(sources[i]).take(budget + 1)
      if (rows.length > budget) break
      await mark(rows)
      budget -= rows.length
      i++
    }

    const done = i >= sources.length
    if (done) await ctx.scheduler.runAfter(0, internal.ingest.talks.refreshStats, {})
    return { missing, done, cursor: done ? null : JSON.stringify({ i, c }) }
  },
})

// --- runs --------------------------------------------------------------------------------

const MAX_RUN_ERRORS = 50
const MAX_RUN_ERROR_LENGTH = 500

export const runs = internalMutation({
  args: {
    runId: v.string(),
    status: literalUnion(TALK_RUN_STATUSES),
    startedAt: v.number(),
    finishedAt: v.number(),
    sourcesOk: v.number(),
    sourcesFailed: v.number(),
    talksReceived: v.number(),
    inserted: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    missing: v.number(),
    errors: v.array(v.string()),
  },
  returns: v.object({ runId: v.string(), outcome: v.string() }),
  handler: async (ctx, args) => {
    if (!args.runId.trim() || args.runId.length > 100) {
      throw new Error("runId must be 1..100 characters")
    }
    if (args.finishedAt < args.startedAt) throw new Error("finishedAt is before startedAt")
    const counts = [
      args.sourcesOk,
      args.sourcesFailed,
      args.talksReceived,
      args.inserted,
      args.updated,
      args.unchanged,
      args.missing,
    ]
    if (counts.some((count) => !Number.isInteger(count) || count < 0)) {
      throw new Error("Run counts must be non-negative integers")
    }
    // The run log is diagnostic: long error lists are cut, not refused.
    const errors = args.errors
      .slice(0, MAX_RUN_ERRORS)
      .map((error) =>
        error.length > MAX_RUN_ERROR_LENGTH
          ? `${error.slice(0, MAX_RUN_ERROR_LENGTH - 1)}…`
          : error,
      )
    const existing = await ctx.db
      .query("talkRuns")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .unique()
    const { outcome } = await upsertRow(
      ctx,
      "talkRuns",
      existing,
      { ...args, errors },
      Date.now(),
      { touchUpdatedAt: true },
    )
    return { runId: args.runId, outcome }
  },
})

// --- stats -------------------------------------------------------------------------------

/** Days ahead the department index and `next28Days` count. */
export const UPCOMING_DAYS = 28
/** Talk rows per stats page (light rows, about 1 KB each). */
const STATS_PAGE = 1000

const statsAccumulator = v.object({
  thisWeek: v.number(),
  next28Days: v.number(),
  byDepartment: v.record(v.string(), talkDepartmentCountValidator),
  otherSeries: talkDepartmentCountValidator,
})
type StatsAccumulator = typeof statsAccumulator.type

/** The London week holding `now`, [Monday 00:00, next Monday 00:00). */
export function londonWeekOf(now: number): { start: number; end: number } {
  const monday = startOfWeek(londonIsoDate(now))
  return { start: londonMidnight(monday), end: londonMidnight(addDays(monday, 7)) }
}

/** Adds one listed talk to the counts (cancelled talks are not counted). */
export function countTalk(
  acc: StatsAccumulator,
  talk: Doc<"talks">,
  now: number,
  week: { start: number; end: number },
): void {
  if (talk.cancelled) return
  if (talk.startsAt >= week.start && talk.startsAt < week.end) acc.thisWeek++
  if (talk.startsAt < now || talk.startsAt >= now + UPCOMING_DAYS * DAY_MS) return
  acc.next28Days++
  const key = talk.primaryDepartmentKey
  let bucket = acc.otherSeries
  if (key !== null) {
    acc.byDepartment[key] ??= { upcomingCount: 0, nextStartsAt: null }
    bucket = acc.byDepartment[key]
  }
  bucket.upcomingCount++
  // Rows arrive by ascending start, so the first one counted is the next.
  bucket.nextStartsAt ??= talk.startsAt
}

/**
 * Recomputes the one `talkStats` row: a page of listed talks per scheduled
 * mutation (by `by_listing_startsAt`, from the start of this London week to 28
 * days ahead), carrying the counts to the next; the last page writes the row.
 * Two walks may overlap; the one that started later wins.
 */
export const refreshStats = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    acc: v.optional(statsAccumulator),
  },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const acc: StatsAccumulator = args.acc ?? {
      thisWeek: 0,
      next28Days: 0,
      byDepartment: {},
      otherSeries: { upcomingCount: 0, nextStartsAt: null },
    }
    const week = londonWeekOf(now)
    const from = Math.min(week.start, now)
    const to = Math.max(week.end, now + UPCOMING_DAYS * DAY_MS)
    const page = await ctx.db
      .query("talks")
      .withIndex("by_listing_startsAt", (q) =>
        q.eq("listing", "listed").gte("startsAt", from).lt("startsAt", to),
      )
      .paginate({ numItems: STATS_PAGE, cursor: args.cursor ?? null })
    for (const talk of page.page) countTalk(acc, talk, now, week)
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.talks.refreshStats, {
        now,
        cursor: page.continueCursor,
        acc,
      })
      return { done: false }
    }
    // The registry has a few hundred rows.
    const departmentsTotal = (await ctx.db.query("departments").take(2000)).length
    const row = {
      scope: "talks" as const,
      ...acc,
      departmentsTotal,
      startedAt: now,
      computedAt: Date.now(),
    }
    const existing = await ctx.db
      .query("talkStats")
      .withIndex("by_scope", (q) => q.eq("scope", "talks"))
      .first()
    if (!existing) await ctx.db.insert("talkStats", row)
    else if (existing.startedAt <= now) await ctx.db.replace(existing._id, row)
    return { done: true }
  },
})

/** Daily: the counts are relative to the day (convex/crons.ts). */
export const refreshStatsDaily = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.ingest.talks.refreshStats, {})
    return null
  },
})

// --- retention ---------------------------------------------------------------------------

/** A talk (and its details) is kept this long after it ended. */
export const TALK_RETENTION_DAYS = 30
const PURGE_PAGE = 200

/**
 * Deletes talks whose `endsAt ?? startsAt` is more than 30 days past, with
 * their details: a page per scheduled mutation, listed talks first, then
 * missing ones. Every page of one walk uses the same `now`.
 */
export const purgeExpired = internalMutation({
  args: {
    now: v.optional(v.number()),
    listing: v.optional(literalUnion(TALK_LISTINGS)),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const listing = args.listing ?? TALK_LISTINGS[0]
    const cutoff = now - TALK_RETENTION_DAYS * DAY_MS
    // `endsAt` is never before `startsAt`, so every expired talk starts before the cutoff.
    const page = await ctx.db
      .query("talks")
      .withIndex("by_listing_startsAt", (q) => q.eq("listing", listing).lt("startsAt", cutoff))
      .paginate({ numItems: PURGE_PAGE, cursor: args.cursor ?? null })
    let deleted = 0
    for (const talk of page.page) {
      if ((talk.endsAt ?? talk.startsAt) >= cutoff) continue
      const details = await ctx.db
        .query("talkDetails")
        .withIndex("by_talkKey", (q) => q.eq("talkKey", talk.key))
        .unique()
      if (details) await ctx.db.delete(details._id)
      await ctx.db.delete(talk._id)
      deleted++
    }
    const nextListing = TALK_LISTINGS[TALK_LISTINGS.indexOf(listing) + 1]
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.talks.purgeExpired, {
        now,
        listing,
        cursor: page.continueCursor,
      })
    } else if (nextListing) {
      await ctx.scheduler.runAfter(0, internal.ingest.talks.purgeExpired, {
        now,
        listing: nextListing,
        cursor: null,
      })
    }
    return { deleted, done: page.isDone && !nextListing }
  },
})

// --- suppressions ------------------------------------------------------------------------

/** Talks per `scrubStored` page (each may read its details and departments). */
const SCRUB_PAGE = 200

/**
 * Applies the current name and contact suppressions to every stored talk
 * and its details (`scrubTalkText`), re-deriving `searchText`, so a name
 * removed on request is no longer shown or found. Scheduled when such a
 * suppression is accepted (lib/suppressionEffects.ts); a page per scheduled
 * mutation, listed and missing talks alike. Idempotent: a clean row is not
 * written. Lifting the suppression needs no walk back: the next run posts
 * the talk as its source lists it.
 */
export const scrubStored = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ changed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const [contacts, names] = await Promise.all([loadContactHashes(ctx), loadNameHashes(ctx)])
    if (contacts.size === 0 && names.size === 0) return { changed: 0, done: true }
    const page = await ctx.db
      .query("talks")
      .paginate({ numItems: SCRUB_PAGE, cursor: args.cursor ?? null })
    let changed = 0
    for (const talk of page.page) {
      const details = await ctx.db
        .query("talkDetails")
        .withIndex("by_talkKey", (q) => q.eq("talkKey", talk.key))
        .unique()
      const before = {
        title: talk.title,
        speakers: talk.speakers,
        series: talk.series,
        venue: talk.venue,
        abstract: details?.abstract,
        specialMessage: details?.specialMessage,
      }
      const after = scrubTalkText(before, contacts, names)
      if (JSON.stringify(after) === JSON.stringify(before)) continue
      const shortNames: string[] = []
      for (const key of talk.departmentKeys) {
        const department = await ctx.db
          .query("departments")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique()
        if (department) shortNames.push(department.shortName)
      }
      await ctx.db.patch(talk._id, {
        title: after.title,
        speakers: after.speakers,
        ...(after.series !== undefined ? { series: after.series } : {}),
        venue: after.venue ?? null,
        searchText: talkSearchText(after, shortNames),
        updatedAt: Date.now(),
      })
      if (details) {
        await ctx.db.replace(
          details._id,
          defined({
            talkKey: talk.key,
            abstract: after.abstract,
            specialMessage: after.specialMessage,
          }),
        )
      }
      changed++
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ingest.talks.scrubStored, {
        cursor: page.continueCursor,
      })
    }
    return { changed, done: page.isDone }
  },
})
