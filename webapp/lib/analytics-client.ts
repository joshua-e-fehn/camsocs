import type { CaptureResult, PostHog, PostHogConfig, Properties } from "posthog-js"
import { ANALYTICS_EVENTS, allowedProps, type EventRules } from "@/lib/analytics-events"
import { clearAnalyticsStorage, getConsent, isUntrackedPath, onConsentChange } from "@/lib/consent"

/**
 * The browser analytics client (ENG-4; spec "Browser analytics client",
 * research-js §1-§6): posthog-js, behind the visitor's consent.
 *
 *  - Nothing of PostHog is imported, run or stored until the consent store
 *    (lib/consent.ts) holds "granted" (UK PECR reg 6, law report §7). The
 *    package is a lazy `import()`, so a visitor who never accepts never
 *    downloads it. Without `NEXT_PUBLIC_POSTHOG_KEY` (CI, previews, e2e,
 *    local runs) or under `navigator.webdriver` (Playwright) it never loads.
 *  - Withdrawal (Reject, or a choice that lapses or is cleared, here or in
 *    another tab) stops it at once: `opt_out_capturing()`, `reset()`,
 *    persistence off, then every `ph_*` / `__ph_*` cookie and storage key is
 *    deleted. On every page load without a grant that storage is deleted too,
 *    so it never outlives a choice.
 *  - Events go to our own `/relay` path (lib/relay.ts forwards to PostHog's
 *    EU Cloud without the visitor's cookies). Autocapture, replay, heatmaps, dead clicks, rageclicks,
 *    surveys, flags and remote config are off. `sanitizeEvent` (the
 *    `before_send`) is the last word on what leaves the browser: it drops
 *    `/dashboard` and `/sign-in`, unknown events, query strings, fragments,
 *    page titles, element text and the user-agent string (hard rules 1-3;
 *    the privacy notice's "When you browse" lists what remains).
 *
 * `instrumentation-client.ts` calls `startAnalytics()` once per page.
 * ENG-5 (`track`, lib/analytics.ts) and ENG-6 reach the instance through
 * `getPostHog()` / `posthogReady()`, which give null whenever nothing may be
 * sent.
 */

/** Our reverse-proxy path for PostHog (lib/relay.ts, robots.ts). */
export const RELAY_PATH = "/relay"

/**
 * The SDK's own events that may leave the browser. Everything else the SDK
 * might emit ($autocapture, $rageclick, $snapshot, $web_vitals, $identify,
 * $opt_in, …) is dropped even if a setting or a remote default turned it on.
 * ENG-6 adds `$exception`.
 */
export const SDK_EVENTS: readonly string[] = ["$pageview", "$pageleave"]

/**
 * Our own events, each with the properties it may carry and the values each
 * may hold: by default the taxonomy in lib/analytics-events.ts, the table
 * `track()` reads too. An event not listed is dropped; a property not listed,
 * or whose value fails its rule, is removed.
 */
export type CustomEventProps = EventRules

/** Properties the SDK needs on every event (`token`: a 401 without it). */
const REQUIRED_PROPS: readonly string[] = ["token", "distinct_id", "environment"]

/**
 * The SDK context our own events keep besides their allow-listed properties:
 * exactly what the privacy notice ("When you browse") and record of
 * processing P11 name (page, referrer, browser and OS, language, time zone,
 * device type, screen size, the random identifiers), plus the flags that
 * keep a person profile and GeoIP off and the library's name and version.
 * Any other `$` key on one of our events goes: a `$set` / `$set_once` /
 * `$unset` person payload, the SDK's debug and server-side flags, and free
 * text under a `$` name (posthog-js `calculateEventProperties` and
 * `getEventProperties`, 1.444.0). `$session_entry_…` copies are cleaned by
 * the URL rules below.
 */
const SDK_CONTEXT_PROPS = new Set([
  "$current_url",
  "$host",
  "$pathname",
  "$referrer",
  "$referring_domain",
  "$browser",
  "$browser_version",
  "$browser_language",
  "$browser_language_prefix",
  "$os",
  "$os_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$timezone",
  "$timezone_offset",
  "$device_id",
  "$session_id",
  "$window_id",
  "$pageview_id",
  "$insert_id",
  "$time",
  "$is_identified",
  "$process_person_profile",
  "$geoip_disable",
  "$config_defaults",
  "$lib",
  "$lib_version",
  "$lib_custom_api_host",
])

function isSdkContextProp(key: string): boolean {
  return SDK_CONTEXT_PROPS.has(key) || key.startsWith("$session_entry_")
}

/**
 * Removed at every level of an event, also as `$initial_…` / `$session_entry_…`
 * copies: page titles (a talk page's <title> is the talk's title, talks.cam
 * content), element text and structure, the full user-agent string (browser
 * and OS name/version stay, derived by the SDK), the search keyword the SDK
 * reads from a search engine's referrer, and SDK defaults the privacy notice
 * does not list (window size, device model family, time on the previous page;
 * scroll depth is switched off at the source). "Device type" and "screen
 * size" (`$device_type`, `$screen_*`) are listed and stay.
 */
export const STRIPPED_PROPS: readonly string[] = [
  "title",
  "$title",
  "$el_text",
  "$elements",
  "$elements_chain",
  "$raw_user_agent",
  "$useragent",
  "$user_agent",
  "ph_keyword",
  "$viewport_width",
  "$viewport_height",
  "$device",
  "$prev_pageview_duration",
]

/**
 * Campaign parameters the SDK copies out of the query string (posthog-js
 * `CAMPAIGN_PARAMS` + `EVENT_TO_PERSON_PROPERTIES`). The privacy notice says
 * nothing after "?" is sent, so they go too, also as `$initial_…` /
 * `$session_entry_…` copies. `save_campaign_params: false` should stop them
 * at the source; this is the backstop.
 */
const CAMPAIGN_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gad_source",
  "mc_cid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "oppref",
  "bfcid",
  "irclid",
  "_kx",
])
const COPY_PREFIXES = ["$initial_", "$session_entry_"] as const

/**
 * Whether `key` goes, under its own name or as a copy: the SDK copies
 * properties as `$initial_<name>` / `$session_entry_<name>` with the name's
 * own leading `$` dropped (`$session_entry_ph_keyword`, `$initial_utm_source`,
 * `$initial_raw_user_agent`), and a rule for a name covers its copies.
 */
function isStrippedProp(key: string): boolean {
  const prefix = COPY_PREFIXES.find((p) => key.startsWith(p))
  const names = prefix ? [key.slice(prefix.length), `$${key.slice(prefix.length)}`] : [key]
  return names.some((name) => STRIPPED_PROPS.includes(name) || CAMPAIGN_PARAMS.has(name))
}

/**
 * The init options (spec, names checked against @posthog/types 1.419.0,
 * research-js §1-§5). Explicit even where a default matches, so a changed
 * default or remote setting cannot switch anything on.
 */
export function posthogConfig(
  environment: string,
  customEvents: CustomEventProps = ANALYTICS_EVENTS,
): Partial<PostHogConfig> {
  return {
    api_host: RELAY_PATH,
    ui_host: "https://eu.posthog.com",
    defaults: "2026-08-30",
    person_profiles: "identified_only",
    persistence: "localStorage+cookie",
    cookie_expiration: 180,
    autocapture: false,
    capture_pageview: "history_change",
    capture_pageleave: true,
    disable_session_recording: true,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    rageclick: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    // Also stops the remote config call, so nothing above is re-enabled from
    // the project settings (research-js §5).
    advanced_disable_flags: true,
    capture_performance: false,
    // Nothing above needs a lazily loaded script, and this also keeps the
    // toolbar (opened from a URL fragment) from loading. ENG-6 revisits it if
    // exception autocapture needs its extension.
    disable_external_dependency_loading: true,
    // ENG-6 turns browser exceptions on (consented visitors only).
    capture_exceptions: false,
    save_campaign_params: false,
    // Keeps the landing URL and referrer out of `$initial_person_info`, which
    // the SDK writes into its cookie before `before_send` runs. With
    // campaign params also off it is never written; the page you came from
    // still travels as `$session_entry_referrer` (cleaned below).
    save_referrer: false,
    // No fragment in any URL, and no pageview on a fragment change.
    disable_capture_url_hashes: true,
    // No scroll-depth numbers on `$pageview` / `$pageleave` (not in the notice).
    disable_scroll_properties: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    // Checked again here, at the last moment: posthog-js keeps running after
    // a withdrawal (it cannot be unloaded), and nothing it queues may leave
    // without a grant in force.
    before_send: (event) =>
      getConsent() === "granted" ? sanitizeEvent(event, { environment, customEvents }) : null,
  }
}

/** Super properties: `environment` tags every event; GeoIP stays off so no
 * location is derived from the IP before PostHog discards it. Re-registered
 * after every `reset()`, and set again in `sanitizeEvent` (which no reset
 * can clear, research-js §6). */
function superProperties(environment: string): Properties {
  return { environment, $geoip_disable: true }
}

// --- before_send ------------------------------------------------------------------------------

type SanitizeOptions = {
  environment: string
  customEvents?: CustomEventProps
  /** This site's origin; a same-origin URL into an untracked route is cut to it. */
  origin?: string | null
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `value` without query string or fragment; a same-origin URL into an
 * untracked route keeps only the origin, so it does not reveal the visit. */
function cleanUrl(value: string, origin: string | null): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.split(/[?#]/)[0] ?? ""
  }
  if (origin !== null && url.origin === origin && isUntrackedPath(url.pathname)) return url.origin
  return `${url.origin}${url.pathname}`
}

/** Applies the property rules to one object, recursing into plain objects
 * (`$set`, `$set_once`, `$initial_person_info`, …). Arrays are left alone. */
function cleanProps(props: Record<string, unknown>, origin: string | null): void {
  for (const key of Object.keys(props)) {
    const value = props[key]
    if (isStrippedProp(key)) {
      delete props[key]
    } else if (typeof value === "string" && key.endsWith("pathname")) {
      const path = value.split(/[?#]/)[0] ?? ""
      if (isUntrackedPath(path)) delete props[key]
      else props[key] = path
    } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      props[key] = cleanUrl(value, origin)
    } else if (isPlainObject(value)) {
      cleanProps(value, origin)
    }
  }
}

/** The page an event belongs to: its `$pathname`, else its `$current_url`,
 * else the page we are on. */
function eventPathname(props: Properties): string {
  if (typeof props.$pathname === "string") return props.$pathname
  if (typeof props.$current_url === "string") {
    try {
      return new URL(props.$current_url).pathname
    } catch {
      // Fall through to the page itself.
    }
  }
  return typeof window === "undefined" ? "" : window.location.pathname
}

/**
 * The `before_send` hook: returns the event as it may leave the browser, or
 * null to drop it. Mutates and returns `event`. A throw here also drops the
 * event (posthog-js `_runBeforeSend`), so it fails closed.
 *
 *  1. Drops events on `/dashboard*` and `/sign-in*` (hard rule 3), SDK events
 *     outside `SDK_EVENTS`, and our own events outside `customEvents`.
 *  2. Our own events are dropped if a required property is missing or fails
 *     its rule, and keep only their allow-listed properties whose values pass
 *     their rules, plus `token`, `distinct_id`, `environment` and the SDK
 *     context in `SDK_CONTEXT_PROPS` (cleaned below); no person properties.
 *  3. Everywhere: deletes `STRIPPED_PROPS` and campaign parameters; strips
 *     query string and fragment from every URL and every `…pathname`; a
 *     previous page or referrer inside an untracked route is removed (the
 *     `$prev_pageview_*` group with it) or cut to the origin.
 *  4. Sets `environment` and `$geoip_disable: true`.
 */
export function sanitizeEvent(
  event: CaptureResult | null,
  { environment, customEvents = ANALYTICS_EVENTS, origin = currentOrigin() }: SanitizeOptions,
): CaptureResult | null {
  if (!event) return null
  const name = event.event
  const custom = !name.startsWith("$")
  if (custom ? !Object.hasOwn(customEvents, name) : !SDK_EVENTS.includes(name)) return null

  const props = event.properties ?? {}
  if (isUntrackedPath(eventPathname(props))) return null

  if (custom) {
    // The same rule as `track()`: a required property missing or failing its
    // rule stops the event; other properties keep only valid values.
    const own = allowedProps(customEvents, name, props)
    if (!own) return null
    for (const key of Object.keys(props)) {
      if (REQUIRED_PROPS.includes(key) || Object.hasOwn(own, key) || isSdkContextProp(key)) continue
      delete props[key]
    }
    // Nobody is identified: our events write no person properties.
    delete event.$set
    delete event.$set_once
  }

  // The previous page's numbers describe it: they go with its path.
  if (
    typeof props.$prev_pageview_pathname === "string" &&
    isUntrackedPath(props.$prev_pageview_pathname.split(/[?#]/)[0] ?? "")
  ) {
    for (const key of Object.keys(props)) {
      if (key.startsWith("$prev_pageview_")) delete props[key]
    }
  }

  cleanProps(props, origin)
  for (const person of [event.$set, event.$set_once]) {
    if (person) cleanProps(person, origin)
  }
  Object.assign(props, superProperties(environment))
  event.properties = props
  return event
}

// --- the client -------------------------------------------------------------------------------

type PostHogModule = { default: PostHog }

export type StartOptions = {
  /** The project token; unset means analytics never loads. */
  key?: string
  /** The `environment` every event carries. */
  environment?: string
  customEvents?: CustomEventProps
  /** How the package is fetched (tests count the calls). */
  load?: () => Promise<PostHogModule>
}

/** The initialised instance, kept across a withdrawal so a new grant on the
 * same page can opt it back in (posthog-js initialises once per page). */
let instance: PostHog | null = null
/** Whether the instance may send right now. */
let capturing = false
let loading: Promise<void> | null = null
let stopListening: (() => void) | null = null

/**
 * The PostHog instance while the visitor's consent is in force and the
 * client is running, else null. For ENG-5 (`track`) and ENG-6
 * (`captureException`): call it at the moment of use, never cache it.
 */
export function getPostHog(): PostHog | null {
  return capturing ? instance : null
}

/**
 * The instance once a package load that is under way has finished (a grant
 * on this page load starts it before hydration, so a view event fired on
 * mount would otherwise find nothing yet), else at once; null whenever
 * nothing may be sent.
 */
export function posthogReady(): Promise<PostHog | null> {
  return (loading ?? Promise.resolve()).then(getPostHog)
}

function webdriver(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true
}

/**
 * Starts the client for this page: clears leftover analytics storage unless
 * consent is granted, then follows the consent store. Idempotent. Returns the
 * stop function (tests; a page never stops it).
 */
export function startAnalytics({
  // Literal member expressions: Next inlines `NEXT_PUBLIC_*` only in this form.
  key = process.env.NEXT_PUBLIC_POSTHOG_KEY,
  environment = process.env.NEXT_PUBLIC_POSTHOG_ENV ?? "development",
  customEvents = ANALYTICS_EVENTS,
  load = () => import("posthog-js"),
}: StartOptions = {}): () => void {
  if (stopListening) return stopListening
  if (typeof window === "undefined") return () => {}

  const enabled = Boolean(key) && !webdriver()

  // Run now and on every change of choice. Anything short of a grant ends in
  // `withdraw()`, which clears leftover analytics storage: on every page load
  // without a grant too, with or without a key.
  const apply = () => {
    if (getConsent() === "granted") {
      if (enabled && key) grant(key, environment, customEvents, load)
    } else {
      withdraw()
    }
  }
  const unsubscribe = onConsentChange(apply)
  apply()

  stopListening = () => {
    unsubscribe()
    stopListening = null
  }
  return stopListening
}

function grant(
  key: string,
  environment: string,
  customEvents: CustomEventProps,
  load: () => Promise<PostHogModule>,
): void {
  if (instance) {
    if (capturing) return
    resume(instance, environment)
    return
  }
  if (loading) return
  loading = load()
    .then(({ default: posthog }) => {
      // The visitor may have withdrawn (or the client stopped) while the
      // package downloaded.
      if (instance || !stopListening || getConsent() !== "granted") return
      posthog.init(key, {
        ...posthogConfig(environment, customEvents),
        loaded: () => {
          posthog.register(superProperties(environment))
          // A stale opt-out flag of PostHog's own must not override a grant.
          if (posthog.has_opted_out_capturing()) {
            posthog.opt_in_capturing({ captureEventName: false })
          }
        },
      })
      instance = posthog
      capturing = true
    })
    .catch(() => {
      // Blocked by an extension or offline: analytics just stays off.
    })
    .finally(() => {
      loading = null
    })
}

/** A new grant on a page whose instance was withdrawn earlier. */
function resume(client: PostHog, environment: string): void {
  try {
    client.set_config({ disable_persistence: false, opt_out_capturing_by_default: false })
    client.opt_in_capturing({ captureEventName: false })
    client.register(superProperties(environment))
    capturing = true
  } catch {
    capturing = false
  }
}

/** Stops sending at once and erases what PostHog stored on the device. */
function withdraw(): void {
  const client = instance
  capturing = false
  if (client) {
    try {
      // `reset()` first: it also forgets PostHog's own consent flag, and
      // `clearAnalyticsStorage()` below deletes it from storage, after which
      // the SDK would read "pending" and capture again (seen in a browser
      // run). Opted out by default, "pending" means no; persistence off
      // removes persisted state and stops later (debounced) writes.
      client.reset()
      client.set_config({ disable_persistence: true, opt_out_capturing_by_default: true })
      client.opt_out_capturing()
    } catch {
      // Whatever happened, the storage below still goes.
    }
  }
  clearAnalyticsStorage()
}

/** Forgets the instance (tests only: a page initialises posthog-js once). */
export function resetAnalyticsForTests(): void {
  stopListening?.()
  instance = null
  capturing = false
  loading = null
}

/** The pending package load, if any (tests). */
export function analyticsLoading(): Promise<void> {
  return loading ?? Promise.resolve()
}
