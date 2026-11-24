import { v } from "convex/values"
import { dayWindow, isIsoDate } from "../lib/calendar"
import { deploymentProfile } from "../lib/campus/deployment"
import { eventPath } from "../lib/talks-boundary"
import { venueDisplayName } from "../lib/venue-name"
import {
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  ITEM_LOCATION_PRECISIONS,
  type ItemLocationKind,
  TALK_KINDS,
} from "../lib/vocab"
import type { Doc } from "./_generated/dataModel"
import { type QueryCtx, query } from "./_generated/server"
import { matchingEvents } from "./lib/eventWindow"
import { itemLocationOf, placeLabel, venueCache } from "./lib/locations"
import {
  eventListItem,
  orgRefCache,
  type VenuePublic,
  venuePublic,
  venuePublicValidator,
} from "./lib/projections"
import {
  loadContactHashes,
  loadNameHashes,
  loadSuppressedEvents,
  scrubAddresses,
} from "./lib/suppressions"
import { departmentCache, scrubTalkItem, talkListItem } from "./lib/talks"
import { literalUnion } from "./lib/validators"
import { getViewer, visibleEventTiers } from "./lib/viewer"

/**
 * The map of one London day (`/map`, docs/locations-and-map.md §1d, §4).
 *
 * Events come from the calendar's own window read (convex/lib/eventWindow.ts
 * `matchingEvents`): the viewer's tiers, hidden hosts, withdrawn and
 * superseded events and the two-range read for multi-day events are exactly
 * `events.list`'s, then suppressed events are dropped and the list item is
 * scrubbed as there. Talks are `listing: "listed"` only, on their start day.
 *
 * The talks boundary (G1, lib/talks-boundary.ts): `talksCam` defaults to
 * `exclude` — no talks.cam-derived event and no talk read from talks.cam
 * (`sourceType: "talks_cam"`). `only` returns just those; the page asks for
 * them in the browser after hydration. `talks` defaults to `exclude` too (no
 * talks at all): a caller gets talk text only by asking `talks: "include"`,
 * which only the browser does (app/talks-boundary.test.tsx guards the server
 * modules).
 *
 * Venues are read by key, only those the day's rows reference (never
 * `venues.list`); only venues with coordinates are returned, and an item's
 * `venueKey` is set only when its venue is among them (a pin can be drawn).
 * Venue names are display names (lib/venue-name.ts), keys unchanged.
 */

const MAX_DAY_TALKS = 500
const MAX_WEEK_TALKS = 3_000
const MAX_WEEK_DAYS = 14

const talksMode = v.union(v.literal("include"), v.literal("exclude"))
const talksCamMode = v.union(v.literal("exclude"), v.literal("only"))

export const mapItemValidator = v.object({
  kind: literalUnion(["event", "talk"] as const),
  key: v.string(),
  title: v.string(),
  startsAt: v.number(),
  endsAt: v.union(v.number(), v.null()),
  allDay: v.boolean(),
  /** The item's own page: `/events/<key>` (`/talks/events/<key>` for a
   * talks.cam-derived event) or `/talks/<key>`. */
  href: v.string(),
  cancelled: v.boolean(),
  precision: literalUnion(ITEM_LOCATION_PRECISIONS),
  /** A key of `venues` (which all have coordinates), or null: no pin. */
  venueKey: v.union(v.string(), v.null()),
  room: v.optional(v.string()),
  areaLabel: v.optional(v.string()),
  /** What to print: "Seminar Room 1, Isaac Newton Institute"; may be "". */
  placeLabel: v.string(),
  /** Who runs it: organisers (events), series or department (talks). */
  orgLabel: v.optional(v.string()),
  /** Events only. */
  eventType: v.optional(literalUnion(EVENT_TYPES)),
  /** Talks only: talk, seminar, … (TALK_KINDS). */
  talkKind: v.optional(literalUnion(TALK_KINDS)),
  /** Events only (`members_only` never appears). */
  visibility: v.optional(literalUnion(EVENT_VISIBILITIES)),
})
export type MapItem = typeof mapItemValidator.type

export const mapDayValidator = v.object({
  date: v.string(),
  from: v.number(),
  to: v.number(),
  venues: v.array(venuePublicValidator),
  items: v.array(mapItemValidator),
  counts: v.object({
    events: v.number(),
    talks: v.number(),
    online: v.number(),
    unknown: v.number(),
    /** Films with no screening venue (no pin). */
    films: v.number(),
  }),
})

function checkDate(date: string): void {
  if (!isIsoDate(date)) throw new Error("`date` must be YYYY-MM-DD")
}

/** "A Society", "A Society and B Society", "A Society and 2 others". */
function joinNames(names: string[]): string | undefined {
  if (names.length === 0) return undefined
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]} and ${names.length - 1} others`
}

/** A pinned venue as the map prints it: its display name, key unchanged. */
function shownVenue(venue: Doc<"venues">): VenuePublic {
  return { ...venuePublic(venue), name: venueDisplayName(venue.name) }
}

type Located = {
  row: Doc<"itemLocations"> | null
  venue: Doc<"venues"> | null
}

async function locate(
  ctx: QueryCtx,
  venues: ReturnType<typeof venueCache>,
  kind: ItemLocationKind,
  key: string,
): Promise<Located> {
  const row = await itemLocationOf(ctx, kind, key)
  const venue =
    row?.venueKey && row.precision !== "online" && row.precision !== "film"
      ? await venues(row.venueKey)
      : null
  return { row, venue }
}

function placeFields(
  { row, venue }: Located,
  rawText: string | null | undefined,
  contacts: ReadonlySet<string>,
  names: ReadonlySet<string>,
) {
  const pinned = venue && venue.lat !== undefined && venue.lng !== undefined ? venue : null
  const shown = scrubAddresses(
    {
      room: row?.precision === "unknown" ? undefined : row?.room,
      areaLabel: row?.precision === "unknown" ? undefined : row?.areaLabel,
    },
    contacts,
    names,
  )
  return {
    precision: row?.precision ?? ("unknown" as const),
    venueKey: pinned?.key ?? null,
    ...(shown.room ? { room: shown.room } : {}),
    ...(shown.areaLabel ? { areaLabel: shown.areaLabel } : {}),
    placeLabel: placeLabel(
      row ? { precision: row.precision, room: shown.room, areaLabel: shown.areaLabel } : null,
      venue?.name,
      rawText,
    ),
    pinned,
  }
}

export const day = query({
  args: {
    /** A London date, `YYYY-MM-DD`. */
    date: v.string(),
    /** `include` or `exclude` (default) talks altogether (G1). */
    talks: v.optional(talksMode),
    /** The talks boundary (G1): `exclude` (default) or `only` talks.cam-derived items. */
    talksCam: v.optional(talksCamMode),
  },
  returns: mapDayValidator,
  handler: async (ctx, args) => {
    checkDate(args.date)
    const { from, to } = dayWindow(args.date, 1)
    const talksCam = args.talksCam ?? "exclude"
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const venues = venueCache(ctx)
    const [contacts, names, removed] = await Promise.all([
      loadContactHashes(ctx),
      loadNameHashes(ctx),
      loadSuppressedEvents(ctx),
    ])

    const items: MapItem[] = []
    const pins = new Map<string, VenuePublic>()

    const events = await matchingEvents(ctx, { from, to, talksCam }, tiers, lookup)
    for (const event of events) {
      if (removed.has(event.key)) continue
      const item = scrubAddresses(await eventListItem(event, lookup), contacts, names)
      const place = placeFields(
        await locate(ctx, venues, "event", event.key),
        item.venueText,
        contacts,
        names,
      )
      if (place.pinned) pins.set(place.pinned.key, shownVenue(place.pinned))
      const orgLabel = item.fromUniversity
        ? deploymentProfile().university.name
        : joinNames(item.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name))
      items.push({
        kind: "event",
        key: item.key,
        title: item.title,
        startsAt: item.startsAt,
        endsAt: item.endsAt ?? null,
        allDay: item.allDay,
        href: eventPath(item),
        cancelled: item.cancelled,
        precision: place.precision,
        venueKey: place.venueKey,
        ...(place.room ? { room: place.room } : {}),
        ...(place.areaLabel ? { areaLabel: place.areaLabel } : {}),
        placeLabel: place.placeLabel,
        ...(orgLabel ? { orgLabel } : {}),
        eventType: item.eventType,
        visibility: item.visibility,
      })
    }

    if (args.talks === "include") {
      const departments = departmentCache(ctx)
      const talks = await ctx.db
        .query("talks")
        .withIndex("by_listing_startsAt", (q) =>
          q.eq("listing", "listed").gte("startsAt", from).lt("startsAt", to),
        )
        .take(MAX_DAY_TALKS)
      for (const talk of talks) {
        if ((talk.sourceType === "talks_cam") !== (talksCam === "only")) continue
        const item = scrubTalkItem(await talkListItem(talk, departments), contacts, names)
        const place = placeFields(
          await locate(ctx, venues, "talk", talk.key),
          item.venue,
          contacts,
          names,
        )
        if (place.pinned) pins.set(place.pinned.key, shownVenue(place.pinned))
        const orgLabel = item.series ?? item.departments[0]?.shortName
        items.push({
          kind: "talk",
          key: item.key,
          title: item.title,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          allDay: item.allDay,
          href: `/talks/${item.key}`,
          cancelled: item.cancelled,
          precision: place.precision,
          venueKey: place.venueKey,
          ...(place.room ? { room: place.room } : {}),
          ...(place.areaLabel ? { areaLabel: place.areaLabel } : {}),
          placeLabel: place.placeLabel,
          ...(orgLabel ? { orgLabel } : {}),
          talkKind: item.kind,
        })
      }
    }

    items.sort((a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title))
    return {
      date: args.date,
      from,
      to,
      venues: [...pins.values()].sort((a, b) => a.name.localeCompare(b.name)),
      items,
      counts: {
        events: items.filter((item) => item.kind === "event").length,
        talks: items.filter((item) => item.kind === "talk").length,
        online: items.filter((item) => item.precision === "online").length,
        unknown: items.filter((item) => item.precision === "unknown").length,
        films: items.filter((item) => item.precision === "film").length,
      },
    }
  },
})

/**
 * How many events and talks each day of a strip has (`/map`'s 7-day strip):
 * numbers only, so it is G1-safe and counts talks.cam-derived items too,
 * which the page adds after hydration. Events count on every day they cover
 * (as `day` lists them); talks on their start day. Cancelled items count, as
 * `day` lists them. Each day's events are its own window read, under the
 * same cap as `day`'s, so a busy week's later days count what `day` shows.
 */
export const weekCounts = query({
  args: {
    /** The first London date, `YYYY-MM-DD`. */
    from: v.string(),
    /** 1..14 days; the strip asks for 7. */
    days: v.number(),
  },
  returns: v.array(v.object({ date: v.string(), events: v.number(), talks: v.number() })),
  handler: async (ctx, args) => {
    checkDate(args.from)
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > MAX_WEEK_DAYS) {
      throw new Error(`\`days\` must be 1..${MAX_WEEK_DAYS}`)
    }
    const window = dayWindow(args.from, args.days)
    const tiers = visibleEventTiers(await getViewer(ctx))
    const lookup = orgRefCache(ctx)
    const [removed, talks] = await Promise.all([
      loadSuppressedEvents(ctx),
      ctx.db
        .query("talks")
        .withIndex("by_listing_startsAt", (q) =>
          q.eq("listing", "listed").gte("startsAt", window.from).lt("startsAt", window.to),
        )
        .take(MAX_WEEK_TALKS),
    ])
    return await Promise.all(
      window.days.map(async (date) => {
        const { from, to } = dayWindow(date, 1)
        const events = await matchingEvents(ctx, { from, to, talksCam: "include" }, tiers, lookup)
        return {
          date,
          events: events.filter((event) => !removed.has(event.key)).length,
          talks: talks.filter((talk) => talk.startsAt >= from && talk.startsAt < to).length,
        }
      }),
    )
  },
})
