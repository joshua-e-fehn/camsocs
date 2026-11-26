import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { withdrawnCheck } from "./lib/entityStore"
import { eventSeriesOf } from "./lib/eventSeries"
import { hostsListed } from "./lib/eventWindow"
import {
  type EventListItem,
  eventListItem,
  eventListItemValidator,
  orgRefCache,
} from "./lib/projections"
import {
  loadContactHashes,
  loadNameHashes,
  loadSuppressedEvents,
  scrubAddresses,
} from "./lib/suppressions"

/**
 * Recurring event series (ENG-282, docs/webapp.md "Event series"): one page
 * per series at `/events/series/<slug>`, whatever year it is.
 *
 * Only public editions are ever read here: never `cam_only` (whatever the
 * viewer — these pages are cached for everyone), never `members_only`, never
 * a superseded, withdrawn or suppressed event, never one whose hosts are all
 * hidden, and never a talks.cam-derived one (G1; `eventSeriesOf` gives those
 * no series, and this re-checks the stored event).
 */

/** Editions read per series: a long run (a panto's nights) is one edition each night. */
const MAX_EDITIONS = 300
/** Series listed at most on the index and in the sitemap. */
const MAX_SERIES = 1_000
/** Upcoming rows read to find a series' next public edition. */
const NEXT_SCAN = 20

const orgRefValidator = v.object({ name: v.string(), slug: v.string() })

const seriesRefValidator = v.object({
  slug: v.string(),
  name: v.string(),
  /** The organising listing, when the series has one and it is listed. */
  org: v.optional(orgRefValidator),
  lastStartsAt: v.number(),
})

async function orgOf(
  lookup: ReturnType<typeof orgRefCache>,
  row: Doc<"eventSeries">,
): Promise<{ name: string; slug: string } | undefined> {
  if (!row.orgKey) return undefined
  const card = await lookup(row.orgKey)
  return card ? { name: card.name, slug: card.slug } : undefined
}

/** Whether a stored edition may be shown on a series page. */
function shownEdition(event: Doc<"events">, seriesKey: string, removed: Set<string>): boolean {
  return (
    event.visibility === "public" &&
    !event.supersededBy &&
    !removed.has(event.key) &&
    eventSeriesOf(event)?.key === seriesKey
  )
}

/** A series' shown editions, by start, oldest first. */
async function editionsOf(
  ctx: QueryCtx,
  seriesKey: string,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<Doc<"events">[]> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_seriesKey_startsAt", (i) => i.eq("seriesKey", seriesKey))
    .take(MAX_EDITIONS)
  const withdrawn = withdrawnCheck(ctx, Date.now())
  const removed = await loadSuppressedEvents(ctx)
  const out: Doc<"events">[] = []
  for (const event of rows) {
    if (!shownEdition(event, seriesKey, removed)) continue
    if (!(await hostsListed(event, lookup))) continue
    if (await withdrawn(event)) continue
    out.push(event)
  }
  return out
}

/** Every series, by name (the `/events/series` index and pages.xml). */
export const list = query({
  args: {},
  returns: v.array(
    v.object({ ...seriesRefValidator.fields, nextStartsAt: v.optional(v.number()) }),
  ),
  handler: async (ctx) => {
    const lookup = orgRefCache(ctx)
    const rows = await ctx.db.query("eventSeries").take(MAX_SERIES)
    const removed = await loadSuppressedEvents(ctx)
    const now = Date.now()
    const out = []
    for (const row of rows) {
      const upcoming = await ctx.db
        .query("events")
        .withIndex("by_seriesKey_startsAt", (i) => i.eq("seriesKey", row.key).gte("startsAt", now))
        .take(NEXT_SCAN)
      const next = upcoming.find((event) => shownEdition(event, row.key, removed))
      out.push({
        slug: row.slug,
        name: row.name,
        org: await orgOf(lookup, row),
        lastStartsAt: row.lastStartsAt,
        nextStartsAt: next?.startsAt,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "en-GB"))
  },
})

/** One series and its editions still held (events go a year after they end). */
export const get = query({
  args: { slug: v.string() },
  returns: v.union(
    v.null(),
    v.object({ series: seriesRefValidator, editions: v.array(eventListItemValidator) }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("eventSeries")
      .withIndex("by_slug", (i) => i.eq("slug", args.slug))
      .unique()
    if (!row) return null
    const lookup = orgRefCache(ctx)
    const [contacts, names] = await Promise.all([loadContactHashes(ctx), loadNameHashes(ctx)])
    const editions: EventListItem[] = []
    for (const event of await editionsOf(ctx, row.key, lookup)) {
      editions.push(scrubAddresses(await eventListItem(event, lookup), contacts, names))
    }
    return {
      series: {
        slug: row.slug,
        name: row.name,
        org: await orgOf(lookup, row),
        lastStartsAt: row.lastStartsAt,
      },
      editions,
    }
  },
})

/** The series an event's page links to, or null (a one-off, or no row yet). */
export const ofEvent = query({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ slug: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (i) => i.eq("key", args.key))
      .unique()
    const seriesKey = event?.seriesKey
    if (!event || !seriesKey || !shownEdition(event, seriesKey, new Set())) return null
    const row = await ctx.db
      .query("eventSeries")
      .withIndex("by_key", (i) => i.eq("key", seriesKey))
      .unique()
    return row ? { slug: row.slug, name: row.name } : null
  },
})
