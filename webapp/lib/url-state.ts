import type { FunctionArgs } from "convex/server"
import type { api } from "@/convex/_generated/api"
import {
  addDays,
  CALENDAR_VIEWS,
  type CalendarView,
  type CalendarWindow,
  DAY_MS,
  dayWindow,
  isIsoDate,
  isoDateMs,
  LIST_DAYS,
  viewWindow,
} from "./calendar"
import { type DatePreset, isDatePreset, presetRange } from "./date-presets"
import { ORG_SORTS, type OrgSort } from "./directory-sort"
import { SLUG_MAX_LENGTH } from "./keys"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  EVENT_TYPES,
  GENDER_CATEGORIES,
  ORG_LEVELS,
  ORG_STATUSES,
} from "./vocab"

/**
 * The URL is the state of the two browsing pages: `/societies` (directory
 * filters) and `/events` (calendar view and filters). The server page parses
 * `searchParams` with these functions to preload the right Convex query, and
 * the client writes the same shape back with `router.push`, so a filtered view
 * is a link anyone can share.
 *
 * Multi-valued filters are one comma-separated parameter (`?cat=music,sport`).
 * Parsing is forgiving — unknown values are dropped, never an error — because a
 * URL is input from anyone; serialising is canonical (fixed key order, sorted
 * values, defaults omitted), so equal states give equal URLs.
 */

export type SearchParams = Record<string, string | string[] | undefined>

const MAX_QUERY = 200
/** Same shape as an organisation key (`org-<slug>`, data-model §0). */
const ORG_KEY = /^org-[a-z0-9]+(?:-[a-z0-9]+)*$/
const ORG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EVENT_KEY = /^evt-[0-9a-f]{40}$/

/** A slug as lib/keys.ts mints it: `[a-z0-9]` runs joined by single hyphens. */
export function isOrgSlug(value: string): boolean {
  return ORG_SLUG.test(value) && value.length <= SLUG_MAX_LENGTH
}

/** The first value of a search parameter (a repeated one comes as an array). */
export function firstParam(params: SearchParams, name: string): string | undefined {
  const value = params[name]
  return Array.isArray(value) ? value[0] : value
}

function list(params: SearchParams, name: string): string[] {
  const value = params[name]
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "")
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function oneOf<T extends string>(params: SearchParams, name: string, allowed: readonly T[]): T[] {
  const wanted = new Set(list(params, name))
  // Vocabulary order, so the parsed state is canonical whatever the URL order.
  return allowed.filter((value) => wanted.has(value))
}

function orgKeys(params: SearchParams, name: string): string[] {
  return [...new Set(list(params, name).filter((key) => ORG_KEY.test(key)))].sort()
}

function query(params: SearchParams): string | undefined {
  const q = firstParam(params, "q")?.trim().slice(0, MAX_QUERY)
  return q ? q : undefined
}

/** Builds `?a=…&b=…` from ordered entries, leaving out empty ones. */
function toQueryString(entries: [string, string | string[] | undefined][]): string {
  const params = new URLSearchParams()
  for (const [name, value] of entries) {
    if (value === undefined) continue
    const text = Array.isArray(value) ? value.join(",") : value
    if (text !== "") params.set(name, text)
  }
  const out = params.toString().replaceAll("%2C", ",")
  return out ? `?${out}` : ""
}

// --- /societies ------------------------------------------------------------------------------

export const DIRECTORY_PAGE_SIZE = 24

export type DirectoryState = {
  q?: string
  categories: (typeof CATEGORIES)[number][]
  levels: (typeof ORG_LEVELS)[number][]
  collegeKeys: string[]
  activityTypes: (typeof ACTIVITY_TYPES)[number][]
  audiences: (typeof AUDIENCES)[number][]
  statuses: (typeof ORG_STATUSES)[number][]
  blueStatus: (typeof BLUE_STATUSES)[number][]
  gender: (typeof GENDER_CATEGORIES)[number][]
  beginnerFriendly?: boolean
  /** The order (`?sort=`); absent is `relevance` (lib/directory-sort.ts). */
  sort?: OrgSort
  /** 1-based. */
  page: number
}

export const EMPTY_DIRECTORY: DirectoryState = {
  categories: [],
  levels: [],
  collegeKeys: [],
  activityTypes: [],
  audiences: [],
  statuses: [],
  blueStatus: [],
  gender: [],
  page: 1,
}

export function parseDirectoryParams(params: SearchParams): DirectoryState {
  const beginner = firstParam(params, "beginner")
  const page = Number.parseInt(firstParam(params, "page") ?? "1", 10)
  return {
    q: query(params),
    categories: oneOf(params, "cat", CATEGORIES),
    levels: oneOf(params, "level", ORG_LEVELS),
    collegeKeys: orgKeys(params, "college"),
    activityTypes: oneOf(params, "activity", ACTIVITY_TYPES),
    audiences: oneOf(params, "audience", AUDIENCES),
    statuses: oneOf(params, "status", ORG_STATUSES),
    blueStatus: oneOf(params, "blue", BLUE_STATUSES),
    gender: oneOf(params, "gender", GENDER_CATEGORIES),
    beginnerFriendly: beginner === "yes" ? true : beginner === "no" ? false : undefined,
    sort: directorySortParam(firstParam(params, "sort")),
    page: Number.isFinite(page) && page >= 1 && page <= 10_000 ? page : 1,
  }
}

export function serializeDirectoryState(state: DirectoryState): string {
  const sorted = <T extends string>(values: readonly T[]) => [...values].sort()
  return toQueryString([
    ["q", state.q?.trim() || undefined],
    ["cat", sorted(state.categories)],
    ["level", sorted(state.levels)],
    ["college", sorted(state.collegeKeys)],
    ["activity", sorted(state.activityTypes)],
    ["audience", sorted(state.audiences)],
    ["status", sorted(state.statuses)],
    ["blue", sorted(state.blueStatus)],
    ["gender", sorted(state.gender)],
    [
      "beginner",
      state.beginnerFriendly === undefined ? undefined : state.beginnerFriendly ? "yes" : "no",
    ],
    ["sort", state.sort === "relevance" ? undefined : state.sort],
    ["page", state.page > 1 ? String(state.page) : undefined],
  ])
}

/** A `?sort=` value, or undefined for the default (`relevance`) or junk. */
function directorySortParam(value: string | undefined): OrgSort | undefined {
  const sort = ORG_SORTS.find((item) => item === value)
  return sort === "relevance" ? undefined : sort
}

/** The order a state lists in: `relevance` is A–Z without a text query. */
export function effectiveDirectorySort(state: DirectoryState): OrgSort {
  const sort = state.sort ?? "relevance"
  return sort === "relevance" && !state.q ? "name" : sort
}

/** How many filters (not the text query or page) are applied. */
export function activeDirectoryFilterCount(state: DirectoryState): number {
  return (
    state.categories.length +
    state.levels.length +
    state.collegeKeys.length +
    state.activityTypes.length +
    state.audiences.length +
    state.statuses.length +
    state.blueStatus.length +
    state.gender.length +
    (state.beginnerFriendly === undefined ? 0 : 1)
  )
}

export type OrgFilterArgs = FunctionArgs<typeof api.orgs.facets>

/** The `orgs.list` / `orgs.facets` filter arguments for a directory state. */
export function directoryFilters(state: DirectoryState): OrgFilterArgs {
  const nonEmpty = <T>(values: T[]) => (values.length > 0 ? values : undefined)
  const sport =
    state.blueStatus.length > 0 || state.gender.length > 0 || state.beginnerFriendly !== undefined
      ? {
          blueStatus: nonEmpty(state.blueStatus),
          gender: nonEmpty(state.gender),
          beginnerFriendly: state.beginnerFriendly,
        }
      : undefined
  const args: OrgFilterArgs = {
    q: state.q,
    categories: nonEmpty(state.categories),
    levels: nonEmpty(state.levels),
    collegeKeys: nonEmpty(state.collegeKeys),
    activityTypes: nonEmpty(state.activityTypes),
    audiences: nonEmpty(state.audiences),
    statuses: nonEmpty(state.statuses),
    sport,
  }
  // Convex arguments must not carry `undefined` members over the wire.
  return withoutUndefined(args)
}

export type OrgListArgs = FunctionArgs<typeof api.orgs.list>

/** The `orgs.list` arguments for a state's page. `sort` only when it is not
 * the default, so a default view also runs against a deployment that
 * predates the argument. */
export function directoryListArgs(state: DirectoryState): OrgListArgs {
  return {
    ...directoryFilters(state),
    ...(state.sort && state.sort !== "relevance" ? { sort: state.sort } : {}),
    paginationOpts: { numItems: DIRECTORY_PAGE_SIZE, cursor: directoryCursor(state) },
  }
}

/** The offset cursor `orgs.list` uses (docs/webapp.md: cursor = offset). */
export function directoryCursor(state: DirectoryState): string {
  return String((state.page - 1) * DIRECTORY_PAGE_SIZE)
}

// --- /events ---------------------------------------------------------------------------------

/** "Show next week" stops adding weeks here (8 weeks ≈ 500 events); later
 * dates are reached by moving the anchor. */
export const MAX_LIST_WEEKS = 8

export type EventsState = {
  view: CalendarView
  /** The day the view is anchored on; today (London) when absent. */
  date?: string
  /** A quick range (lib/date-presets.ts) for the list view; it wins over `date`. */
  preset?: DatePreset
  /** How many weeks the list view has loaded from its first day: 1, then
   * one more per "Show next week" (`?weeks=`, at most `MAX_LIST_WEEKS`). */
  weeks: number
  /** Words that must each appear in the title, an organiser's name or the
   * venue. Matched in the browser over the loaded days (lib/events.ts). */
  q?: string
  categories: (typeof CATEGORIES)[number][]
  eventTypes: (typeof EVENT_TYPES)[number][]
  collegeKeys: string[]
  /** One organisation's events only, by slug. */
  org?: string
  /** Whether events societies only take part in (decision D6: someone else's
   * CTF, conference or fair) are listed. Off by default; `?external=show`. */
  takingPart: boolean
  /** The event whose details are open. */
  event?: string
}

export const EMPTY_EVENTS: EventsState = {
  view: "list",
  weeks: 1,
  categories: [],
  eventTypes: [],
  collegeKeys: [],
  takingPart: false,
}

export function isEventKey(value: string): boolean {
  return EVENT_KEY.test(value)
}

export function parseEventsParams(params: SearchParams): EventsState {
  const view = firstParam(params, "view")
  const date = firstParam(params, "date")
  const preset = firstParam(params, "preset")
  const weeks = Number.parseInt(firstParam(params, "weeks") ?? "1", 10)
  const org = firstParam(params, "org")
  const event = firstParam(params, "event")
  return {
    view: (CALENDAR_VIEWS as readonly string[]).includes(view ?? "")
      ? (view as CalendarView)
      : "list",
    date: date && isIsoDate(date) ? date : undefined,
    preset: isDatePreset(preset) ? preset : undefined,
    weeks: Number.isFinite(weeks) && weeks >= 1 ? Math.min(weeks, MAX_LIST_WEEKS) : 1,
    q: query(params),
    categories: oneOf(params, "cat", CATEGORIES),
    eventTypes: oneOf(params, "type", EVENT_TYPES),
    collegeKeys: orgKeys(params, "college"),
    org: org && isOrgSlug(org) ? org : undefined,
    // `hide` (the old opt-out) and anything else leave them out.
    takingPart: firstParam(params, "external") === "show",
    event: event && isEventKey(event) ? event : undefined,
  }
}

export function serializeEventsState(state: EventsState): string {
  return toQueryString([
    ["view", state.view === "list" ? undefined : state.view],
    ["date", state.date],
    ["preset", state.preset],
    ["weeks", state.weeks > 1 ? String(Math.min(state.weeks, MAX_LIST_WEEKS)) : undefined],
    ["q", state.q?.trim() || undefined],
    ["cat", [...state.categories].sort()],
    ["type", [...state.eventTypes].sort()],
    ["college", [...state.collegeKeys].sort()],
    ["org", state.org],
    ["external", state.takingPart ? "show" : undefined],
    ["event", state.event],
  ])
}

/** `/events?…` for a state. */
export function eventsHref(state: EventsState): string {
  return `/events${serializeEventsState(state)}`
}

/** How many filters (not the text query, the dates or the open event) are on.
 * Including the events societies take part in counts: it widens the list,
 * but it is a choice the reader made and may want to undo. */
export function activeEventFilterCount(state: EventsState): number {
  return (
    state.categories.length +
    state.eventTypes.length +
    state.collegeKeys.length +
    (state.org ? 1 : 0) +
    (state.takingPart ? 1 : 0)
  )
}

/** The days a view loads and shows. */
export type EventsWindow = CalendarWindow & {
  /** The days the agenda shows (inclusive): a preset's range can be shorter
   * than what is loaded, which is never less than a week so the week strip
   * has a count for every day. */
  shown: { first: string; last: string }
  /** The preset in force (one with no range today, "Rest of term" in the
   * vacation, falls back to the default window). */
  preset?: DatePreset
}

/**
 * What a state loads, seen from `today` (London):
 *  - week, month: the calendar grid (lib/calendar.ts `viewWindow`);
 *  - list with a preset: the preset's days, loaded for at least a week;
 *  - list: `weeks` weeks from `date` (default today).
 */
export function eventsWindow(state: EventsState, today: string, termEnd?: string): EventsWindow {
  if (state.view !== "list") {
    const window = viewWindow(state.view, state.date ?? today)
    return {
      ...window,
      shown: { first: window.days[0], last: window.days[window.days.length - 1] },
    }
  }
  const range = state.preset ? presetRange(state.preset, today, termEnd) : undefined
  const first = range?.first ?? state.date ?? today
  const last = range?.last ?? addDays(first, Math.min(state.weeks, MAX_LIST_WEEKS) * 7 - 1)
  const loadedLast = last < addDays(first, LIST_DAYS - 1) ? addDays(first, LIST_DAYS - 1) : last
  const dayCount = Math.round((isoDateMs(loadedLast) - isoDateMs(first)) / DAY_MS) + 1
  return {
    ...dayWindow(first, dayCount),
    shown: { first, last },
    preset: range ? state.preset : undefined,
  }
}

export type EventListArgs = FunctionArgs<typeof api.events.list>

/** The `events.list` arguments for a state and the window it loads. The
 * text query is not among them: it is matched in the browser, over title,
 * organisers and venue (lib/events.ts `matchesEventQuery`). */
export function eventListArgs(
  state: EventsState,
  window: { from: number; to: number },
): EventListArgs {
  return withoutUndefined({
    from: window.from,
    to: window.to,
    categories: state.categories.length > 0 ? state.categories : undefined,
    eventTypes: state.eventTypes.length > 0 ? state.eventTypes : undefined,
    collegeKeys: state.collegeKeys.length > 0 ? state.collegeKeys : undefined,
    orgKey: state.org ? `org-${state.org}` : undefined,
    includeTakingPart: state.takingPart ? undefined : false,
  })
}

/** The arguments `events.restrictedCount` is asked with (the server page's
 * preload and the calendar's live count alike): it ignores every filter but
 * an organisation, so the rest are left out and a filter change does not
 * re-count. */
export function eventRestrictedArgs(args: EventListArgs): EventListArgs {
  return args.orgKey
    ? { from: args.from, to: args.to, orgKey: args.orgKey }
    : { from: args.from, to: args.to }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] =
      item && typeof item === "object" && !Array.isArray(item)
        ? withoutUndefined(item as Record<string, unknown>)
        : item
  }
  return out as T
}
