import { paginationOptsValidator, paginationResultValidator } from "convex/server"
import { v } from "convex/values"
import { addDays, DAY_MS, londonIsoDate } from "../lib/calendar"
import { TALK_KINDS, TALK_SCHOOLS, type TalkKind, type TalkSchool } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { pageLimit } from "./lib/ingest"
import {
  carriesSuppressedAddress,
  carriesSuppressedName,
  loadContactHashes,
  loadNameHashes,
  nameHash,
} from "./lib/suppressions"
import {
  departmentCache,
  OTHER_SERIES_NAME,
  OTHER_SERIES_SLUG,
  scrubTalkItem,
  talkListItem,
  talkListItemValidator,
  talkPublicValidator,
} from "./lib/talks"
import { literalUnion } from "./lib/validators"

/**
 * The public talks pillar (talks-redesign-spec §4, decision D7).
 *
 * Every query returns `listing: "listed"` talks only, and leaves out
 * abstracts except `get`. The department index and the home page's counts
 * come from the one precomputed `talkStats` row (convex/ingest/talks.ts
 * `refreshStats`), so no public query scans the talks.
 *
 * Name and contact suppressions (convex/lib/suppressions.ts) are applied to
 * every talk returned (`scrubTalkItem`), and `search` leaves out a talk whose
 * stored text still names a suppressed person or address, so it is not found
 * by the removed name. The ingest stores talks already scrubbed; this is the
 * backstop until the walk an accepted suppression schedules
 * (convex/ingest/talks.ts `scrubStored`) has rewritten the stored rows.
 *
 * `department` arguments are department **slugs** (the `/talks` URL state);
 * `other-series` selects the talks with no department. A department filter
 * matches a talk's primary department (`departmentKeys[0]`), the one its
 * index orders by; `school` is that department's School.
 */

/** The widest window `list` may ask for. */
export const MAX_LIST_WINDOW_MS = 186 * DAY_MS
/** The widest window `dayCounts` may ask for (two months: the `.ics` feed's 60
 * days, or six week strips). */
export const MAX_DAY_COUNT_WINDOW_MS = 62 * DAY_MS
/** Rows `dayCounts` reads at most; far above two months of talks. */
const MAX_DAY_COUNT_ROWS = 8000
const MAX_PAGE_SIZE = 100
const MAX_SEARCH_RESULTS = 50
/** Search hits read before the upcoming filter (past talks stay 30 days). */
const SEARCH_READ = 256
const MAX_DEPARTMENTS = 2000

const filterArgs = {
  school: v.optional(literalUnion(TALK_SCHOOLS)),
  /** A department slug, or `other-series`. */
  department: v.optional(v.string()),
}

type Filters = {
  school?: TalkSchool
  /** Resolved from the slug: one primary department key, or null (no department). */
  departmentKey?: { key: string | null }
  kind?: TalkKind
  online?: boolean
}

/** What a `department` slug selects: one primary department key, null (no
 * department), or nothing at all (an unknown slug). */
async function departmentKeyOf(
  ctx: QueryCtx,
  slug: string | undefined,
): Promise<{ key: string | null } | "none" | undefined> {
  if (slug === undefined) return undefined
  if (slug === OTHER_SERIES_SLUG) return { key: null }
  const department = await ctx.db
    .query("departments")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique()
  return department ? { key: department.key } : "none"
}

/** The listed talks starting in [from, to), by start, on the narrowest index
 * for the department or School; `matches` applies the rest.
 *
 * A talk is on its start day only: one spanning several days (a workshop or
 * conference, up to 31 days) is not in `list` or `dayCounts` for a window
 * that starts after its first day. Talks have no `spanEndsAt` as events do;
 * multi-day talks are rare, and the pages group by start day. */
function talksInWindow(ctx: QueryCtx, from: number, to: number, filters: Filters) {
  const { school, departmentKey } = filters
  if (departmentKey) {
    return ctx.db
      .query("talks")
      .withIndex("by_listing_dept_startsAt", (q) =>
        q
          .eq("listing", "listed")
          .eq("primaryDepartmentKey", departmentKey.key)
          .gte("startsAt", from)
          .lt("startsAt", to),
      )
  }
  if (school) {
    return ctx.db
      .query("talks")
      .withIndex("by_listing_school_startsAt", (q) =>
        q.eq("listing", "listed").eq("school", school).gte("startsAt", from).lt("startsAt", to),
      )
  }
  return ctx.db
    .query("talks")
    .withIndex("by_listing_startsAt", (q) =>
      q.eq("listing", "listed").gte("startsAt", from).lt("startsAt", to),
    )
}

async function loadSuppressed(ctx: QueryCtx) {
  const [contacts, names] = await Promise.all([loadContactHashes(ctx), loadNameHashes(ctx)])
  return { contacts, names }
}

/** Whether the searchable text of a stored talk still carries a suppressed
 * name or address (the walk has not reached it yet). */
function searchCarriesSuppressed(
  talk: Doc<"talks">,
  { contacts, names }: { contacts: ReadonlySet<string>; names: ReadonlySet<string> },
): boolean {
  const texts = [talk.title, talk.series, talk.venue, talk.speakers]
  return (
    talk.speakers.some((speaker) => names.has(nameHash(speaker.name))) ||
    carriesSuppressedName(texts, names) ||
    carriesSuppressedAddress(texts, contacts)
  )
}

/** The filters no index covers (a School beside a department, kind, online). */
function matches(talk: Doc<"talks">, filters: Filters): boolean {
  if (filters.school && talk.school !== filters.school) return false
  if (filters.kind && talk.kind !== filters.kind) return false
  if (filters.online !== undefined && talk.online !== filters.online) return false
  return true
}

function checkWindow(from: number, to: number, max: number): void {
  if (!(to > from)) throw new Error("`to` must be after `from`")
  if (to - from > max) throw new Error(`The window is limited to ${Math.round(max / DAY_MS)} days`)
}

/**
 * A page of talks starting in [from, to), ascending start. With `kind` or
 * `online` (or a School beside a department) a page may hold fewer than
 * `numItems`; keep loading until `isDone`.
 */
export const list = query({
  args: {
    /** Epoch ms, inclusive. */
    from: v.number(),
    /** Epoch ms, exclusive; at most 186 days after `from`. */
    to: v.number(),
    ...filterArgs,
    kind: v.optional(literalUnion(TALK_KINDS)),
    /** `true`: online or hybrid only; `false`: in person only. */
    online: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(talkListItemValidator),
  handler: async (ctx, args) => {
    checkWindow(args.from, args.to, MAX_LIST_WINDOW_MS)
    const departmentKey = await departmentKeyOf(ctx, args.department)
    if (departmentKey === "none") return { page: [], isDone: true, continueCursor: "" }
    const filters: Filters = {
      school: args.school,
      departmentKey,
      kind: args.kind,
      online: args.online,
    }
    const numItems = Math.max(
      1,
      Math.min(MAX_PAGE_SIZE, Math.floor(args.paginationOpts.numItems) || 1),
    )
    const result = await talksInWindow(ctx, args.from, args.to, filters).paginate({
      ...args.paginationOpts,
      numItems,
    })
    const lookup = departmentCache(ctx)
    const { contacts, names } = await loadSuppressed(ctx)
    return {
      ...result,
      page: await Promise.all(
        result.page
          .filter((talk) => matches(talk, filters))
          .map(async (talk) => scrubTalkItem(await talkListItem(talk, lookup), contacts, names)),
      ),
    }
  },
})

/** Upcoming talks matching `q` (title, speakers, series, venue, departments),
 * best match first. Upcoming: not ended before `from` (default now). */
export const search = query({
  args: {
    q: v.string(),
    ...filterArgs,
    from: v.optional(v.number()),
    /** Default 20, at most 50. */
    limit: v.optional(v.number()),
  },
  returns: v.array(talkListItemValidator),
  handler: async (ctx, args) => {
    const text = args.q.trim().toLowerCase().slice(0, 200)
    if (!text) return []
    const departmentKey = await departmentKeyOf(ctx, args.department)
    if (departmentKey === "none") return []
    const from = args.from ?? Date.now()
    const limit = Math.min(MAX_SEARCH_RESULTS, pageLimit(args.limit, 20))
    const hits = await ctx.db
      .query("talks")
      .withSearchIndex("search_text", (s) => {
        let search = s.search("searchText", text).eq("listing", "listed")
        if (args.school) search = search.eq("school", args.school)
        if (departmentKey) search = search.eq("primaryDepartmentKey", departmentKey.key)
        return search
      })
      .take(SEARCH_READ)
    const suppressed = await loadSuppressed(ctx)
    const upcoming = hits
      .filter((talk) => (talk.endsAt ?? talk.startsAt) >= from)
      .filter((talk) => !searchCarriesSuppressed(talk, suppressed))
      .slice(0, limit)
    const lookup = departmentCache(ctx)
    return await Promise.all(
      upcoming.map(async (talk) =>
        scrubTalkItem(await talkListItem(talk, lookup), suppressed.contacts, suppressed.names),
      ),
    )
  },
})

/** The listed talk behind a key, or null — the one test `get` and `exists` share. */
async function listedTalk(ctx: QueryCtx, key: string): Promise<Doc<"talks"> | null> {
  const talk = await ctx.db
    .query("talks")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  return talk?.listing === "listed" ? talk : null
}

/** One listed talk with its abstract and provenance, or null. */
export const get = query({
  args: { key: v.string() },
  returns: v.union(talkPublicValidator, v.null()),
  handler: async (ctx, args) => {
    const talk = await listedTalk(ctx, args.key)
    if (!talk) return null
    const details = await ctx.db
      .query("talkDetails")
      .withIndex("by_talkKey", (q) => q.eq("talkKey", talk.key))
      .unique()
    const { contacts, names } = await loadSuppressed(ctx)
    return scrubTalkItem(
      {
        ...(await talkListItem(talk, departmentCache(ctx))),
        abstract: details?.abstract ?? null,
        specialMessage: details?.specialMessage ?? null,
        sourceUrl: talk.sourceUrl,
        retrievedAt: talk.retrievedAt,
        firstSeenAt: talk.firstSeenAt,
        lastSeenAt: talk.lastSeenAt,
      },
      contacts,
      names,
    )
  },
})

/**
 * Whether `/talks/<key>` has a listed talk (ENG-20): the request-time gate in
 * `proxy.ts` answers an unknown or delisted key with a real 404. One indexed
 * read; a boolean, never the talk's text.
 */
export const exists = query({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => (await listedTalk(ctx, args.key)) !== null,
})

/**
 * Talks per London day in [from, to) for the week strip: every day of the
 * window, zeros included, in order. Cancelled talks are not counted. At most
 * 62 days.
 */
export const dayCounts = query({
  args: {
    from: v.number(),
    to: v.number(),
    ...filterArgs,
    kind: v.optional(literalUnion(TALK_KINDS)),
    online: v.optional(v.boolean()),
  },
  returns: v.array(v.object({ day: v.string(), count: v.number() })),
  handler: async (ctx, args) => {
    checkWindow(args.from, args.to, MAX_DAY_COUNT_WINDOW_MS)
    const counts = new Map<string, number>()
    const last = londonIsoDate(args.to - 1)
    for (let day = londonIsoDate(args.from); day <= last; day = addDays(day, 1)) {
      counts.set(day, 0)
    }
    const departmentKey = await departmentKeyOf(ctx, args.department)
    if (departmentKey !== "none") {
      const filters: Filters = {
        school: args.school,
        departmentKey,
        kind: args.kind,
        online: args.online,
      }
      const rows = await talksInWindow(ctx, args.from, args.to, filters).take(MAX_DAY_COUNT_ROWS)
      for (const talk of rows) {
        if (talk.cancelled || !matches(talk, filters)) continue
        const day = londonIsoDate(talk.startsAt)
        counts.set(day, (counts.get(day) ?? 0) + 1)
      }
    }
    return [...counts].map(([day, count]) => ({ day, count }))
  },
})

const departmentWithCountsValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  shortName: v.string(),
  school: literalUnion(TALK_SCHOOLS),
  website: v.union(v.string(), v.null()),
  /** Listed, not cancelled, primary-department talks in the next 28 days. */
  upcomingCount: v.number(),
  nextStartsAt: v.union(v.number(), v.null()),
  /** The "Other series" bucket (talks with no department), not a registry row. */
  virtual: v.boolean(),
})

async function loadStats(ctx: QueryCtx) {
  return await ctx.db
    .query("talkStats")
    .withIndex("by_scope", (q) => q.eq("scope", "talks"))
    .first()
}

/**
 * Every department with its upcoming count (next 28 days, as of the last
 * stats refresh), by School then short name, then the "Other series" bucket
 * (slug `other-series`, School `other`).
 */
export const departments = query({
  args: {},
  returns: v.array(departmentWithCountsValidator),
  handler: async (ctx) => {
    const [rows, stats] = await Promise.all([
      ctx.db.query("departments").take(MAX_DEPARTMENTS),
      loadStats(ctx),
    ])
    const schoolOrder = (school: TalkSchool) => TALK_SCHOOLS.indexOf(school)
    const sorted = rows.sort(
      (a, b) =>
        schoolOrder(a.school) - schoolOrder(b.school) || a.shortName.localeCompare(b.shortName),
    )
    return [
      ...sorted.map((department) => {
        const counts = stats?.byDepartment[department.key]
        return {
          key: department.key,
          slug: department.slug,
          name: department.name,
          shortName: department.shortName,
          school: department.school,
          website: department.website,
          upcomingCount: counts?.upcomingCount ?? 0,
          nextStartsAt: counts?.nextStartsAt ?? null,
          virtual: false,
        }
      }),
      {
        key: OTHER_SERIES_SLUG,
        slug: OTHER_SERIES_SLUG,
        name: OTHER_SERIES_NAME,
        shortName: OTHER_SERIES_NAME,
        school: "other" as const,
        website: null,
        upcomingCount: stats?.otherSeries.upcomingCount ?? 0,
        nextStartsAt: stats?.otherSeries.nextStartsAt ?? null,
        virtual: true,
      },
    ]
  },
})

/**
 * The talks pillar in numbers, as of the last stats refresh: talks this London
 * week and in the next 28 days, departments with a talk in those 28 days (of
 * `departmentsTotal`), and when the last talks run finished.
 */
export const overview = query({
  args: {},
  returns: v.object({
    thisWeek: v.number(),
    next28Days: v.number(),
    departments: v.number(),
    departmentsTotal: v.number(),
    lastRunAt: v.union(v.number(), v.null()),
    computedAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx) => {
    const [stats, lastRun] = await Promise.all([
      loadStats(ctx),
      ctx.db.query("talkRuns").withIndex("by_finishedAt").order("desc").first(),
    ])
    return {
      thisWeek: stats?.thisWeek ?? 0,
      next28Days: stats?.next28Days ?? 0,
      departments: stats
        ? Object.values(stats.byDepartment).filter((counts) => counts.upcomingCount > 0).length
        : 0,
      departmentsTotal: stats?.departmentsTotal ?? 0,
      lastRunAt: lastRun?.finishedAt ?? null,
      computedAt: stats?.computedAt ?? null,
    }
  },
})
