import { type Infer, v } from "convex/values"
import { addDays, isoDateMs, londonMidnight, startOfWeek } from "../lib/calendar"
import { CATEGORIES, EVENT_TYPES, type EventVisibility } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { DAY_MS, londonIsoDate } from "./lib/derived"
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
 */

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
}
const listArgsObject = v.object(listArgs)
type ListArgs = Infer<typeof listArgsObject>

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
async function hostsListed(
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
 * The events in `tiers` matching the filters, by start time (≤ 1000). The
 * caller decides the tiers from the viewer; this function never widens them.
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
    for (const tier of tiers) {
      const [starting, spanning] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_visibility_startsAt", (i) =>
            i.eq("visibility", tier).gte("startsAt", args.from).lt("startsAt", args.to),
          )
          .take(MAX_EVENTS),
        ctx.db
          .query("events")
          .withIndex("by_visibility_spanEndsAt", (i) =>
            i.eq("visibility", tier).gt("spanEndsAt", args.from),
          )
          .take(MAX_SPANNING),
      ])
      for (const event of [...starting, ...spanning]) byKey.set(event.key, event)
    }
  }

  // The window is applied before any text match, so a search finds this
  // window's events however many older ones share the words.
  const words = (args.q ?? "").trim().slice(0, 200).toLowerCase().split(/\s+/).filter(Boolean)
  const types = args.eventTypes?.length ? new Set<string>(args.eventTypes) : null
  let events = [...byKey.values()].filter(
    (event) =>
      overlaps(event, args.from, args.to) &&
      tiers.includes(event.visibility) &&
      (args.includeTakingPart !== false || event.hosting !== "takes_part") &&
      (!types || types.has(event.eventType)) &&
      words.every((word) => event.title.toLowerCase().includes(word)),
  )
  events = events.sort((a, b) => a.startsAt - b.startsAt).slice(0, MAX_EVENTS)

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
      { ...window, orgKey: args.orgKey },
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
    const event = await eventByKey(ctx, args.key)
    if (!event) return null
    const tiers: readonly EventVisibility[] = visibleEventTiers(await getViewer(ctx))
    if (!tiers.includes(event.visibility)) return null
    const lookup = orgRefCache(ctx)
    if (!(await hostsListed(event, lookup))) return null
    if (await withdrawnCheck(ctx, Date.now())(event)) return null
    // An event, an address or a name removed on request never shows, even
    // before the walk that sets its claims aside reaches this event
    // (lib/suppressions.ts).
    if ((await loadSuppressedEvents(ctx)).has(event.key)) return null
    return scrubAddresses(
      await eventPublic(ctx, event, lookup),
      await loadContactHashes(ctx),
      await loadNameHashes(ctx),
    )
  },
})
