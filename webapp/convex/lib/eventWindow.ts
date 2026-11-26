import { type Infer, v } from "convex/values"
import { isTalksDerivedEvent } from "../../lib/talks-boundary"
import { CATEGORIES, EVENT_TYPES, type EventVisibility } from "../../lib/vocab"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { DAY_MS, type EventStream, eventStreamOf, isUniversityListing } from "./derived"
import { type EventCard, eventCardOf, eventCardsReady, withdrawnCheck } from "./entityStore"
import type { orgRefCache } from "./projections"
import { loadSuppressedEvents } from "./suppressions"
import { literalUnion } from "./validators"

/**
 * The public events window read, shared by `events.list` and friends
 * (convex/events.ts) and `map.day` (convex/map.ts): one place decides which
 * stored events a viewer's tiers, the talks boundary (G1), withdrawn and
 * superseded rows and hidden hosts leave out, and how multi-day events still
 * running at a window's start are read (the two-range read). Moved here
 * unchanged from convex/events.ts so the map cannot drift from the calendar.
 *
 * The window is read as list cards (`eventCards`, ENG-280: an event without
 * its `meta` and `description`, a quarter of its bytes) once every event has
 * one (`eventCardsReady`); until then from `events`, each turned into the
 * same card in memory. The rules below see the same fields either way.
 */

/** Whether `list` leaves talks.cam-derived events out (the default), returns
 * only them, or returns everything. */
export const talksCamMode = v.union(v.literal("exclude"), v.literal("only"), v.literal("include"))

/** The talks boundary's rule over a stored event (every field it reads). */
export function isTalksDerived(event: Doc<"events">): boolean {
  return isTalksDerivedEvent(event)
}

/** The widest window one call may ask for — a month view plus margins is ~6 weeks. */
export const MAX_WINDOW_MS = 186 * DAY_MS
export const MAX_EVENTS = 1_000
/** Multi-day events still running at a window's start: few at any time. */
export const MAX_SPANNING = 200

export const listArgs = {
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
export type ListArgs = Infer<typeof listArgsObject>

/**
 * The stream ranges (`events.stream`, ENG-31) a `university` argument reads,
 * in the order they share a tier's read budget (`tierRows`): society events
 * first, then rows not yet backfilled (`undefined`), then the University's.
 */
export function readOrder(university: ListArgs["university"]): (EventStream | undefined)[] {
  if (university === "hide") return ["society", undefined]
  if (university === "only") return [undefined, "university"]
  return ["society", undefined, "university"]
}

/**
 * One tier's rows for a window, every stream in `order` sharing one budget:
 * `MAX_EVENTS` starting and `MAX_SPANNING` spanning rows, each range taking
 * what the ranges before it left. That is the bound from before ENG-31, so a
 * list reads at most 1,200 events per tier (2,400 for a signed-in viewer's
 * two, ~11.5 MB at the 4.8 KB mean measured on dev) and stays inside Convex's
 * 16 MiB read limit per function. Society events read first, so University
 * listings never take their room; the University's get what is left, which
 * is what `capByStream` keeps unless filters below drop society rows read
 * here (then fewer University rows than the cap would allow, as before).
 */
export async function tierRows(
  ctx: QueryCtx,
  args: ListArgs,
  tier: EventVisibility,
  order: readonly (EventStream | undefined)[],
  cards: boolean,
): Promise<EventCard[]> {
  const rows: EventCard[] = []
  let starting = 0
  let spanning = 0
  for (const stream of order) {
    const [started, spans] = await Promise.all([
      starting < MAX_EVENTS
        ? startingRange(ctx, cards, stream, tier, args, MAX_EVENTS - starting)
        : [],
      spanning < MAX_SPANNING
        ? spanningRange(ctx, cards, stream, tier, args.from, MAX_SPANNING - spanning)
        : [],
    ])
    starting += started.length
    spanning += spans.length
    rows.push(...started, ...spans)
  }
  return rows
}

/** Events of one stream and tier starting in [from, to), as cards: from
 * `eventCards` when `cards`, else from `events` (the same index). */
async function startingRange(
  ctx: QueryCtx,
  cards: boolean,
  stream: EventStream | undefined,
  tier: EventVisibility,
  window: { from: number; to: number },
  limit: number,
): Promise<EventCard[]> {
  if (cards) {
    return await ctx.db
      .query("eventCards")
      .withIndex("by_stream_visibility_startsAt", (i) =>
        i
          .eq("stream", stream)
          .eq("visibility", tier)
          .gte("startsAt", window.from)
          .lt("startsAt", window.to),
      )
      .take(limit)
  }
  const events = await ctx.db
    .query("events")
    .withIndex("by_stream_visibility_startsAt", (i) =>
      i
        .eq("stream", stream)
        .eq("visibility", tier)
        .gte("startsAt", window.from)
        .lt("startsAt", window.to),
    )
    .take(limit)
  return events.map(eventCardOf)
}

/** Multi-day events of one stream and tier still running after `from`, as
 * cards (as `startingRange`). */
async function spanningRange(
  ctx: QueryCtx,
  cards: boolean,
  stream: EventStream | undefined,
  tier: EventVisibility,
  from: number,
  limit: number,
): Promise<EventCard[]> {
  if (cards) {
    return await ctx.db
      .query("eventCards")
      .withIndex("by_stream_visibility_spanEndsAt", (i) =>
        i.eq("stream", stream).eq("visibility", tier).gt("spanEndsAt", from),
      )
      .take(limit)
  }
  const events = await ctx.db
    .query("events")
    .withIndex("by_stream_visibility_spanEndsAt", (i) =>
      i.eq("stream", stream).eq("visibility", tier).gt("spanEndsAt", from),
    )
    .take(limit)
  return events.map(eventCardOf)
}

/** One event's card by key (as `startingRange`). */
async function cardByKey(ctx: QueryCtx, cards: boolean, key: string): Promise<EventCard | null> {
  if (cards) {
    return await ctx.db
      .query("eventCards")
      .withIndex("by_key", (i) => i.eq("key", key))
      .unique()
  }
  const event = await eventByKey(ctx, key)
  return event ? eventCardOf(event) : null
}

/**
 * The 1,000-row cap, society events first (ENG-31): every society event of
 * the window up to the cap, then the University's listings in the room left,
 * each by start time. A Cambridge Festival week of University listings can
 * then crowd out only its own later days, never a society's event; the
 * University view (`university: "only"`) has the whole cap to itself.
 */
export function capByStream<E extends EventCard>(sorted: E[]): E[] {
  const society = sorted.filter((event) => eventStreamOf(event) === "society")
  const kept = society.slice(0, MAX_EVENTS)
  const university = sorted
    .filter((event) => eventStreamOf(event) === "university")
    .slice(0, MAX_EVENTS - kept.length)
  return [...kept, ...university].sort((a, b) => a.startsAt - b.startsAt)
}

/** Whether an event is on screen in [from, to): it starts inside, or it is a
 * multi-day event that started earlier and is still running at `from`. */
export function overlaps(
  event: Pick<EventCard, "startsAt" | "spanEndsAt">,
  from: number,
  to: number,
): boolean {
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
  event: Pick<EventCard, "organiserKeys" | "coHostKeys">,
  lookup: ReturnType<typeof orgRefCache>,
): Promise<boolean> {
  const hosts = [...event.organiserKeys, ...event.coHostKeys]
  if (hosts.length === 0) return true
  for (const key of hosts) if (await lookup(key)) return true
  return false
}

export async function eventByKey(ctx: QueryCtx, key: string): Promise<Doc<"events"> | null> {
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
export async function matchingEvents(
  ctx: QueryCtx,
  args: ListArgs,
  tiers: readonly EventVisibility[],
  lookup: ReturnType<typeof orgRefCache>,
): Promise<EventCard[]> {
  if (!(args.to > args.from)) throw new Error("`to` must be after `from`")
  if (args.to - args.from > MAX_WINDOW_MS) throw new Error("The window is limited to 186 days")

  const cards = await eventCardsReady(ctx)
  const byKey = new Map<string, EventCard>()
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
      const event = await cardByKey(ctx, cards, link.eventKey)
      if (event) byKey.set(event.key, event)
    }
  } else {
    // One index range per tier and stream (ENG-31), society first, so the
    // University's listings never use up a society event's room. The
    // `undefined` range holds rows written before `stream` existed and not
    // yet backfilled (derive.ts `recomputeEvents`): the filter below
    // classifies them, and once the backfill has run the range is empty.
    const order = readOrder(args.university)
    const reads = tiers.map((tier) => tierRows(ctx, args, tier, order, cards))
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
      (talksCam === "include" || event.talksDerived === (talksCam === "only")) &&
      (args.includeTakingPart !== false || event.hosting !== "takes_part") &&
      (!types || types.has(event.eventType)) &&
      (!args.university || (args.university === "only") === isUniversityListing(event)) &&
      words.every((word) => event.title.toLowerCase().includes(word)),
  )
  events = capByStream(events.sort((a, b) => a.startsAt - b.startsAt))

  const categories = args.categories?.length ? new Set<string>(args.categories) : null
  const colleges = args.collegeKeys?.length ? new Set(args.collegeKeys) : null
  const withdrawn = withdrawnCheck(ctx, Date.now())
  const out: EventCard[] = []
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

/**
 * The event behind a key if a viewer with `tiers` may see it, else null: the
 * visibility gate above, plus the suppression list — an event, an address or
 * a name removed on request never shows, even before the walk that sets its
 * claims aside reaches this event (lib/suppressions.ts).
 */
export async function shownEvent(
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
