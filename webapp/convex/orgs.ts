import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { londonMidnight } from "../lib/calendar"
import { ORG_SORTS } from "../lib/directory-sort"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { londonIsoDate, type TermDates, termWeekLabel } from "./lib/derived"
import { withdrawnCheck } from "./lib/entityStore"
import { isHttpUrl } from "./lib/fields"
import {
  type ActivityWindow,
  activityCounts,
  activityRows,
  activityWindow,
  countRuns,
  countsAsActivity,
  relatedCards,
  sortByActivity,
  weekWindow,
} from "./lib/orgActivity"
import { facetCounts, matches, orgFiltersValidator, selections } from "./lib/orgFilters"
import {
  type EventListItem,
  eventListItem,
  eventListItemValidator,
  orgCardPublic,
  orgCardPublicValidator,
  orgPublic,
  orgPublicValidator,
  orgRefCache,
  orgRefValidator,
  type RelationshipPublic,
  relationshipPublicValidator,
  sessionPublic,
  sessionPublicValidator,
  teamPublic,
  teamPublicValidator,
  withoutSuppressed,
} from "./lib/projections"
import {
  loadContactHashes,
  loadNameHashes,
  loadSuppressedEvents,
  MAX_SUPPRESSIONS,
  scrubAddresses,
} from "./lib/suppressions"
import { literalUnion } from "./lib/validators"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * The public directory (docs/webapp.md "Public API"). Every function returns
 * the public projection only (convex/lib/projections.ts) and is safe for a
 * signed-out caller.
 */

/** More cards than this is a directory an order of magnitude past plan; the
 * scan stops rather than reading an unbounded table. */
const MAX_CARDS = 5_000
/** Convex's maximum result set for one full-text search query (docs:
 * production/state/limits). The directory holds fewer listings than this; a
 * query that fills it says so (`facets.truncated`). */
const MAX_SEARCH_RESULTS = 1_024
const MAX_PAGE_SIZE = 100
const MAX_QUERY_LENGTH = 200

/** Candidate cards: search-ranked for a query, else every listed card by name. */
async function candidates(ctx: QueryCtx, q: string | undefined): Promise<Doc<"orgCards">[]> {
  const text = q?.trim().slice(0, MAX_QUERY_LENGTH)
  if (text) {
    return await ctx.db
      .query("orgCards")
      .withSearchIndex("search_text", (s) =>
        s.search("searchText", text).eq("isCounterpart", false),
      )
      .take(MAX_SEARCH_RESULTS)
  }
  return await ctx.db
    .query("orgCards")
    .withIndex("by_isCounterpart_nameSort", (i) => i.eq("isCounterpart", false))
    .take(MAX_CARDS)
}

/** A card's activity: its counted events this term (convex/lib/
 * orgActivity.ts) and the next one, for the directory's meta line and date
 * chip. */
const cardActivityValidator = v.object({
  count: v.number(),
  /** Whether `count` is this term's (else the next eight weeks'). */
  inTerm: v.boolean(),
  next: v.optional(
    v.object({
      startsAt: v.number(),
      allDay: v.boolean(),
      termWeekLabel: v.optional(v.string()),
    }),
  ),
})
const orgCardListValidator = v.object({
  ...orgCardPublicValidator.fields,
  /** Absent from a deployment older than the field. */
  activity: v.optional(cardActivityValidator),
})

/** Organiser rows read for one card's activity: more than any listing holds
 * in a term. */
const MAX_ACTIVITY_ROWS = 300
/** Public organiser rows read to rank the whole directory by activity (about
 * 0.2 KB each, two or so per event): a term holds well under this. */
const MAX_WINDOW_ROWS = 12_000

async function loadTerms(ctx: QueryCtx): Promise<TermDates[]> {
  return await ctx.db.query("termDates").take(100)
}

/** Counted runs per organisation in a window, from the public organiser
 * rows: the light copies `cardActivity` counts too, never the events
 * themselves (a term of full events would near the per-query read limit). */
async function windowCounts(
  ctx: QueryCtx,
  window: ActivityWindow,
  removed: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_visibility_startsAt", (i) =>
      i.eq("visibility", "public").gte("startsAt", window.from).lt("startsAt", window.to),
    )
    .take(MAX_WINDOW_ROWS)
  return activityCounts(rows, removed)
}

/** One card's activity: counted runs in the window (a show's nights in one
 * week are one; convex/lib/orgActivity.ts) and the next event that is still
 * on (not cancelled, not withdrawn). Reads the organiser rows only, plus at
 * most three events for `next`. */
async function cardActivity(
  ctx: QueryCtx,
  orgKey: string,
  window: ActivityWindow,
  removed: ReadonlySet<string>,
  withdrawn: ReturnType<typeof withdrawnCheck>,
  today: number,
) {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_org_startsAt", (i) =>
      i.eq("orgKey", orgKey).gte("startsAt", window.from).lt("startsAt", window.to),
    )
    .take(MAX_ACTIVITY_ROWS)
  const counted = rows.filter((row) => countsAsActivity(row, removed))
  const count = countRuns(counted)
  let next: { startsAt: number; allDay: boolean; termWeekLabel?: string } | undefined
  // Rows come in start order: the first few upcoming ones, until one is on.
  for (const row of counted.filter((item) => item.startsAt >= today).slice(0, 3)) {
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (i) => i.eq("key", row.eventKey))
      .unique()
    if (event && !event.cancelled && event.visibility === "public" && !(await withdrawn(event))) {
      next = { startsAt: event.startsAt, allDay: event.allDay, termWeekLabel: event.termWeekLabel }
      break
    }
  }
  return { count, inTerm: window.inTerm, next }
}

/**
 * One page of directory cards matching the filters, each with its activity
 * this term. Order (`sort`): search relevance for a text query, else name
 * (the default, `relevance`); `name` for A–Z either way; `active` for most
 * events this term first. Works with `usePaginatedQuery`; the cursor is an
 * offset into the filtered list.
 */
export const list = query({
  args: {
    ...orgFiltersValidator,
    sort: v.optional(literalUnion(ORG_SORTS)),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(orgCardListValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { paginationOpts, sort, ...filters } = args
    const selected = selections(filters)
    let matching = (await candidates(ctx, filters.q)).filter((card) => matches(card, selected))
    const now = Date.now()
    const window = activityWindow(await loadTerms(ctx), now)
    const removed = await loadSuppressedEvents(ctx)
    if (sort === "name" && filters.q?.trim()) {
      matching = [...matching].sort((a, b) => a.nameSort.localeCompare(b.nameSort))
    } else if (sort === "active") {
      matching = sortByActivity(matching, await windowCounts(ctx, window, removed))
    }
    const offset = Math.max(0, Number.parseInt(paginationOpts.cursor ?? "0", 10) || 0)
    const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(paginationOpts.numItems) || 1))
    const slice = matching.slice(offset, offset + size)
    const end = offset + slice.length
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    const withdrawn = withdrawnCheck(ctx, now)
    const today = londonMidnight(londonIsoDate(now))
    return {
      page: await Promise.all(
        slice.map(async (card) => ({
          ...scrubAddresses(await orgCardPublic(ctx, card), contacts, names),
          activity: await cardActivity(ctx, card.key, window, removed, withdrawn, today),
        })),
      ),
      isDone: end >= matching.length,
      continueCursor: String(end),
    }
  },
})

const counts = v.record(v.string(), v.number())

const facetsValidator = v.object({
  total: v.number(),
  categories: counts,
  levels: counts,
  orgTypes: counts,
  collegeKeys: counts,
  activityTypes: counts,
  audiences: counts,
  statuses: counts,
  blueStatus: counts,
  gender: counts,
  beginnerFriendly: counts,
  /** True when a search matched more listings than one query can return:
   * the counts then cover the best-ranked `MAX_SEARCH_RESULTS` only. */
  truncated: v.boolean(),
})

/** Counts per facet value under the same filters (disjunctive: each facet
 * ignores its own selection). `total` is the number `list` would return. */
export const facets = query({
  args: orgFiltersValidator,
  returns: facetsValidator,
  handler: async (ctx, args) => {
    const cards = await candidates(ctx, args.q)
    const truncated = Boolean(args.q?.trim()) && cards.length >= MAX_SEARCH_RESULTS
    return { ...facetCounts(cards, args), truncated }
  },
})

/** The colleges, for the college filter: key, slug and name, by name. */
export const colleges = query({
  args: {},
  returns: v.array(orgRefValidator),
  handler: async (ctx) => {
    const cards = await ctx.db
      .query("orgCards")
      .withIndex("by_orgType", (i) => i.eq("orgType", "college"))
      .take(200)
    return cards
      .sort((a, b) => a.nameSort.localeCompare(b.nameSort))
      .map((card) => ({ key: card.key, slug: card.slug, name: card.name }))
  },
})

const CATEGORY_EXAMPLES = 3

/** A stable, well-spread order over keys (FNV-1a), so a category's examples
 * are not always the alphabet's first ("180 Degrees", "3D Printing"). */
function spread(key: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  return hash >>> 0
}

type OrgRef = { key: string; slug: string; name: string }
const categoryExamplesValidator = v.record(v.string(), v.array(orgRefValidator))

/**
 * Up to three listed societies per category, for the home page's category
 * tiles ("Music — CU Jazz Orchestra, …"). Active ones with a description come
 * first, then a fixed pseudo-random order, so the picks are real, varied and
 * the same on every render. Public names and slugs only.
 */
function pickCategoryExamples(cards: readonly Doc<"orgCards">[]): Record<string, OrgRef[]> {
  // Colleges have their own index on the home page; a tile names societies.
  const societies = cards.filter((card) => card.orgType !== "college")
  const rank = (card: Doc<"orgCards">) =>
    (card.status === "active" ? 0 : 2) + (card.shortDescription ? 0 : 1)
  const ordered = [...societies].sort((a, b) => rank(a) - rank(b) || spread(a.key) - spread(b.key))
  const out: Record<string, OrgRef[]> = {}
  for (const card of ordered) {
    for (const category of card.categories) {
      const picked = out[category] ?? []
      if (picked.length < CATEGORY_EXAMPLES) {
        picked.push({ key: card.key, slug: card.slug, name: card.name })
      }
      out[category] = picked
    }
  }
  return out
}

/** `pickCategoryExamples` over every listed card. */
export const categoryExamples = query({
  args: {},
  returns: categoryExamplesValidator,
  handler: async (ctx) => pickCategoryExamples(await candidates(ctx, undefined)),
})

/**
 * What the home page shows of the directory, from one read of the cards:
 * the unfiltered `facets` and the `categoryExamples`. Equal to calling both,
 * at half the reads.
 */
export const home = query({
  args: {},
  returns: v.object({ facets: facetsValidator, categoryExamples: categoryExamplesValidator }),
  handler: async (ctx) => {
    const cards = await candidates(ctx, undefined)
    return {
      facets: { ...facetCounts(cards, {}), truncated: false },
      categoryExamples: pickCategoryExamples(cards),
    }
  },
})

const BUSY_LIMIT = 12
/** Public events read for the "Busy this week" shelf: one week's worth. */
const MAX_WEEK_EVENTS = 1_000

/**
 * The "Busy this week" shelf: the listings with the most counted runs in
 * this term week (Thursday to Wednesday; convex/lib/orgActivity.ts), else in
 * the next seven days, busiest first and then by name. `label` is the week
 * ("MT26 Wk 4") in term.
 */
export const busy = query({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    label: v.optional(v.string()),
    from: v.number(),
    to: v.number(),
    orgs: v.array(v.object({ card: orgCardPublicValidator, count: v.number() })),
  }),
  handler: async (ctx, args) => {
    const now = Date.now()
    const terms = await loadTerms(ctx)
    const window = weekWindow(terms, now)
    const removed = await loadSuppressedEvents(ctx)
    const events = await ctx.db
      .query("events")
      .withIndex("by_visibility_startsAt", (i) =>
        i.eq("visibility", "public").gte("startsAt", window.from).lt("startsAt", window.to),
      )
      .take(MAX_WEEK_EVENTS)
    // Cancelled events drop out in `activityCounts`, as on the cards; only
    // the shelf can afford the withdrawn check (it reads the events anyway).
    const withdrawn = withdrawnCheck(ctx, now)
    const live: Doc<"events">[] = []
    for (const event of events) {
      if (!(await withdrawn(event))) live.push(event)
    }
    const counts = activityCounts(live.flatMap(activityRows), removed)
    const lookup = orgRefCache(ctx)
    const ranked: { card: Doc<"orgCards">; count: number }[] = []
    for (const [key, count] of counts) {
      const card = await lookup(key)
      // A hidden listing has no card; counterparts and defunct groups are
      // never shelved.
      if (card && !card.isCounterpart && card.status !== "archived") ranked.push({ card, count })
    }
    ranked.sort((a, b) => b.count - a.count || a.card.nameSort.localeCompare(b.card.nameSort))
    const limit = Math.max(1, Math.min(BUSY_LIMIT, Math.floor(args.limit ?? 8) || 8))
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    return {
      label: window.inTerm ? termWeekLabel(now, terms) : undefined,
      from: window.from,
      to: window.to,
      orgs: await Promise.all(
        ranked.slice(0, limit).map(async ({ card, count }) => ({
          card: scrubAddresses(await orgCardPublic(ctx, card), contacts, names),
          count,
        })),
      ),
    }
  },
})

const RELATED_LIMIT = 6

/**
 * Listings related to one (convex/lib/orgActivity.ts `relatedScore`): the
 * same college first, then the same categories. Empty for an unknown or
 * hidden slug.
 */
export const related = query({
  args: { slug: v.string(), limit: v.optional(v.number()) },
  returns: v.array(orgCardPublicValidator),
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organisations")
      .withIndex("by_slug", (i) => i.eq("slug", args.slug))
      .unique()
    if (!org || org.hidden === true) return []
    const cards = await ctx.db
      .query("orgCards")
      .withIndex("by_isCounterpart_nameSort", (i) => i.eq("isCounterpart", false))
      .take(MAX_CARDS)
    const base = cards.find((card) => card.key === org.key)
    if (!base) return []
    const limit = Math.max(1, Math.min(RELATED_LIMIT, Math.floor(args.limit ?? RELATED_LIMIT) || 1))
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    return await Promise.all(
      relatedCards(base, cards, limit).map(async (card) =>
        scrubAddresses(await orgCardPublic(ctx, card), contacts, names),
      ),
    )
  },
})

const UPCOMING_EVENTS = 50

/**
 * The listing behind a public slug with its suppression rows, or null when
 * there is none to show: no such slug, hidden by the broker after a remove /
 * object request, or on the suppression list as a whole organisation. The one
 * test `getBySlug` and `exists` share, so a URL never 404s for a listing its
 * page would show, nor passes for one it would not.
 */
async function listedOrg(ctx: QueryCtx, slug: string) {
  const org = await ctx.db
    .query("organisations")
    .withIndex("by_slug", (i) => i.eq("slug", slug))
    .unique()
  if (!org || org.hidden === true) return null
  const suppressed = await ctx.db
    .query("suppressions")
    .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
    .take(MAX_SUPPRESSIONS)
  if (suppressed.some((row) => row.scope === "organisation")) return null
  return { org, suppressed }
}

/**
 * Whether `/societies/<slug>` has a listing to show (ENG-20): the
 * request-time gate in `proxy.ts` answers an unknown slug with a real 404
 * before the page streams. Two indexed reads; viewer-independent, since a
 * listing is public or absent.
 */
export const exists = query({
  args: { slug: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => (await listedOrg(ctx, args.slug)) !== null,
})

/**
 * One organisation's page: its public projection (with per-field `meta` for
 * the SourceLine), teams, regular sessions, upcoming events the viewer may
 * see (public; `cam_only` too for a verified @cam.ac.uk viewer), and its
 * public relationships with the counterpart's name. Null when no such slug,
 * or when the broker has hidden the listing.
 */
export const getBySlug = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      org: orgPublicValidator,
      teams: v.array(teamPublicValidator),
      sessions: v.array(sessionPublicValidator),
      events: v.array(eventListItemValidator),
      relationships: v.array(relationshipPublicValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const listed = await listedOrg(ctx, args.slug)
    if (!listed) return null
    const { org, suppressed } = listed

    const [teams, sessions] = await Promise.all([
      ctx.db
        .query("teams")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
        .take(100),
      ctx.db
        .query("sessions")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
        .take(100),
    ])

    const viewer = await getViewer(ctx)
    const tiers = visibleEventTiers(viewer)
    // From the start of today (London), so an event later today still shows,
    // plus multi-day events that began earlier and are still running.
    const from = londonMidnight(londonIsoDate(Date.now()))
    const [running, upcoming] = await Promise.all([
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_spanEndsAt", (i) => i.eq("orgKey", org.key).gt("spanEndsAt", from))
        .take(UPCOMING_EVENTS),
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (i) => i.eq("orgKey", org.key).gte("startsAt", from))
        .take(UPCOMING_EVENTS * 3),
    ])
    const removed = await loadSuppressedEvents(ctx)
    const links = [...running.filter((link) => link.startsAt < from), ...upcoming].filter(
      (link) => !removed.has(link.eventKey),
    )
    const lookup = orgRefCache(ctx)
    const withdrawn = withdrawnCheck(ctx, Date.now())
    const events: EventListItem[] = []
    const seen = new Set<string>()
    for (const link of links) {
      if (events.length >= UPCOMING_EVENTS) break
      if (seen.has(link.eventKey) || !tiers.includes(link.visibility as never)) continue
      seen.add(link.eventKey)
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (i) => i.eq("key", link.eventKey))
        .unique()
      if (event && tiers.includes(event.visibility as never) && !(await withdrawn(event))) {
        events.push(await eventListItem(event, lookup))
      }
    }
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)

    const projected = withoutSuppressed(
      await orgPublic(ctx, org),
      new Set(suppressed.flatMap((row) => (row.scope === "field" && row.field ? [row.field] : []))),
      contacts,
    )

    // Every text, conflict reading and session or event of the listing: no
    // address or name removed on request, wherever it was quoted
    // (lib/suppressions.ts).
    return scrubAddresses(
      {
        org: projected,
        teams: teams.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map(teamPublic),
        sessions: sessions
          .sort(
            (a, b) =>
              (a.dayOfWeek ?? 7) - (b.dayOfWeek ?? 7) ||
              (a.startTime ?? "").localeCompare(b.startTime ?? ""),
          )
          .map(sessionPublic),
        events,
        relationships: await publicRelationships(ctx, org.key, lookup),
      },
      contacts,
      names,
    )
  },
})

async function publicRelationships(
  ctx: QueryCtx,
  orgKey: string,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<RelationshipPublic[]> {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query("relationships")
      .withIndex("by_from", (i) => i.eq("fromKey", orgKey))
      .take(200),
    ctx.db
      .query("relationships")
      .withIndex("by_to", (i) => i.eq("toKey", orgKey))
      .take(200),
  ])
  const out: RelationshipPublic[] = []
  for (const [edges, direction] of [
    [outgoing, "outgoing"],
    [incoming, "incoming"],
  ] as const) {
    for (const edge of edges) {
      if (edge.visibility !== "public") continue
      const counterpart = await lookup(direction === "outgoing" ? edge.toKey : edge.fromKey)
      if (!counterpart) continue
      out.push({
        key: edge.key,
        type: edge.type,
        direction,
        counterpart: { key: counterpart.key, slug: counterpart.slug, name: counterpart.name },
        lastSeenAt: edge.lastSeenAt,
        confidence: edge.confidence,
        // Only links a visitor can follow; event keys stay inside (the
        // event may be in a tier this viewer cannot see).
        evidence: edge.evidence
          .filter((entry) => isHttpUrl(entry.sourceUrl))
          .map(({ sourceUrl, seenAt }) => ({ sourceUrl, seenAt })),
      })
    }
  }
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}
