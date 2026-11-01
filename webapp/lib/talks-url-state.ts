import type { FunctionArgs } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { addDays, isIsoDate, londonMidnight } from "./calendar"
import { type DatePreset, isDatePreset, presetRange } from "./date-presets"
import { firstParam, type SearchParams } from "./url-state"
import { TALK_KINDS, TALK_SCHOOLS, type TalkKind, type TalkSchool } from "./vocab"

/**
 * The URL is the state of `/talks` (talks-redesign-spec §6), the way
 * lib/url-state.ts holds `/societies` and `/events`: the server page parses
 * `searchParams` with these functions to preload the first view, and the
 * client writes the same shape back with `history.pushState`, so a filtered
 * agenda is a link anyone can share — and its filters are the `/talks.ics`
 * feed's (lib/ics.ts `parseTalkFeedParams` reads the same names).
 *
 *   ?q=        free text (talks.search)
 *   ?school=   one School (lib/vocab.ts TALK_SCHOOLS)
 *   ?dept=     one department slug, or `other-series`
 *   ?kind=     seminar | lecture | workshop | conference | other
 *   ?online=   yes (online or hybrid only) | no (in person only)
 *   ?preset=   today | tomorrow | week | weekend | term (lib/date-presets.ts)
 *   ?from=     YYYY-MM-DD: the agenda starts that day (the week strip); a
 *              preset wins over it
 *   ?talk=     the talk whose details sheet is open
 *
 * Parsing is forgiving (unknown values are dropped, never an error);
 * serialising is canonical (fixed key order, defaults omitted).
 */

const MAX_QUERY = 200
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG = 120
/** `talk-` + 20 hex digits (convex/lib/talks.ts `talkKey`). */
const TALK_KEY = /^talk-[0-9a-f]{20}$/

/** How many days the agenda shows from its first day when no preset is set. */
export const AGENDA_DAYS = 28
/** Talks per `talks.list` page ("Load more" asks for the next). */
export const TALKS_PAGE_SIZE = 40
/** Best matches `talks.search` returns at most. */
export const TALKS_SEARCH_LIMIT = 50

export type TalksState = {
  q?: string
  school?: TalkSchool
  /** A department slug, or `other-series`. */
  dept?: string
  kind?: TalkKind
  /** true: online or hybrid only; false: in person only. */
  online?: boolean
  preset?: DatePreset
  /** `YYYY-MM-DD`; ignored while a preset is set. */
  from?: string
  /** The talk whose details are open. */
  talk?: string
}

export const EMPTY_TALKS: TalksState = {}

export function isTalkKey(value: string): boolean {
  return TALK_KEY.test(value)
}

export function isDepartmentSlug(value: string): boolean {
  return SLUG.test(value) && value.length <= MAX_SLUG
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value)
}

export function parseTalksParams(params: SearchParams): TalksState {
  const q = firstParam(params, "q")?.trim().slice(0, MAX_QUERY)
  const dept = firstParam(params, "dept")
  const online = firstParam(params, "online")
  const preset = firstParam(params, "preset")
  const from = firstParam(params, "from")
  const talk = firstParam(params, "talk")
  const state: TalksState = {
    q: q || undefined,
    school: oneOf(firstParam(params, "school"), TALK_SCHOOLS),
    dept: dept && isDepartmentSlug(dept) ? dept : undefined,
    kind: oneOf(firstParam(params, "kind"), TALK_KINDS),
    online: online === "yes" ? true : online === "no" ? false : undefined,
    preset: isDatePreset(preset) ? preset : undefined,
    from: !isDatePreset(preset) && from && isIsoDate(from) ? from : undefined,
    talk: talk && isTalkKey(talk) ? talk : undefined,
  }
  return withoutUndefined(state)
}

/** Builds `?a=…&b=…` in the given order, leaving out empty entries. */
function queryString(entries: [string, string | undefined][]): string {
  const params = new URLSearchParams()
  for (const [name, value] of entries) if (value) params.set(name, value)
  const out = params.toString()
  return out ? `?${out}` : ""
}

function onlineParam(online: boolean | undefined): string | undefined {
  return online === undefined ? undefined : online ? "yes" : "no"
}

export function serializeTalksState(state: TalksState): string {
  return queryString([
    ["q", state.q?.trim() || undefined],
    ["school", state.school],
    ["dept", state.dept],
    ["kind", state.kind],
    ["online", onlineParam(state.online)],
    ["preset", state.preset],
    ["from", state.preset ? undefined : state.from],
    ["talk", state.talk],
  ])
}

/** `/talks?…` for a state. */
export function talksHref(state: TalksState): string {
  return `/talks${serializeTalksState(state)}`
}

/** The `/talks.ics` query for a state's filters (no dates, no open talk):
 * the feed always runs from today for 60 days. */
export function talksFeedQuery(state: TalksState): string {
  return queryString([
    ["school", state.school],
    ["dept", state.dept],
    ["kind", state.kind],
    ["online", onlineParam(state.online)],
    ["q", state.q?.trim() || undefined],
  ])
}

/** How many filters (not the text query, the dates or the open talk) are on. */
export function activeTalkFilterCount(state: TalksState): number {
  return (
    (state.school ? 1 : 0) +
    (state.dept ? 1 : 0) +
    (state.kind ? 1 : 0) +
    (state.online === undefined ? 0 : 1)
  )
}

// --- the window the agenda shows ---------------------------------------------------------

export type TalksWindow = {
  /** `YYYY-MM-DD`, inclusive. */
  first: string
  /** `YYYY-MM-DD`, inclusive. */
  last: string
  /** Epoch ms of London midnight starting `first`. */
  from: number
  /** Epoch ms of London midnight after `last` (exclusive). */
  to: number
  /** The preset in force (a preset with no range today, such as "Rest of
   * term" in the vacation, falls back to the default window). */
  preset?: DatePreset
}

/** The days the agenda shows: the preset's range, else `AGENDA_DAYS` days
 * from `from` (default today). */
export function talksWindow(state: TalksState, today: string, termEnd?: string): TalksWindow {
  const range = state.preset ? presetRange(state.preset, today, termEnd) : undefined
  const first = range?.first ?? state.from ?? today
  const last = range?.last ?? addDays(first, AGENDA_DAYS - 1)
  return {
    first,
    last,
    from: londonMidnight(first),
    to: londonMidnight(addDays(last, 1)),
    preset: range ? state.preset : undefined,
  }
}

// --- Convex arguments --------------------------------------------------------------------

export type TalkListArgs = Omit<FunctionArgs<typeof api.talks.list>, "paginationOpts">
export type TalkSearchArgs = FunctionArgs<typeof api.talks.search>
export type TalkDayCountArgs = FunctionArgs<typeof api.talks.dayCounts>

/** `talks.list` arguments (less `paginationOpts`) for a state and window. */
export function talksListArgs(state: TalksState, window: TalksWindow): TalkListArgs {
  return withoutUndefined({
    from: window.from,
    to: window.to,
    school: state.school,
    department: state.dept,
    kind: state.kind,
    online: state.online,
  })
}

/** `talks.search` arguments: upcoming from the window's first day. The
 * search knows no end, kind or online; `matchesWindow` applies them. */
export function talksSearchArgs(state: TalksState, window: TalksWindow): TalkSearchArgs {
  return withoutUndefined({
    q: state.q ?? "",
    school: state.school,
    department: state.dept,
    from: window.from,
    limit: TALKS_SEARCH_LIMIT,
  })
}

/** Whether a search hit belongs in the window and the filters the search
 * cannot apply itself. */
export function matchesWindow(
  talk: { startsAt: number; kind: TalkKind; online: boolean },
  state: TalksState,
  window: TalksWindow,
): boolean {
  if (talk.startsAt >= window.to) return false
  if (state.kind && talk.kind !== state.kind) return false
  if (state.online !== undefined && talk.online !== state.online) return false
  return true
}

/** `talks.dayCounts` arguments for the seven days from `monday`. */
export function talksDayCountArgs(state: TalksState, monday: string): TalkDayCountArgs {
  return withoutUndefined({
    from: londonMidnight(monday),
    to: londonMidnight(addDays(monday, 7)),
    school: state.school,
    department: state.dept,
    kind: state.kind,
    online: state.online,
  })
}

/** The widest window `talks.dayCounts` takes (convex/talks.ts). */
export const MAX_COUNT_DAYS = 62

/** `talks.dayCounts` arguments over the whole window (at most 62 days), so
 * the counts add up to the agenda's total. `capped` when the window is
 * longer and the total covers only its first 62 days. */
export function talksCountArgs(
  state: TalksState,
  window: TalksWindow,
): { args: TalkDayCountArgs; capped: boolean } {
  const end = londonMidnight(addDays(window.first, MAX_COUNT_DAYS))
  const capped = window.to > end
  return {
    args: withoutUndefined({
      from: window.from,
      to: capped ? end : window.to,
      school: state.school,
      department: state.dept,
      kind: state.kind,
      online: state.online,
    }),
    capped,
  }
}

/** Convex arguments must not carry `undefined` members over the wire. */
function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item
  return out as T
}
