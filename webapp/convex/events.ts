import { type Infer, v } from "convex/values"
import { CATEGORIES, EVENT_TYPES, type EventVisibility } from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { DAY_MS } from "./lib/derived"
import { type EventPublic, eventPublic, eventPublicValidator, orgRefCache } from "./lib/projections"
import { literalUnion } from "./lib/validators"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * The public events calendar (docs/webapp.md "Public API").
 *
 * Visibility gate, applied in every function here: `public` events for
 * everyone; `cam_only` (mailing-list events) only for a verified @cam.ac.uk
 * viewer or the broker; `members_only` never.
 */

/** The widest window one call may ask for — a month view plus margins is ~6 weeks. */
export const MAX_WINDOW_MS = 186 * DAY_MS
const MAX_EVENTS = 1_000
const MAX_SEARCH_RESULTS = 256

const listArgs = {
  /** Epoch ms, inclusive. */
  from: v.number(),
  /** Epoch ms, exclusive; at most 186 days after `from`. */
  to: v.number(),
  categories: v.optional(v.array(literalUnion(CATEGORIES))),
  eventTypes: v.optional(v.array(literalUnion(EVENT_TYPES))),
  /** Only events this organisation organised, co-hosted or sponsored. */
  orgKey: v.optional(v.string()),
  q: v.optional(v.string()),
  /** Only events whose organisers belong to one of these colleges. */
  collegeKeys: v.optional(v.array(v.string())),
}
const listArgsObject = v.object(listArgs)
type ListArgs = Infer<typeof listArgsObject>

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

  const inWindow = (event: Doc<"events">) =>
    event.startsAt >= args.from && event.startsAt < args.to && tiers.includes(event.visibility)

  let events: Doc<"events">[] = []
  const text = args.q?.trim().slice(0, 200)
  if (args.orgKey) {
    const orgKey = args.orgKey
    const links = await ctx.db
      .query("eventOrganisers")
      .withIndex("by_org_startsAt", (i) =>
        i.eq("orgKey", orgKey).gte("startsAt", args.from).lt("startsAt", args.to),
      )
      .take(MAX_EVENTS)
    const keys = [...new Set(links.map((link) => link.eventKey))]
    for (const key of keys) {
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (i) => i.eq("key", key))
        .unique()
      if (event) events.push(event)
    }
  } else if (text) {
    for (const tier of tiers) {
      events.push(
        ...(await ctx.db
          .query("events")
          .withSearchIndex("search_title", (s) => s.search("title", text).eq("visibility", tier))
          .take(MAX_SEARCH_RESULTS)),
      )
    }
  } else {
    for (const tier of tiers) {
      events.push(
        ...(await ctx.db
          .query("events")
          .withIndex("by_visibility_startsAt", (i) =>
            i.eq("visibility", tier).gte("startsAt", args.from).lt("startsAt", args.to),
          )
          .take(MAX_EVENTS)),
      )
    }
  }

  events = events.filter(inWindow)
  if (text && args.orgKey) {
    const needle = text.toLowerCase()
    events = events.filter((event) => event.title.toLowerCase().includes(needle))
  }
  if (args.eventTypes && args.eventTypes.length > 0) {
    const wanted = new Set<string>(args.eventTypes)
    events = events.filter((event) => wanted.has(event.eventType))
  }

  const categories = args.categories?.length ? new Set<string>(args.categories) : null
  const colleges = args.collegeKeys?.length ? new Set(args.collegeKeys) : null
  const out: Doc<"events">[] = []
  for (const event of events.sort((a, b) => a.startsAt - b.startsAt).slice(0, MAX_EVENTS)) {
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

export const list = query({
  args: listArgs,
  returns: v.array(eventPublicValidator),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const events = await matchingEvents(ctx, args, tiers, lookup)
    const out: EventPublic[] = []
    for (const event of events) out.push(await eventPublic(ctx, event, lookup))
    return out
  },
})

/**
 * How many `cam_only` events match the same arguments as `list` but are
 * hidden from this viewer — for the calendar's "N more Cambridge-only events,
 * sign in with your @cam.ac.uk email" note. Only a count: titles, times and
 * organisers stay behind the gate. 0 for a viewer who can already see them.
 */
export const restrictedCount = query({
  args: listArgs,
  returns: v.object({ camOnly: v.number() }),
  handler: async (ctx, args) => {
    const tiers = visibleEventTiers(await getViewer(ctx))
    if (tiers.includes("cam_only")) return { camOnly: 0 }
    const hidden = await matchingEvents(ctx, args, ["cam_only"], orgRefCache(ctx))
    return { camOnly: hidden.length }
  },
})

/** One event, or null when it does not exist or the viewer may not see it. */
export const get = query({
  args: { key: v.string() },
  returns: v.union(v.null(), eventPublicValidator),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_key", (i) => i.eq("key", args.key))
      .unique()
    if (!event) return null
    const tiers: readonly EventVisibility[] = visibleEventTiers(await getViewer(ctx))
    if (!tiers.includes(event.visibility)) return null
    return await eventPublic(ctx, event, orgRefCache(ctx))
  },
})
