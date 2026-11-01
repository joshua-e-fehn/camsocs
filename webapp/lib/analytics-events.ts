import { CATEGORIES, EVENT_HOSTING, LISTING_REQUEST_KINDS } from "@/lib/vocab"

/**
 * The product-event taxonomy (ENG-5; spec "Event taxonomy", docs/analytics.md):
 * every event of our own that may leave the browser, with the properties it
 * may carry and the values each may hold. One table, read twice:
 *
 *  - `track()` (lib/analytics.ts) sends an event only if its name is here and
 *    every required property passes its rule; other properties are dropped;
 *  - `sanitizeEvent`, the `before_send` (lib/analytics-client.ts), applies
 *    the same rules again, whatever called `posthog.capture`: it drops any
 *    event of ours not named here or missing a valid required property, and
 *    every property not allowed or not passing its rule (keeping only the
 *    SDK context the privacy notice names).
 *
 * Values are IDs, keys, enums, counts and booleans only (hard rules 1-2): a
 * key must have its exact shape (`org-…`, `evt-<sha1>`, `talk-<20 hex>`,
 * `dept-…`), so no title, name, query or URL can pass as one. Talk events
 * carry the talk's and department's keys, never a title or speaker; search
 * events carry the query's length, never its text.
 *
 * Pure (no browser, no posthog-js): server components import it for
 * `analyticsAttrs` / `analyticsContext`, the markup a click tracker reads.
 */

/** Which values one property may hold; `optional` properties may be left out. */
export type PropRule<T = unknown> = {
  readonly check: (value: unknown) => value is T
  readonly optional: boolean
}

type Required<T> = PropRule<T> & { readonly optional: false }
type Optional<T> = PropRule<T> & { readonly optional: true }

/** Event name → property name → rule (the shape `sanitizeEvent` reads). */
export type EventRules = Readonly<Record<string, Readonly<Record<string, PropRule>>>>

function rule<T>(check: (value: unknown) => value is T): Required<T> {
  return { check, optional: false }
}

function optional<T>(required: Required<T>): Optional<T> {
  return { check: required.check, optional: true }
}

/** Longest key we accept (slugs are cut at 80 characters, lib/keys.ts). */
const MAX_KEY = 120

function keyOf(shape: RegExp): Required<string> {
  return rule((value): value is string => {
    return typeof value === "string" && value.length <= MAX_KEY && shape.test(value)
  })
}

function oneOf<const T extends readonly string[]>(values: T): Required<T[number]> {
  return rule((value): value is T[number] => {
    return typeof value === "string" && (values as readonly string[]).includes(value)
  })
}

/** A whole number from 0 to `max`. */
function count(max: number): Required<number> {
  return rule((value): value is number => {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
  })
}

/** Up to `max` values, each passing `item`. */
function listOf<T>(item: PropRule<T>, max: number): Required<readonly T[]> {
  return rule((value): value is readonly T[] => {
    return Array.isArray(value) && value.length <= max && value.every((entry) => item.check(entry))
  })
}

// Same shapes as lib/url-state.ts, lib/talks-url-state.ts and the pipeline's
// department registry (`dept-<slug>`), kept here so this module stays pure.
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*"
const orgKey = keyOf(new RegExp(`^org-${SLUG}$`))
const eventKey = keyOf(/^evt-[0-9a-f]{40}$/)
const talkKey = keyOf(/^talk-[0-9a-f]{20}$/)
const departmentKey = keyOf(new RegExp(`^dept-${SLUG}$`))
/** What a calendar link is for: one event or talk, or a department's feed. */
const calendarKey = keyOf(new RegExp(`^(?:evt-[0-9a-f]{40}|talk-[0-9a-f]{20}|dept-${SLUG})$`))

/** Where a search was typed. */
export const SEARCH_SURFACES = ["societies", "events", "talks", "palette"] as const
export type SearchSurface = (typeof SEARCH_SURFACES)[number]

/** What a calendar link adds: the talks feed, one event or talk, or (later) an events feed. */
export const CALENDAR_FEEDS = ["talks", "event", "talk", "events"] as const

/** What kind of page a link off the site goes to (never its address). */
export const OUTBOUND_KINDS = ["website", "social", "source", "other"] as const
export type OutboundKind = (typeof OUTBOUND_KINDS)[number]

/** How a sign-in finished. Only the Cambridge email link is counted: the
 * admin's Google sign-in lands on /dashboard, which is never tracked. */
export const SIGN_IN_METHODS = ["cam"] as const

/** Longest query length and result count we report; longer is not a search. */
const MAX_QUERY_LENGTH = 1_000
const MAX_RESULTS = 100_000

/** The taxonomy. Adding an event: docs/analytics.md "Adding an event". */
export const ANALYTICS_EVENTS = {
  society_viewed: {
    orgKey,
    categories: listOf(oneOf(CATEGORIES), CATEGORIES.length),
  },
  event_viewed: {
    eventKey,
    orgKeys: optional(listOf(orgKey, 20)),
    hosting: optional(oneOf(EVENT_HOSTING)),
  },
  talk_viewed: {
    talkKey,
    departmentKey: optional(departmentKey),
  },
  search_performed: {
    surface: oneOf(SEARCH_SURFACES),
    queryLength: count(MAX_QUERY_LENGTH),
    resultCount: count(MAX_RESULTS),
  },
  search_zero_results: {
    surface: oneOf(SEARCH_SURFACES),
    queryLength: count(MAX_QUERY_LENGTH),
  },
  calendar_subscribe_clicked: {
    feed: oneOf(CALENDAR_FEEDS),
    key: optional(calendarKey),
  },
  outbound_link_clicked: {
    kind: oneOf(OUTBOUND_KINDS),
    orgKey: optional(orgKey),
  },
  listing_request_submitted: {
    kind: oneOf(LISTING_REQUEST_KINDS),
  },
  sign_in_completed: {
    method: oneOf(SIGN_IN_METHODS),
  },
} as const satisfies EventRules

type Taxonomy = typeof ANALYTICS_EVENTS
export type AnalyticsEvent = keyof Taxonomy

type ValueOf<R> = R extends PropRule<infer T> ? T : never
type Simplify<T> = { [K in keyof T]: T[K] }

/** The properties `track(event, …)` takes, from the table. */
export type EventProps<E extends AnalyticsEvent> = Simplify<
  {
    [K in keyof Taxonomy[E] as Taxonomy[E][K] extends { optional: true } ? never : K]: ValueOf<
      Taxonomy[E][K]
    >
  } & {
    [K in keyof Taxonomy[E] as Taxonomy[E][K] extends { optional: true } ? K : never]?: ValueOf<
      Taxonomy[E][K]
    >
  }
>

export type OutboundLink = EventProps<"outbound_link_clicked">

/** A property value that may leave the browser. */
export type PropValue = string | number | boolean | readonly string[]

/**
 * `props` cut to what `event` may carry: unknown properties and values that
 * fail their rule are dropped. Null when the event is not in `rules` or a
 * required property is missing or invalid — such an event is not sent.
 */
export function allowedProps(
  rules: EventRules,
  event: string,
  props: Readonly<Record<string, unknown>>,
): Record<string, PropValue> | null {
  if (!Object.hasOwn(rules, event)) return null
  const spec = rules[event] ?? {}
  const out: Record<string, PropValue> = {}
  for (const [name, propRule] of Object.entries(spec)) {
    const value = Object.hasOwn(props, name) ? props[name] : undefined
    if (value !== undefined && propRule.check(value)) out[name] = value as PropValue
    else if (!propRule.optional) return null
  }
  return out
}

// --- markup for the click tracker ---------------------------------------------------------

/** The attributes the click tracker (lib/analytics.ts `startClickTracking`) reads. */
export const EVENT_ATTR = "data-analytics-event"
export const PROPS_ATTR = "data-analytics-props"
export const CONTEXT_ATTR = "data-analytics-context"

/**
 * Attributes that make a click on an element (a link, usually) send `event`
 * with `props`, for markup a server component renders:
 * `<a href=… {...analyticsAttrs("outbound_link_clicked", { kind: "website" })}>`.
 * Client components call `track()` instead.
 */
export function analyticsAttrs<E extends AnalyticsEvent>(
  event: E,
  props: EventProps<E>,
): { "data-analytics-event": E; "data-analytics-props": string } {
  return { [EVENT_ATTR]: event, [PROPS_ATTR]: JSON.stringify(props) } as {
    "data-analytics-event": E
    "data-analytics-props": string
  }
}

/**
 * Properties every tracked click inside an element shares, where the event
 * allows them (a profile's `orgKey` for its outbound links). The element's
 * own props win; an event that does not allow one drops it.
 */
export function analyticsContext(context: { orgKey?: string }): {
  "data-analytics-context"?: string
} {
  return context.orgKey ? { [CONTEXT_ATTR]: JSON.stringify({ orgKey: context.orgKey }) } : {}
}

// --- sign-in completion -------------------------------------------------------------------

/**
 * The query parameter a Cambridge sign-in link's callback carries
 * (`?signed_in=cam`), so the page it lands on knows a sign-in just finished
 * and can send `sign_in_completed` (components/providers/sign-in-tracker.tsx,
 * which then removes it). It names the method only, never the person.
 */
export const SIGN_IN_PARAM = "signed_in"

type SignInMethod = (typeof SIGN_IN_METHODS)[number]

/** `path` (a same-origin path, maybe with a query or fragment) with the marker. */
export function withSignInMarker(path: string, method: SignInMethod): string {
  const url = new URL(path, "https://camsocs.invalid")
  url.searchParams.set(SIGN_IN_PARAM, method)
  return `${url.pathname}${url.search}${url.hash}`
}

/** The method a URL's marker names (only a known one), and the URL without it. */
export function readSignInMarker(href: string): {
  method: SignInMethod | null
  cleaned: string | null
} {
  const url = new URL(href)
  if (!url.searchParams.has(SIGN_IN_PARAM)) return { method: null, cleaned: null }
  const value = url.searchParams.get(SIGN_IN_PARAM)
  url.searchParams.delete(SIGN_IN_PARAM)
  const method = SIGN_IN_METHODS.find((known) => known === value) ?? null
  return { method, cleaned: `${url.pathname}${url.search}${url.hash}` }
}
