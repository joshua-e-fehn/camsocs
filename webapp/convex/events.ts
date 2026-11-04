import { type Infer, v } from "convex/values"
import { addDays, isoDateMs, londonMidnight, startOfWeek } from "../lib/calendar"
import { isTalksDerivedEvent } from "../lib/talks-boundary"
import { CATEGORIES, EVENT_TYPES, type EventVisibility } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import {
  DAY_MS,
  type EventStream,
  eventStreamOf,
  isUniversityListing,
  londonIsoDate,
} from "./lib/derived"
import { withdrawnCheck } from "./lib/entityStore"
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
import { literalUnion } from "./lib/validators"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * The public events calendar (docs/webapp.md "Public API").
 *
 * Visibility gate, applied in every function here: `public` events for
 * everyone; `cam_only` (mailing-list events) only for a verified @cam.ac.uk
 * viewer or the broker; `members_only` never. An event whose every organiser
 * and co-host is hidden (a remove / object request) is not shown either, nor
 * a future event its listing no longer shows (lib/derived.ts `isWithdrawn`).
 *
 * The talks boundary (owner decision G1, lib/talks-boundary.ts): a
 * talks.cam-derived society event is left out of `list` unless the caller
 * asks with `talksCam`. Server renders outside /talks never ask, so no such
 * title reaches their HTML or RSC payload; the calendar adds them in the
 * browser after hydration, and their pages live under /talks (`locate`).
 */

/** Whether `list` leaves talks.cam-derived events out (the default), returns
 * only them, or returns everything. */
const talksCamMode = v.union(v.literal("exclude"), v.literal("only"), v.literal("include"))

/** The talks boundary's rule over a stored event (every field it reads). */
export function isTalksDerived(event: Doc<"events">): boolean {
  return isTalksDerivedEvent(event)
}

/** The widest window one call may ask for — a month view plus margins is ~6 weeks. */
export const MAX_WINDOW_MS = 186 * DAY_MS
const MAX_EVENTS = 1_000
/** Multi-day events still running at a window's start: few at any time. */
const MAX_SPANNING = 200

const listArgs = {
  /** Epoch ms, inclusive. */
  from: v.number(),
  /** Epoch ms, exclusive; at most 186 days after `from`. */
  to: v.number(),
  categories: v.optional(v.array(literalUnion(CATEGORIES))),
  eventTypes: v.optional(v.array(literalUnion(EVENT_TYPES))),
  /** Only events this organisation organised, co-hosted or sponsored. */
  orgKey: v.optional(v.string()),
  /** Every word must appear in the title (case-insensitive). */
  q: v.optional(v.string()),
  /** Only events whose organisers belong to one of these colleges. */
  collegeKeys: v.optional(v.array(v.string())),
  /** `false` leaves out events societies only take part in (`hosting:
   * takes_part`, decision D6); they are included by default. */
  includeTakingPart: v.optional(v.boolean()),
  /** talks.cam-derived events (G1): `exclude` by default — never anything
   * else in a server render outside /talks. */
  talksCam: v.optional(talksCamMode),
  /** The University's own listings (ENG-24, lib/derived.ts
   * `isUniversityListing`): `hide` leaves them out, `only` lists nothing
   * else; both kinds by default. Read by stream index (ENG-31). */
  university: v.optional(v.union(v.literal("hide"), v.literal("only"))),
}
const listArgsObject = v.object(listArgs)
type ListArgs = Infer<typeof listArgsObject>

/** The streams (`events.stream`, ENG-31) a `university` argument reads. */
function streamsOf(university: ListArgs["university"]): EventStream[] {
  if (university === "hide") return ["society"]
  if (university === "only") return ["university"]
  return ["society", "university"]
}

/**
 * The 1,000-row cap, society events first (ENG-31): every society event of
 * the window up to the cap, then the University's listings in the room left,
 * each by start time. A Cambridge Festival week of University listings can
 * then crowd out only its own later days, never a society's event; the
 * University view (`university: "only"`) has the whole cap to itself.
 */
function capByStream(sorted: Doc<"events">[]): Doc<"events">[] {
  const society = sorted.filter((event) => eventStreamOf(event) === "society")
  const kept = society.slice(0, MAX_EVENTS)
  const university = sorted
    .filter((event) => eventStreamOf(event) === "university")
    .slice(0, MAX_EVENTS - kept.length)
  return [...kept, ...university].sort((a, b) => a.startsAt - b.startsAt)
}

/** Whether an event is on screen in [from, to): it starts inside, or it is a
 * multi-day event that started earlier and is still running at `from`. */
function overlaps(event: Doc<"events">, from: number, to: number): boolean {
  if (event.startsAt >= from && event.startsAt < to) return true
  return event.spanEndsAt !== undefined && event.startsAt < to && event.spanEndsAt > from
}

/**
 * Whether an event is still public given its hosts: not when every
 * organisation that organised or co-hosted it is hidden (`broker.orgs.
 * setHidden` after a remove / object request; a hidden organisation has no
 * card). An event nobody is credited with stays.
 */
export async function hostsListed(
  event: Doc<"events">,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<boolean> {
  const hosts = [...event.organiserKeys, ...event.coHostKeys]
  if (hosts.length === 0) return true
  for (const key of hosts) if (await lookup(key)) return true
  return false
}

async function eventByKey(ctx: QueryCtx, key: string): Promise<Doc<"events"> | null> {
  return await ctx.db
    .query("events")
    .withIndex("by_key", (i) => i.eq("key", key))
    .unique()
}

/**
 * The events in `tiers` matching the filters, by start time (≤ 1000, society
 * events first: `capByStream`). The caller decides the tiers from the
 * viewer; this function never widens them.
 */
async function matchingEvents(
  ctx: QueryCtx,
  args: ListArgs,
  tiers: readonly EventVisibility[],
  lookup: ReturnType<typeof orgRefCache>,
): Promise<Doc<"events">[]> {
  if (!(args.to > args.from)) throw new Error("`to` must be after `from`")
  if (args.to - args.from > MAX_WINDOW_MS) throw new Error("The window is limited to 186 days")

  const byKey = new Map<string, Doc<"events">>()
  if (args.orgKey) {
    const orgKey = args.orgKey
    // A hidden (or unknown) organisation has no card and no public events.
    if (!(await lookup(orgKey))) return []
    const [starting, spanning] = await Promise.all([
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_startsAt", (i) =>
          i.eq("orgKey", orgKey).gte("startsAt", args.from).lt("startsAt", args.to),
        )
        .take(MAX_EVENTS),
      ctx.db
        .query("eventOrganisers")
        .withIndex("by_org_spanEndsAt", (i) => i.eq("orgKey", orgKey).gt("spanEndsAt", args.from))
        .take(MAX_SPANNING),
    ])
    for (const link of [...starting, ...spanning]) {
      if (byKey.has(link.eventKey)) continue
      const event = await eventByKey(ctx, link.eventKey)
      if (event) byKey.set(event.key, event)
    }
  } else {
    // One index range per tier and stream (ENG-31), so neither stream's rows
    // count against the other's `.take`. The `undefined` range holds rows
    // written before `stream` existed and not yet backfilled (derive.ts
    // `recomputeEvents`): the filter below classifies them, and once the
    // backfill has run the range is empty.
    const streams: (EventStream | undefined)[] = [...streamsOf(args.university), undefined]
    const reads = tiers.flatMap((tier) =>
      streams.flatMap((stream) => [
        ctx.db
          .query("events")
          .withIndex("by_stream_visibility_startsAt", (i) =>
            i
              .eq("stream", stream)
              .eq("visibility", tier)
              .gte("startsAt", args.from)
              .lt("startsAt", args.to),
          )
          .take(MAX_EVENTS),
        ctx.db
          .query("events")
          .withIndex("by_stream_visibility_spanEndsAt", (i) =>
            i.eq("stream", stream).eq("visibility", tier).gt("spanEndsAt", args.from),
          )
          .take(MAX_SPANNING),
      ]),
    )
    for (const event of (await Promise.all(reads)).flat()) byKey.set(event.key, event)
  }

  // The window is applied before any text match, so a search finds this
  // window's events however many older ones share the words.
  const words = (args.q ?? "").trim().slice(0, 200).toLowerCase().split(/\s+/).filter(Boolean)
  const types = args.eventTypes?.length ? new Set<string>(args.eventTypes) : null
  const talksCam = args.talksCam ?? "exclude"
  let events = [...byKey.values()].filter(
    (event) =>
      overlaps(event, args.from, args.to) &&
      tiers.includes(event.visibility) &&
      (talksCam === "include" || isTalksDerived(event) === (talksCam === "only")) &&
      (args.includeTakingPart !== false || event.hosting !== "takes_part") &&
      (!types || types.has(event.eventType)) &&
      (!args.university || (args.university === "only") === isUniversityListing(event)) &&
      words.every((word) => event.title.toLowerCase().includes(word)),
  )
  events = capByStream(events.sort((a, b) => a.startsAt - b.startsAt))

  const categories = args.categories?.length ? new Set<string>(args.categories) : null
  const colleges = args.collegeKeys?.length ? new Set(args.collegeKeys) : null
  const withdrawn = withdrawnCheck(ctx, Date.now())
  const out: Doc<"events">[] = []
  for (const event of events) {
    if (!(await hostsListed(event, lookup)) || (await withdrawn(event))) continue
    if (categories || colleges) {
      const hosts = [...event.organiserKeys, ...event.coHostKeys]
      let ok = false
      for (const key of hosts) {
        const card = await lookup(key)
        if (!card) continue
        const categoryOk = !categories || card.categories.some((c) => categories.has(c))
        const collegeOk = !colleges || card.collegeKeys.some((c) => colleges.has(c))
        if (categoryOk && collegeOk) {
          ok = true
          break
        }
      }
      if (!ok) continue
    }
    out.push(event)
  }
  return out
}

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

/**
 * The event behind a key if a viewer with `tiers` may see it, else null: the
 * visibility gate above, plus the suppression list — an event, an address or
 * a name removed on request never shows, even before the walk that sets its
 * claims aside reaches this event (lib/suppressions.ts).
 */
async function shownEvent(
  ctx: QueryCtx,
  key: string,
  tiers: readonly EventVisibility[],
  lookup: ReturnType<typeof orgRefCache>,
): Promise<Doc<"events"> | null> {
  const event = await eventByKey(ctx, key)
  if (!event || !tiers.includes(event.visibility)) return null
  if (!(await hostsListed(event, lookup))) return null
  if (await withdrawnCheck(ctx, Date.now())(event)) return null
  if ((await loadSuppressedEvents(ctx)).has(event.key)) return null
  return event
}

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

/**
 * Where `/events/<key>` should answer, for the request-time gate in
 * `proxy.ts` (ENG-20, owner decision G1): `missing` (a real 404, as
 * `exists` is false), `talks` (a talks.cam-derived event, whose page is
 * `/talks/events/<key>`: a 308 there), else `event`. Viewer-independent, as
 * `exists`.
 */
export const locate = query({
  args: { key: v.string() },
  returns: v.union(v.literal("missing"), v.literal("event"), v.literal("talks")),
  handler: async (ctx, args) => {
    const event = await shownEvent(ctx, args.key, ["public", "cam_only"], orgRefCache(ctx))
    if (!event) return "missing" as const
    return isTalksDerived(event) ? ("talks" as const) : ("event" as const)
  },
})
