import { talksEventPath } from "./talks-boundary"
import { isTalkKey } from "./talks-url-state"
import { isEventKey, isOrgSlug } from "./url-state"

/**
 * Real 404s for unknown listing URLs (ENG-20), decided in `proxy.ts` before
 * any page renders.
 *
 * Why not in the page or a segment layout: Next 16 sends the status with the
 * first byte. A `notFound()` under a `loading.tsx` comes after a 200 (Next
 * marks the page noindex instead, a soft 404); one outside every Suspense
 * boundary does get a 404, but React cannot server-render a not-found
 * boundary, so Next sends an empty `<html id="__next_error__">` shell and the
 * not-found page appears only once JavaScript runs (app-render.js
 * `getErrorRSCPayload`). A request rewritten to a path no route matches is
 * different: Next renders `app/not-found.tsx` as a page, with status 404 and
 * the whole UI in the HTML. That is what the proxy does for a missing listing.
 *
 * The check costs one small indexed Convex query (`orgs.exists`,
 * `events.locate`, `talks.exists`), none for a malformed key, a method other
 * than GET / HEAD or a listing found in the last minute, and the proxy never
 * runs for a prefetch (its matcher).
 *
 * The same check keeps the talks boundary (owner decision G1,
 * lib/talks-boundary.ts): a talks.cam-derived society event's page is
 * `/talks/events/<key>`, behind the /talks robots rule, so `/events/<key>`
 * answers it with a 308 there. Never back: `/talks/events/<key>` of any
 * other event renders it, canonical `/events/<key>` — this check is fresh
 * and the page's is cached, and two-way redirects between them looped when
 * the two disagreed (`talksBoundaryRedirect`).
 */

export type ListingKind = "society" | "event" | "talk"

/** Where the proxy rewrites a missing listing: no route matches it, so Next
 * answers with `app/not-found.tsx` and status 404. The browser keeps its URL. */
export const MISSING_LISTING_PATH = "/_missing-listing"

type Section = {
  kind: ListingKind
  wellFormed: (key: string) => boolean
  /** Static routes beside the dynamic segment, e.g. `/talks/departments`:
   * the proxy runs before routing, so it must let them through.
   * missing-listing.test.ts fails when a new one is not listed here. */
  siblings: readonly string[]
}

export const LISTING_SECTIONS = {
  societies: { kind: "society", wellFormed: isOrgSlug, siblings: [] },
  events: { kind: "event", wellFormed: isEventKey, siblings: [] },
  // `events`: talks.cam-derived society events, /talks/events/<key> (G1).
  talks: { kind: "talk", wellFormed: isTalkKey, siblings: ["departments", "events"] },
} as const satisfies Record<string, Section>

export type ListingPath = {
  kind: ListingKind
  key: string
  wellFormed: boolean
  /** `/talks/events/<key>`: an event's page under the talks prefix (G1). */
  underTalks?: true
}

const LISTING_PATH = /^\/(societies|events|talks)\/([^/]+)\/?$/
const TALKS_EVENT_PATH = /^\/talks\/events\/([^/]+)\/?$/

function decoded(key: string): string {
  try {
    return decodeURIComponent(key)
  } catch {
    // A malformed escape is a malformed key.
    return key
  }
}

/** The listing a pathname names (`/societies/<slug>`, `/events/<key>`,
 * `/talks/<key>`, `/talks/events/<key>`), or null for any other path. */
export function listingPath(pathname: string): ListingPath | null {
  const talksEvent = TALKS_EVENT_PATH.exec(pathname)
  if (talksEvent) {
    const key = decoded(talksEvent[1])
    return {
      kind: "event",
      key,
      wellFormed: LISTING_SECTIONS.events.wellFormed(key),
      underTalks: true,
    }
  }
  const match = LISTING_PATH.exec(pathname)
  if (!match) return null
  const section: Section = LISTING_SECTIONS[match[1] as keyof typeof LISTING_SECTIONS]
  const key = decoded(match[2])
  if (section.siblings.includes(key)) return null
  return { kind: section.kind, key, wellFormed: section.wellFormed(key) }
}

/** A browser speculative prefetch. The proxy's matcher already keeps these
 * and Next router prefetches away; `next-router-prefetch` is not checked
 * here because Next strips it from the headers a proxy sees. */
export function isPrefetch(headers: Headers): boolean {
  return (
    headers.get("sec-purpose")?.includes("prefetch") === true ||
    headers.get("purpose") === "prefetch"
  )
}

/**
 * How long a found listing is remembered: the (site) layout's `revalidate`
 * (app/(site)/layout.tsx), in milliseconds. The proxy runs before Vercel's
 * edge cache, so this check is the one Convex read left on a cached page
 * view (SEO audit 2026-11-02, per-request-convex-fanout); a listing hidden
 * since is served from that cache for as long anyway, and a missing one is
 * never remembered. lib/missing-listing.test.ts holds the two equal.
 */
export const FOUND_TTL_MS = 300_000

/** What a listing check answers: `found`, `missing`, or — an event only —
 * `talks`, a talks.cam-derived event whose page is under /talks (G1), or
 * `movedTo`, the site-relative page of the event that superseded this key
 * (ENG-47). */
export type ListingState = "found" | "missing" | "talks" | { movedTo: string }

/** What `events.locate` answers (convex/events.ts). */
export type EventLocation = "missing" | "event" | "talks" | { supersededBy: string; talks: boolean }

/**
 * `events.locate`'s answer as the gate's state: a superseded key (ENG-47)
 * moves to its survivor's own page — under /talks for a talks.cam-derived
 * survivor (G1), so the reader takes one hop, not two. A survivor that is not
 * an event key is treated as missing rather than redirected to.
 */
export function eventListingState(where: EventLocation): ListingState {
  if (typeof where === "object") {
    if (!isEventKey(where.supersededBy)) return "missing"
    const key = where.supersededBy
    return { movedTo: where.talks ? talksEventPath(key) : `/events/${key}` }
  }
  return where === "event" ? "found" : where
}

export type ListingLookup = (listing: { kind: ListingKind; key: string }) => Promise<ListingState>

/** The proxy's answer to one request. */
export type ListingGate =
  | { action: "next" }
  | { action: "missing"; kind: ListingKind }
  /** A 308 to this site-relative path, never stored (proxy.ts). */
  | { action: "redirect"; path: string }

const NEXT: ListingGate = { action: "next" }

/**
 * The proxy's decision for one request: a 404 for a missing listing, a 308
 * from `/events/<key>` to `/talks/events/<key>` for a talks.cam-derived
 * event (G1), a 308 from a superseded event key, under either prefix, to the
 * page of the event that took it over (ENG-47: always another key, so no
 * loop), or let it through to the page.
 *
 * - A malformed key is missing, without asking Convex.
 * - A prefetch is let through unchecked: the directory and calendar prefetch
 *   every visible link, and the navigation that follows is checked.
 * - A failed or slow check (`withTimeout`) lets the request through: the
 *   page's own `notFound()` still answers (as a noindex soft 404), so an
 *   outage never 404s a real listing; `/events/<key>` redirects a
 *   talks.cam-derived event itself too.
 */
export async function listingGate(
  request: { pathname: string; method: string; headers: Headers },
  lookup: ListingLookup,
): Promise<ListingGate> {
  if (request.method !== "GET" && request.method !== "HEAD") return NEXT
  const listing = listingPath(request.pathname)
  if (!listing) return NEXT
  if (!listing.wellFormed) return { action: "missing", kind: listing.kind }
  if (isPrefetch(request.headers)) return NEXT
  let state: ListingState
  try {
    state = await lookup({ kind: listing.kind, key: listing.key })
  } catch {
    return NEXT
  }
  if (state === "missing") return { action: "missing", kind: listing.kind }
  if (typeof state === "object") return { action: "redirect", path: state.movedTo }
  if (listing.kind === "event" && state === "talks" && !listing.underTalks) {
    return { action: "redirect", path: talksEventPath(listing.key) }
  }
  return NEXT
}

/** `lookup`, failing when it has not answered within `ms`. */
export function withTimeout(lookup: ListingLookup, ms: number): ListingLookup {
  return (listing) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`listing check timed out after ${ms} ms`)), ms)
    })
    return Promise.race([lookup(listing), timeout]).finally(() => clearTimeout(timer))
  }
}

/**
 * `lookup`, remembering a found listing (and where it lives) for `ttlMs` (at
 * most `max` of them, oldest dropped first). The answer is the same for every
 * viewer, so repeat views skip the round trip. A missing one is never
 * remembered, so a listing added a moment ago is not 404'd; one hidden since
 * it was remembered falls back to the page's own `notFound()` for up to
 * `ttlMs`.
 */
export function rememberFound(
  lookup: ListingLookup,
  { ttlMs, max, now = Date.now }: { ttlMs: number; max: number; now?: () => number },
): ListingLookup {
  const found = new Map<string, { until: number; state: ListingState }>()
  return async (listing) => {
    const id = `${listing.kind}:${listing.key}`
    const hit = found.get(id)
    if (hit !== undefined) {
      if (hit.until > now()) return hit.state
      found.delete(id)
    }
    const state = await lookup(listing)
    if (state === "missing") return state
    found.delete(id)
    if (found.size >= max) {
      const oldest = found.keys().next().value
      if (oldest !== undefined) found.delete(oldest)
    }
    found.set(id, { until: now() + ttlMs, state })
    return state
  }
}
