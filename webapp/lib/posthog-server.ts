import { waitUntil } from "@vercel/functions"
import type { Instrumentation } from "next"
import { type EventMessage, PostHog, type PostHogOptions } from "posthog-node"
import { isUntrackedPath } from "@/lib/consent"
import { scrubErrorText, scrubExceptionProps, stripUrlTail } from "@/lib/error-scrub"

/**
 * The server's PostHog sender (ENG-6 errors; ENG-7 counts reuse
 * `captureServerEvent`). Spec "Errors" and "Server-side events without
 * consent", research-errors §2-§3, law report §7.
 *
 *  - No consent is involved, because nothing is stored on or read from a
 *    visitor's device: the basis is legitimate interests (record of
 *    processing P12, LIA §D). So nothing personal goes in: one fixed
 *    distinct id, `camsocs-server`, `$process_person_profile: false`, no IP
 *    (GeoIP off; PostHog sees Vercel's address and discards IPs anyway), no
 *    header, cookie, body, query string or user agent. Errors carry the
 *    route, the method, Next's router facts and the error's type, message and
 *    stack, scrubbed of query strings and emails (lib/error-scrub.ts); events
 *    carry only their allow-listed properties (`SERVER_EVENTS`).
 *  - `/dashboard*` and `/sign-in*` (hard rule 3) report nothing: they are
 *    never tracked, and a broker-area error can quote a person's name.
 *  - No `NEXT_PUBLIC_POSTHOG_KEY` (local runs, CI, previews) → no client, and
 *    every call is a no-op. The key and host are the public ones the browser
 *    build also reads (already set on Vercel Production); the server needs
 *    nothing secret to send.
 *  - Serverless: the client lives across invocations (module scope) and sends
 *    each event at once (`captureExceptionImmediate` / `captureImmediate`,
 *    `flushAt: 1`, `flushInterval: 0`), never `shutdown()` (it is shared).
 *    Callers hand the returned promise to `waitUntil` (`reportRequestError`)
 *    or Next's `after()` so the response never waits for PostHog. Every
 *    function here resolves, never rejects or throws: a report must never
 *    break the request it reports on.
 */

/** The one distinct id every server event carries (no person, no device). */
export const SERVER_DISTINCT_ID = "camsocs-server"

/** PostHog EU Cloud ingestion (docs/deploy.md); `NEXT_PUBLIC_POSTHOG_HOST` wins. */
export const DEFAULT_POSTHOG_HOST = "https://eu.i.posthog.com"

type Env = Readonly<Record<string, string | undefined>>

/** `production` only on Vercel's production deployment; everything else
 * (previews, local, CI) is `development`, which the project filters out. */
export function serverEnvironment(env: Env = process.env): "production" | "development" {
  return env.VERCEL_ENV === "production" ? "production" : "development"
}

/**
 * Our own server events, each with the properties it may carry (ENG-7 fills
 * it: `ics_feed_fetched: ["feed", "key"]`, …). An event not listed is never
 * sent; a property not listed is dropped. Values must be IDs, enums, numbers
 * or booleans, never free text.
 */
export const SERVER_EVENTS: Readonly<Record<string, readonly string[]>> = {}

/** Request facts an error report may carry (spec "Errors"), as PostHog /
 * `@posthog/next` name them. */
export const ERROR_CONTEXT_PROPS = [
  "$pathname",
  "$http_method",
  "nextjs_router_kind",
  "nextjs_route_path",
  "nextjs_route_type",
  "nextjs_render_source",
] as const

/** Kept on every event: our tags, and what PostHog needs to place the event. */
const BASE_PROPS = ["environment", "$process_person_profile", "$geoip_disable"] as const
/** Kept on `$exception` besides the request facts: the exception itself and
 * the release its stack belongs to (source maps). */
const EXCEPTION_PROPS = ["$exception_list", "$exception_level", "$release_id"] as const

const MAX_VALUE = 200

/** Where an error happened, as `captureServerException` takes it. */
export type ServerErrorContext = {
  /** The request path; a query string or fragment is cut off here. */
  path?: string
  method?: string
  routerKind?: string
  routePath?: string
  routeType?: string
  renderSource?: string
}

/** A short ID- or enum-like value: nothing from a `?` or `#` on, no email,
 * capped. */
function shortValue(value: string): string {
  return scrubErrorText(stripUrlTail(value)).slice(0, MAX_VALUE)
}

/** The properties an error report carries for `context`, or null when it
 * must not be reported at all (an untracked route). */
export function errorContextProperties(
  context: ServerErrorContext,
  env: Env = process.env,
): Record<string, string> | null {
  const props: Record<string, string> = { environment: serverEnvironment(env) }
  if (context.path !== undefined) {
    const path = stripUrlTail(context.path)
    if (isUntrackedPath(path)) return null
    props.$pathname = shortValue(path)
  }
  const facts: [string, string | undefined][] = [
    ["$http_method", context.method],
    ["nextjs_router_kind", context.routerKind],
    ["nextjs_route_path", context.routePath],
    ["nextjs_route_type", context.routeType],
    ["nextjs_render_source", context.renderSource],
  ]
  for (const [key, value] of facts) {
    if (typeof value === "string" && value !== "") props[key] = shortValue(value)
  }
  return props
}

/** Next's `onRequestError` arguments reduced to what a report may carry:
 * the path (without query string), method and router facts. Headers (and so
 * cookies, user agent and client address) are never read. */
export function requestErrorContext(
  request: Parameters<Instrumentation.onRequestError>[1],
  context: Parameters<Instrumentation.onRequestError>[2],
): ServerErrorContext {
  return {
    path: request.path,
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
  }
}

export type ServerEventProps = Readonly<Record<string, string | number | boolean | undefined>>

/** `props` reduced to `allowed` names with primitive values (strings
 * scrubbed and capped), or null when `event` has no allow-list entry. */
export function serverEventProperties(
  event: string,
  props: ServerEventProps,
  events: Readonly<Record<string, readonly string[]>> = SERVER_EVENTS,
  env: Env = process.env,
): Record<string, string | number | boolean> | null {
  const allowed = Object.hasOwn(events, event) ? events[event] : undefined
  if (!allowed || event.startsWith("$")) return null
  const out: Record<string, string | number | boolean> = { environment: serverEnvironment(env) }
  for (const key of allowed) {
    const value = props[key]
    if (typeof value === "string") out[key] = shortValue(value)
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value
    }
  }
  return out
}

/**
 * The client's `before_send`: the last word on what leaves the server.
 * Drops anything that is neither `$exception` nor a `SERVER_EVENTS` event,
 * pins the distinct id, keeps only allow-listed properties, scrubs the
 * exception list and turns person processing and GeoIP off.
 */
export function sanitizeServerEvent(
  message: EventMessage,
  events: Readonly<Record<string, readonly string[]>> = SERVER_EVENTS,
): EventMessage | null {
  const isException = message.event === "$exception"
  const own = Object.hasOwn(events, message.event) ? events[message.event] : undefined
  if (!isException && (!own || message.event.startsWith("$"))) return null
  const keep = new Set<string>([
    ...BASE_PROPS,
    ...(isException ? [...EXCEPTION_PROPS, ...ERROR_CONTEXT_PROPS] : (own ?? [])),
  ])
  const props: Record<string, unknown> = { ...message.properties }
  for (const key of Object.keys(props)) if (!keep.has(key)) delete props[key]
  if (isException) scrubExceptionProps(props)
  props.$process_person_profile = false
  props.$geoip_disable = true
  return {
    distinctId: SERVER_DISTINCT_ID,
    event: message.event,
    properties: props,
    timestamp: message.timestamp,
    uuid: message.uuid,
    disableGeoip: true,
  }
}

/** The client for `env`, or null without a key. Exported for tests, which
 * pass a recording `fetch`; the app uses `getPostHogServer()`. */
export function createPostHogServer(
  env: Env = process.env,
  overrides: Partial<PostHogOptions> = {},
): PostHog | null {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY?.trim()
  if (!key) return null
  return new PostHog(key, {
    host: env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST,
    // Serverless: send each event at once, nothing waits in a queue for an
    // invocation that may be frozen (research-errors §3).
    flushAt: 1,
    flushInterval: 0,
    // A report is worth little next to a function held open: one short try.
    requestTimeout: 3000,
    fetchRetryCount: 0,
    disableGeoip: true,
    // Next reports request errors through `onRequestError`; the SDK hooking
    // the process's uncaught exceptions would bypass the route checks.
    enableExceptionAutocapture: false,
    before_send: (message) => sanitizeServerEvent(message),
    ...overrides,
  })
}

/** undefined until first use; null when there is no key. */
let client: PostHog | null | undefined

/** The shared client, created on first use; null without a key. */
export function getPostHogServer(): PostHog | null {
  if (client === undefined) client = createPostHogServer()
  return client
}

/** Replaces the shared client (tests only). */
export function setPostHogServerForTests(next: PostHog | null | undefined): void {
  client = next
}

/**
 * Reports a server error to PostHog: the error's type, message and stack
 * plus the request facts in `context` (see `errorContextProperties`). Sends
 * at once; resolves when PostHog answered or gave up, never rejects. A no-op
 * without a key or on an untracked route.
 */
export async function captureServerException(
  error: unknown,
  context: ServerErrorContext = {},
): Promise<void> {
  try {
    const posthog = getPostHogServer()
    if (!posthog) return
    const props = errorContextProperties(context)
    if (!props) return
    await posthog.captureExceptionImmediate(error, SERVER_DISTINCT_ID, {
      ...props,
      $process_person_profile: false,
    })
  } catch {
    // Never let a report fail the request it is about.
  }
}

/**
 * Sends one of our `SERVER_EVENTS` (ENG-7): allow-listed properties only,
 * the fixed distinct id, no person profile. Sends at once; resolves when
 * PostHog answered or gave up, never rejects. A no-op without a key or for an
 * event that has no allow-list entry. Hand the promise to Next's `after()`.
 */
export async function captureServerEvent(
  event: string,
  props: ServerEventProps = {},
): Promise<void> {
  try {
    const posthog = getPostHogServer()
    if (!posthog) return
    const properties = serverEventProperties(event, props)
    if (!properties) return
    await posthog.captureImmediate({
      distinctId: SERVER_DISTINCT_ID,
      event,
      properties: { ...properties, $process_person_profile: false },
      disableGeoip: true,
    })
  } catch {
    // Telemetry never fails the request that triggered it.
  }
}

/**
 * `instrumentation.ts` `onRequestError`: reports the error without delaying
 * the response. The send runs in the background, kept alive past the
 * response on Vercel by `waitUntil` (a no-op elsewhere, where the process
 * outlives the request anyway).
 */
export function reportRequestError(
  ...[error, request, context]: Parameters<Instrumentation.onRequestError>
): void {
  try {
    const sending = captureServerException(error, requestErrorContext(request, context))
    waitUntil(sending)
  } catch {
    // Nothing here may throw into Next's error handling.
  }
}
