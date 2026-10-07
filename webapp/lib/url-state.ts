import type { FunctionArgs } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { CALENDAR_VIEWS, type CalendarView, isIsoDate } from "./calendar"
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
    ["page", state.page > 1 ? String(state.page) : undefined],
  ])
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

/** The offset cursor `orgs.list` uses (docs/webapp.md: cursor = offset). */
export function directoryCursor(state: DirectoryState): string {
  return String((state.page - 1) * DIRECTORY_PAGE_SIZE)
}

// --- /events ---------------------------------------------------------------------------------

export type EventsState = {
  view: CalendarView
  /** The day the view is anchored on; today (London) when absent. */
  date?: string
  q?: string
  categories: (typeof CATEGORIES)[number][]
  eventTypes: (typeof EVENT_TYPES)[number][]
  collegeKeys: string[]
  /** One organisation's events only, by slug. */
  org?: string
  /** The event whose details are open. */
  event?: string
}

export function parseEventsParams(params: SearchParams): EventsState {
  const view = firstParam(params, "view")
  const date = firstParam(params, "date")
  const org = firstParam(params, "org")
  const event = firstParam(params, "event")
  return {
    view: (CALENDAR_VIEWS as readonly string[]).includes(view ?? "")
      ? (view as CalendarView)
      : "list",
    date: date && isIsoDate(date) ? date : undefined,
    q: query(params),
    categories: oneOf(params, "cat", CATEGORIES),
    eventTypes: oneOf(params, "type", EVENT_TYPES),
    collegeKeys: orgKeys(params, "college"),
    org: org && isOrgSlug(org) ? org : undefined,
    event: event && EVENT_KEY.test(event) ? event : undefined,
  }
}

export function serializeEventsState(state: EventsState): string {
  return toQueryString([
    ["view", state.view === "list" ? undefined : state.view],
    ["date", state.date],
    ["q", state.q?.trim() || undefined],
    ["cat", [...state.categories].sort()],
    ["type", [...state.eventTypes].sort()],
    ["college", [...state.collegeKeys].sort()],
    ["org", state.org],
    ["event", state.event],
  ])
}

export type EventListArgs = FunctionArgs<typeof api.events.list>

/** The `events.list` arguments for a state and the window its view shows. */
export function eventListArgs(
  state: EventsState,
  window: { from: number; to: number },
): EventListArgs {
  return withoutUndefined({
    from: window.from,
    to: window.to,
    q: state.q,
    categories: state.categories.length > 0 ? state.categories : undefined,
    eventTypes: state.eventTypes.length > 0 ? state.eventTypes : undefined,
    collegeKeys: state.collegeKeys.length > 0 ? state.collegeKeys : undefined,
    orgKey: state.org ? `org-${state.org}` : undefined,
  })
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
