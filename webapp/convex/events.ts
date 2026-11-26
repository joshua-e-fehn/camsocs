import { v } from "convex/values"
import { addDays, isoDateMs, londonMidnight, startOfWeek } from "../lib/calendar"
import type { EventVisibility } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { DAY_MS, londonIsoDate } from "./lib/derived"
import type { EventCard } from "./lib/entityStore"
import {
  eventByKey,
  hostsListed,
  isTalksDerived,
  listArgs,
  MAX_WINDOW_MS,
  matchingEvents,
  shownEvent,
} from "./lib/eventWindow"
import {
  type EventListItem,
  eventListItem,
  eventListItemValidator,
  eventPublic,
  eventPublicValidator,
  orgRefCache,
} from "./lib/projections"
import {
  loadContactHashes,
  loadNameHashes,
  loadSuppressedEvents,
  scrubAddresses,
} from "./lib/suppressions"
import { getViewer, visibleEventTiers } from "./lib/viewer"

// Shared with convex/eventFeed.ts, convex/sitemap.ts and convex/map.ts; the
// window read itself lives in convex/lib/eventWindow.ts.
export { hostsListed, isTalksDerived, MAX_WINDOW_MS }

/**
 * The public events calendar (docs/webapp.md "Public API").
 *
 * Visibility gate, applied in every function here: `public` events for
 * everyone; `cam_only` (mailing-list events) only for a verified @cam.ac.uk
 * viewer or the broker; `members_only` never. An event whose every organiser
 * and co-host is hidden (a remove / object request) is not shown either, nor
 * a future event its listing no longer shows (lib/derived.ts `isWithdrawn`),
 * nor one another source's event superseded (`supersededBy`, ENG-47).
 *
 * The talks boundary (owner decision G1, lib/talks-boundary.ts): a
 * talks.cam-derived society event is left out of `list` unless the caller
 * asks with `talksCam`. Server renders outside /talks never ask, so no such
 * title reaches their HTML or RSC payload; the calendar adds them in the
 * browser after hydration, and their pages live under /talks (`locate`).
 */

/** The events of a window, as list items (`events.get` has the details). */
export const list = query({
  args: listArgs,
  returns: v.array(eventListItemValidator),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const events = await matchingEvents(ctx, args, tiers, lookup)
    const [contacts, names, removed] = await Promise.all([
      loadContactHashes(ctx),
      loadNameHashes(ctx),
      loadSuppressedEvents(ctx),
    ])
    const out: EventListItem[] = []
    for (const event of events) {
      if (removed.has(event.key)) continue
      out.push(scrubAddresses(await eventListItem(event, lookup), contacts, names))
    }
    return out
  },
})

/**
 * A personal feed's events (ENG-129, `/events.ics?f=<id>`): the public
 * events of every listing the feed follows in the window, by start time,
 * through the same per-organisation read and the same rules as `list`
 * (never talks.cam-derived, never "taking part" only, suppressed ones out).
 * Null for an unknown feed.
 */
export const feed = query({
  args: { feedId: v.string(), from: v.number(), to: v.number() },
  returns: v.union(v.null(), v.array(eventListItemValidator)),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarFeeds")
      .withIndex("by_feedId", (i) => i.eq("feedId", args.feedId))
      .unique()
    if (!row) return null
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const byKey = new Map<string, EventCard>()
    for (const orgKey of row.orgKeys) {
      const events = await matchingEvents(
        ctx,
        { from: args.from, to: args.to, orgKey, includeTakingPart: false },
        tiers,
        lookup,
      )
      for (const event of events) byKey.set(event.key, event)
    }
    const [contacts, names, removed] = await Promise.all([
      loadContactHashes(ctx),
      loadNameHashes(ctx),
      loadSuppressedEvents(ctx),
    ])
    const out: EventListItem[] = []
    for (const event of [...byKey.values()].sort((a, b) => a.startsAt - b.startsAt)) {
      if (removed.has(event.key)) continue
      out.push(scrubAddresses(await eventListItem(event, lookup), contacts, names))
    }
    return out
  },
})

/** The coarsest window `restrictedCount` answers for: whole London weeks
 * (Monday first), at least one — four with an organisation — and never more
 * than `MAX_WINDOW_MS`. */
function weekWindow(from: number, to: number, minWeeks: number): { from: number; to: number } {
  const first = startOfWeek(londonIsoDate(from))
  const lastWeek = startOfWeek(londonIsoDate(Math.max(from, to - 1)))
  const maxWeeks = Math.floor(MAX_WINDOW_MS / (7 * DAY_MS))
  const spanned = Math.round((isoDateMs(lastWeek) - isoDateMs(first)) / (7 * DAY_MS)) + 1
  const weeks = Math.min(maxWeeks, Math.max(minWeeks, spanned))
  return { from: londonMidnight(first), to: londonMidnight(addDays(first, weeks * 7)) }
}

/**
 * How many `cam_only` events are hidden from this viewer around the dates
 * asked for — for the calendar's "N Cambridge-only events in these weeks,
 * sign in with your @cam.ac.uk email" note. 0 for a viewer who can already
 * see them.
 *
 * Deliberately coarse, so the count cannot be used to read what it counts:
 * text, type, category and college filters are ignored (a count per search
 * word would spell out titles), and the window is widened to whole weeks —
 * at least four for one organisation — so start times cannot be bisected.
 */
export const restrictedCount = query({
  args: listArgs,
  returns: v.object({ camOnly: v.number() }),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    if (tiers.includes("cam_only")) return { camOnly: 0 }
    if (!(args.to > args.from)) throw new Error("`to` must be after `from`")
    const window = weekWindow(args.from, args.to, args.orgKey ? 4 : 1)
    const hidden = await matchingEvents(
      ctx,
      // A count only, so talks.cam-derived events may count (G1 is about
      // text): the calendar shows them after hydration, so it counts them
      // (the default); a society profile never lists them, so it asks
      // `exclude` and its hint counts only what signing in would show there.
      { ...window, orgKey: args.orgKey, talksCam: args.talksCam ?? "include" },
      ["cam_only"],
      orgRefCache(ctx),
    )
    return { camOnly: hidden.length }
  },
})

/** One event, or null when it does not exist or the viewer may not see it. */
export const get = query({
  args: { key: v.string() },
  returns: v.union(v.null(), eventPublicValidator),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const event = await shownEvent(ctx, args.key, tiers, lookup)
    if (!event) return null
    return scrubAddresses(
      await eventPublic(ctx, event, lookup),
      await loadContactHashes(ctx),
      await loadNameHashes(ctx),
    )
  },
})

/**
 * The title the request form shows for the event a request is about
 * (`/request?event=…`, event-correction-link): what `get` shows this viewer,
 * or null when it would show nothing, and null for a talks.cam-derived event,
 * named by its key alone outside /talks (owner decision G1,
 * lib/talks-boundary.ts). The form reads this rather than `get`, so no
 * talks.cam text reaches a page outside /talks even in the browser (review of
 * 2026-11-03, g1-client-fetch).
 */
export const requestLabel = query({
  args: { key: v.string() },
  returns: v.object({ title: v.union(v.null(), v.string()) }),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const event = await shownEvent(ctx, args.key, tiers, lookup)
    if (!event || isTalksDerived(event)) return { title: null }
    const shown = scrubAddresses(
      await eventPublic(ctx, event, lookup),
      await loadContactHashes(ctx),
      await loadNameHashes(ctx),
    )
    return { title: shown.talksDerived ? null : shown.title }
  },
})

/**
 * Whether `/events/<key>` has an event to show to someone (ENG-20): the
 * request-time gate in `proxy.ts` answers anything else with a real 404
 * before the page streams. True for an event a verified @cam.ac.uk viewer
 * would see, so a Cambridge-only event keeps its "not available, sign in"
 * page for everyone else (`get` decides that per viewer); a `members_only`,
 * withdrawn or suppressed event, or one whose hosts are all hidden, is as
 * absent as an unknown key. Viewer-independent by design.
 */
export const exists = query({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    (await shownEvent(ctx, args.key, ["public", "cam_only"], orgRefCache(ctx))) !== null,
})

/** Retirements `locate` follows from a superseded key to the event shown in
 * its place (a page folded into a feed, the feed into the University's
 * listing); a longer chain, or a loop, is a 404. */
const MAX_SUPERSEDED_HOPS = 3

/**
 * The event shown in place of a superseded key (ENG-47,
 * convex/ingest/superseded.ts), or null: the key's event must exist, be one
 * that a verified @cam.ac.uk viewer could see and not be suppressed, and the
 * chain of `supersededBy` must end at an event `shownEvent` shows.
 */
async function survivorOf(
  ctx: QueryCtx,
  key: string,
  tiers: readonly EventVisibility[],
  lookup: ReturnType<typeof orgRefCache>,
): Promise<Doc<"events"> | null> {
  const event = await eventByKey(ctx, key)
  if (!event?.supersededBy || !tiers.includes(event.visibility)) return null
  if ((await loadSuppressedEvents(ctx)).has(event.key)) return null
  const visited = new Set([event.key])
  let next: string | undefined = event.supersededBy
  for (let hop = 0; hop < MAX_SUPERSEDED_HOPS && next && !visited.has(next); hop++) {
    const shown = await shownEvent(ctx, next, tiers, lookup)
    if (shown) return shown
    visited.add(next)
    next = (await eventByKey(ctx, next))?.supersededBy
  }
  return null
}

/**
 * Where `/events/<key>` should answer, for the request-time gate in
 * `proxy.ts` (ENG-20, owner decision G1): `missing` (a real 404, as
 * `exists` is false), `talks` (a talks.cam-derived event, whose page is
 * `/talks/events/<key>`: a 308 there), `{ supersededBy, talks }` (a key a
 * higher-ranked source took over, ENG-47: a 308 to the survivor's page, under
 * /talks when `talks`), else `event`. Viewer-independent, as `exists`.
 */
export const locate = query({
  args: { key: v.string() },
  returns: v.union(
    v.literal("missing"),
    v.literal("event"),
    v.literal("talks"),
    v.object({ supersededBy: v.string(), talks: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const tiers = ["public", "cam_only"] as const
    const lookup = orgRefCache(ctx)
    const event = await shownEvent(ctx, args.key, tiers, lookup)
    if (event) return isTalksDerived(event) ? ("talks" as const) : ("event" as const)
    const survivor = await survivorOf(ctx, args.key, tiers, lookup)
    if (!survivor) return "missing" as const
    return { supersededBy: survivor.key, talks: isTalksDerived(survivor) }
  },
})
