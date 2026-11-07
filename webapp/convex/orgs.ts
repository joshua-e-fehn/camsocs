import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { londonMidnight } from "../lib/calendar"
import { isThinListing } from "../lib/directory-indexing"
import { ORG_SORTS } from "../lib/directory-sort"
import { withoutTalksCam } from "../lib/directory-talks-guard"
import { FINDER_RESULTS, rankSocieties, type SocietyFacts } from "../lib/finder"
import { isTalksCamUrl, isTalksDerivedEvent } from "../lib/talks-boundary"
import { AUDIENCES, CATEGORIES } from "../lib/vocab"
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

/** A card as every public list sends it: no address or name removed on
 * request (lib/suppressions.ts), and nothing from talks.cam in its text
 * (owner decision G1: the directory, hubs and profiles are open to AI
 * crawlers; talks.cam content stays under /talks). */
function publicCard<T>(card: T, contacts: ReadonlySet<string>, names: ReadonlySet<string>): T {
  return withoutTalksCam(scrubAddresses(card, contacts, names))
}

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
          ...publicCard(await orgCardPublic(ctx, card), contacts, names),
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

/** A listing as a hub lists it: enough for a line of text and a link, no
 * logo (a hub lists hundreds; html-bloat) and no activity count. */
const hubCardValidator = v.object({
  key: v.string(),
  slug: v.string(),
  name: v.string(),
  shortName: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  orgType: orgCardPublicValidator.fields.orgType,
  level: orgCardPublicValidator.fields.level,
  status: orgCardPublicValidator.fields.status,
  collegeKeys: v.array(v.string()),
  categories: orgCardPublicValidator.fields.categories,
  sport: v.optional(v.object({ sport: v.optional(v.string()) })),
})

/**
 * Every listing of one category or one college, by name, for its hub page
 * (`/categories/<slug>`, a college's `/societies/<slug>`; SEO audit
 * 2026-11-02, no-category-college-hubs, owner decision G13): the whole list
 * server-rendered on one indexable page, where the directory pages through
 * it. The directory's own rules: no counterparts, nothing archived. The
 * audience pages (`/for/<audience>`, ENG-118) ask by `audience` or by
 * `beginnerFriendly` (a sports club's flag) in the same way.
 */
export const hub = query({
  args: {
    category: v.optional(literalUnion(CATEGORIES)),
    collegeKey: v.optional(v.string()),
    audience: v.optional(literalUnion(AUDIENCES)),
    beginnerFriendly: v.optional(v.boolean()),
  },
  returns: v.array(hubCardValidator),
  handler: async (ctx, args) => {
    const selected = selections({
      categories: args.category ? [args.category] : undefined,
      collegeKeys: args.collegeKey ? [args.collegeKey] : undefined,
      audiences: args.audience ? [args.audience] : undefined,
      sport:
        args.beginnerFriendly === undefined
          ? undefined
          : { beginnerFriendly: args.beginnerFriendly },
    })
    const cards = (await candidates(ctx, undefined)).filter((card) => matches(card, selected))
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    return cards.map((card) =>
      publicCard(
        {
          key: card.key,
          slug: card.slug,
          name: card.name,
          shortName: card.shortName,
          shortDescription: card.shortDescription,
          orgType: card.orgType,
          level: card.level,
          status: card.status,
          collegeKeys: card.collegeKeys,
          categories: card.categories,
          sport: card.sport?.sport ? { sport: card.sport.sport } : undefined,
        },
        contacts,
        names,
      ),
    )
  },
})

/** Organiser rows read to tell whether a listing has any public event. */
const EVENT_PROBE = 25

/** Whether a listing has any public event, past or upcoming, that is not
 * suppressed (owner decision G3: one of the three things that make a profile
 * worth indexing). Visitor-independent: crawlers see public events only.
 * talks.cam events do not count (G1): the profile never shows them, so a
 * listing with only those has nothing to index. The probe stops at the first
 * event that counts, so it reads one or two events for most listings. */
async function hasPublicEvents(
  ctx: QueryCtx,
  orgKey: string,
  removed: ReadonlySet<string>,
): Promise<boolean> {
  const rows = await ctx.db
    .query("eventOrganisers")
    .withIndex("by_org_startsAt", (i) => i.eq("orgKey", orgKey))
    .order("desc")
    .take(EVENT_PROBE)
  for (const row of rows) {
    if (row.visibility !== "public" || removed.has(row.eventKey)) continue
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (i) => i.eq("key", row.eventKey))
      .unique()
    if (
      event &&
      event.visibility === "public" &&
      event.supersededBy === undefined &&
      !isTalksDerivedEvent(event)
    ) {
      return true
    }
  }
  return false
}

/**
 * A listing as its profile shows it: the public projection less fields
 * removed on request (suppressions) and removed addresses or names, with
 * nothing from talks.cam (G1). `getBySlug` and `sitemap` both build it here,
 * so the sitemap's thinness (G3) is the page's.
 */
async function shownOrg(
  ctx: QueryCtx,
  org: Doc<"organisations">,
  suppressed: readonly Doc<"suppressions">[],
  contacts: ReadonlySet<string>,
  names: ReadonlySet<string>,
) {
  const fields = new Set(
    suppressed.flatMap((row) => (row.scope === "field" && row.field ? [row.field] : [])),
  )
  return withoutTalksCam(
    scrubAddresses(withoutSuppressed(await orgPublic(ctx, org), fields, contacts), contacts, names),
  )
}

const SITEMAP_PAGE = 100

/**
 * One page of the society URLs the sitemap lists (lib/sitemap-societies.ts):
 * every directory listing, plus each college's own page, which is its hub
 * (G13), with when it last changed and whether it is worth indexing — a thin
 * profile (G3: no description, no public event, no website) and an empty
 * college hub are not. The cursor is an offset, as in `list`.
 */
export const sitemap = query({
  args: { cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  returns: v.object({
    page: v.array(
      v.object({
        slug: v.string(),
        kind: v.union(v.literal("listing"), v.literal("college")),
        updatedAt: v.number(),
        indexable: v.boolean(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const listings = await candidates(ctx, undefined)
    const listed = listings.filter((card) => matches(card, selections({})))
    const colleges = (
      await ctx.db
        .query("orgCards")
        .withIndex("by_orgType", (i) => i.eq("orgType", "college"))
        .take(200)
    ).sort((a, b) => a.nameSort.localeCompare(b.nameSort))
    const all = [
      ...listed.map((card) => ({ card, kind: "listing" as const })),
      ...colleges
        .filter((card) => card.isCounterpart)
        .map((card) => ({ card, kind: "college" as const })),
    ]
    const offset = Math.max(0, Number.parseInt(args.cursor ?? "0", 10) || 0)
    const size = Math.max(1, Math.min(SITEMAP_PAGE, Math.floor(args.numItems ?? SITEMAP_PAGE)))
    const slice = all.slice(offset, offset + size)
    const removed = await loadSuppressedEvents(ctx)
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    const page = []
    for (const { card, kind } of slice) {
      if (kind === "college") {
        const members = listed.filter((item) => item.collegeKeys.includes(card.key))
        const changed = Math.max(card.updatedAt, ...members.map((item) => item.updatedAt))
        page.push({ slug: card.slug, kind, updatedAt: changed, indexable: members.length > 0 })
        continue
      }
      const org = await ctx.db
        .query("organisations")
        .withIndex("by_key", (i) => i.eq("key", card.key))
        .unique()
      if (!org || org.hidden === true) continue
      const suppressed = await ctx.db
        .query("suppressions")
        .withIndex("by_orgKey", (i) => i.eq("orgKey", org.key))
        .take(MAX_SUPPRESSIONS)
      // Removed whole on request: its page is a 404 (listedOrg).
      if (suppressed.some((row) => row.scope === "organisation")) continue
      const thin = isThinListing(
        await shownOrg(ctx, org, suppressed, contacts, names),
        await hasPublicEvents(ctx, org.key, removed),
      )
      page.push({
        slug: card.slug,
        kind,
        updatedAt: Math.max(card.updatedAt, org.updatedAt),
        indexable: !thin,
      })
    }
    const end = offset + slice.length
    return { page, isDone: end >= all.length, continueCursor: String(end) }
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
          card: publicCard(await orgCardPublic(ctx, card), contacts, names),
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
        publicCard(await orgCardPublic(ctx, card), contacts, names),
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
 * see (public; `cam_only` too for a verified @cam.ac.uk viewer; never a
 * talks.cam-derived one, G1), and its public relationships with the
 * counterpart's name. Null when no such slug, or when the broker has hidden
 * the listing.
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
      /** Whether it has any public event, past or upcoming (owner decision
       * G3: a profile without one, a description or a website is noindex).
       * Visitor-independent, unlike `events`. */
      hasPublicEvents: v.optional(v.boolean()),
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
      // A talks.cam-derived event never reaches a server render outside /talks
      // (owner decision G1, lib/talks-boundary.ts), and this list is the
      // profile's: it is left out here, where the rule sees every field, not
      // in the page, which sees a list item's few.
      if (
        event &&
        tiers.includes(event.visibility as never) &&
        !isTalksDerivedEvent(event) &&
        !(await withdrawn(event))
      ) {
        events.push(await eventListItem(event, lookup))
      }
    }
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)

    // Every text, conflict reading and session or event of the listing: no
    // address or name removed on request, wherever it was quoted
    // (lib/suppressions.ts), and nothing from talks.cam (owner decision G1,
    // lib/directory-talks-guard.ts): talks.cam events, links, sources and
    // values read from it. Applied here so every caller is covered, not
    // only the profile page.
    return withoutTalksCam(
      scrubAddresses(
        {
          org: await shownOrg(ctx, org, suppressed, contacts, names),
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
          hasPublicEvents: await hasPublicEvents(ctx, org.key, removed),
        },
        contacts,
        names,
      ),
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
      // An edge seen only on talks.cam pages rests on talks.cam alone, and
      // this renders on /societies/<slug>, outside /talks (owner decision G1):
      // it is left out, as the directory guard (lib/directory-talks-guard.ts)
      // drops a relationship whose evidence was all talks.cam.
      if (
        edge.evidence.length > 0 &&
        edge.evidence.every((entry) => isTalksCamUrl(entry.sourceUrl))
      ) {
        continue
      }
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
        // event may be in a tier this viewer cannot see). A talks.cam page
        // never (owner decision G1).
        evidence: edge.evidence
          .filter((entry) => isHttpUrl(entry.sourceUrl) && !isTalksCamUrl(entry.sourceUrl))
          .map(({ sourceUrl, seenAt }) => ({ sourceUrl, seenAt })),
      })
    }
  }
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

/** A Finder answer list: a few short ids per question. */
const finderAnswersValidator = v.record(v.string(), v.array(v.string()))

/**
 * The Society Finder (ENG-128): the listings that best fit a student's quiz
 * answers, best first, with why each fits (lib/finder.ts `rankSocieties`).
 * The directory's own rules (no counterparts, nothing archived) and the same
 * public projection as the hubs. Answers are arguments only, never stored.
 */
export const finder = query({
  args: { answers: finderAnswersValidator, collegeKey: v.optional(v.string()) },
  returns: v.array(
    v.object({
      key: v.string(),
      slug: v.string(),
      name: v.string(),
      shortDescription: v.optional(v.string()),
      categories: orgCardPublicValidator.fields.categories,
      collegeKeys: v.array(v.string()),
      reasons: v.array(v.string()),
      /** Events in the window below; `inTerm` says which window it is. */
      upcoming: v.number(),
      inTerm: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const answers = Object.fromEntries(
      Object.entries(args.answers)
        .slice(0, 8)
        .map(([id, values]) => [
          id.slice(0, 20),
          values.slice(0, 20).map((value) => value.slice(0, 40)),
        ]),
    )
    const cards = (await candidates(ctx, undefined)).filter((card) => matches(card, selections({})))
    // Events this term (or the next eight weeks in a vacation), the same
    // count the directory sorts by: a match that is doing things fills the
    // student's calendar.
    const window = activityWindow(await loadTerms(ctx), Date.now())
    const counts = await windowCounts(ctx, window, await loadSuppressedEvents(ctx))
    const facts: (SocietyFacts & { slug: string })[] = cards.map((card) => ({
      upcoming: counts.get(card.key) ?? 0,
      key: card.key,
      slug: card.slug,
      name: card.name,
      categories: card.categories,
      activityTypes: card.activityTypes,
      audiences: card.audiences,
      beginnerFriendly: card.beginnerFriendly,
      level: card.level,
      collegeKeys: card.collegeKeys,
      status: card.status,
      shortDescription: card.shortDescription,
      blueStatus: card.sport?.blueStatus,
    }))
    const ranked = rankSocieties(facts, answers, args.collegeKey, FINDER_RESULTS)
    const contacts = await loadContactHashes(ctx)
    const names = await loadNameHashes(ctx)
    return ranked.map(({ item, reasons }) => {
      const card = item as SocietyFacts & { slug: string }
      return {
        ...publicCard(
          {
            key: card.key,
            slug: card.slug,
            name: card.name,
            shortDescription: card.shortDescription,
            categories: [...card.categories],
            collegeKeys: [...card.collegeKeys],
          },
          contacts,
          names,
        ),
        reasons,
        upcoming: card.upcoming ?? 0,
        inTerm: window.inTerm,
      }
    })
  },
})
