import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { eventCardOf, withdrawnCheck } from "./lib/entityStore"
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
 * Only public editions are ever read here (`gate`): never `cam_only`
 * (whatever the viewer — these pages are cached for everyone), never
 * `members_only`, never a superseded, withdrawn or suppressed event, never
 * one whose hosts are all hidden, and never a talks.cam-derived one (G1;
 * `eventSeriesOf` gives those no series, and this re-checks the stored
 * event). A series is itself hidden (`seriesShown`) when its organiser is no
 * longer listed, or when it holds editions and none may be shown: its stored
 * name is then a hidden event's title, less the year.
 */

/** Editions read per series: a long run (a panto's nights) is one edition each night. */
const MAX_EDITIONS = 300
/** Series listed at most on the index and in the sitemap. */
const MAX_SERIES = 1_000

const orgRefValidator = v.object({ name: v.string(), slug: v.string() })

const seriesRefValidator = v.object({
  slug: v.string(),
  name: v.string(),
  /** The organising listing, when the series has one and it is listed. */
  org: v.optional(orgRefValidator),
  lastStartsAt: v.number(),
})

type Gate = {
  lookup: ReturnType<typeof orgRefCache>
  removed: Set<string>
  withdrawn: ReturnType<typeof withdrawnCheck>
}

async function gateOf(ctx: QueryCtx): Promise<Gate> {
  return {
    lookup: orgRefCache(ctx),
    removed: await loadSuppressedEvents(ctx),
    withdrawn: withdrawnCheck(ctx, Date.now()),
  }
}

/** Whether a stored edition may be shown: the one rule for every query here. */
async function shownEdition(gate: Gate, event: Doc<"events">, seriesKey: string): Promise<boolean> {
  if (event.visibility !== "public" || event.supersededBy || gate.removed.has(event.key)) {
    return false
  }
  if (eventSeriesOf(event)?.key !== seriesKey) return false
  if (!(await hostsListed(event, gate.lookup))) return false
  return !(await gate.withdrawn(event))
}

/** A series' stored editions (shown or not), oldest first. */
async function heldEditions(ctx: QueryCtx, seriesKey: string): Promise<Doc<"events">[]> {
  return await ctx.db
    .query("events")
    .withIndex("by_seriesKey_startsAt", (i) => i.eq("seriesKey", seriesKey))
    .take(MAX_EDITIONS)
}

/** A series' shown editions, by start, oldest first, or null when the series
 * itself is hidden (see the module comment). */
async function seriesShown(
  ctx: QueryCtx,
  gate: Gate,
  row: Doc<"eventSeries">,
): Promise<{ org?: { name: string; slug: string }; editions: Doc<"events">[] } | null> {
  let org: { name: string; slug: string } | undefined
  if (row.orgKey) {
    const card = await gate.lookup(row.orgKey)
    if (!card) return null
    org = { name: card.name, slug: card.slug }
  }
  const held = await heldEditions(ctx, row.key)
  const editions: Doc<"events">[] = []
  for (const event of held) if (await shownEdition(gate, event, row.key)) editions.push(event)
  // Editions held but none shown (suppressed, no longer public, withdrawn,
  // hosts hidden): the stored name would be the only trace, so hide it. A
  // series with nothing held (retention took its editions) keeps its page.
  if (held.length > 0 && editions.length === 0) return null
  return { org, editions }
}

/** Every series, by name (the `/events/series` index and pages.xml). */
export const list = query({
  args: {},
  returns: v.array(
    v.object({ ...seriesRefValidator.fields, nextStartsAt: v.optional(v.number()) }),
  ),
  handler: async (ctx) => {
    const gate = await gateOf(ctx)
    const rows = await ctx.db.query("eventSeries").take(MAX_SERIES)
    const now = Date.now()
    const out = []
    for (const row of rows) {
      const shown = await seriesShown(ctx, gate, row)
      if (!shown) continue
      const next = shown.editions.find((event) => (event.endsAt ?? event.startsAt) >= now)
      out.push({
        slug: row.slug,
        name: row.name,
        org: shown.org,
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
    const gate = await gateOf(ctx)
    const shown = await seriesShown(ctx, gate, row)
    if (!shown) return null
    const [contacts, names] = await Promise.all([loadContactHashes(ctx), loadNameHashes(ctx)])
    const editions: EventListItem[] = []
    for (const event of shown.editions) {
      editions.push(
        scrubAddresses(await eventListItem(eventCardOf(event), gate.lookup), contacts, names),
      )
    }
    return {
      series: { slug: row.slug, name: row.name, org: shown.org, lastStartsAt: row.lastStartsAt },
      editions,
    }
  },
})

/** The series an event's page links to, or null (a one-off, an event not
 * shown, or no row yet). */
export const ofEvent = query({
  args: { key: v.string() },
  returns: v.union(v.null(), v.object({ slug: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (i) => i.eq("key", args.key))
      .unique()
    const seriesKey = event?.seriesKey
    if (!event || !seriesKey) return null
    const gate = await gateOf(ctx)
    if (!(await shownEdition(gate, event, seriesKey))) return null
    const row = await ctx.db
      .query("eventSeries")
      .withIndex("by_key", (i) => i.eq("key", seriesKey))
      .unique()
    if (!row || !(await seriesShown(ctx, gate, row))) return null
    return { slug: row.slug, name: row.name }
  },
})
