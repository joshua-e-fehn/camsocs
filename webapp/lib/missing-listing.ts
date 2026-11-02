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
 * `events.exists`, `talks.exists`) and none for a malformed key, a router
 * prefetch or a method other than GET / HEAD.
 */

export type ListingKind = "society" | "event" | "talk"

/** Request header the proxy sets on its rewrite; `app/not-found.tsx` reads it
 * to show the site's own not-found page for that kind of listing. */
export const MISSING_LISTING_HEADER = "x-camsocs-missing-listing"

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
  talks: { kind: "talk", wellFormed: isTalkKey, siblings: ["departments"] },
} as const satisfies Record<string, Section>

export type ListingPath = { kind: ListingKind; key: string; wellFormed: boolean }

const LISTING_PATH = /^\/(societies|events|talks)\/([^/]+)\/?$/

/** The listing a pathname names (`/societies/<slug>`, `/events/<key>`,
 * `/talks/<key>`), or null for any other path. */
export function listingPath(pathname: string): ListingPath | null {
  const match = LISTING_PATH.exec(pathname)
  if (!match) return null
  const section: Section = LISTING_SECTIONS[match[1] as keyof typeof LISTING_SECTIONS]
  let key = match[2]
  try {
    key = decodeURIComponent(key)
  } catch {
    // A malformed escape is a malformed key.
  }
  if (section.siblings.includes(key)) return null
  return { kind: section.kind, key, wellFormed: section.wellFormed(key) }
}

/** A Next router prefetch or a browser speculative prefetch. */
export function isPrefetch(headers: Headers): boolean {
  return (
    headers.get("next-router-prefetch") === "1" ||
    headers.get("sec-purpose")?.includes("prefetch") === true ||
    headers.get("purpose") === "prefetch"
  )
}

export type ListingExists = (listing: { kind: ListingKind; key: string }) => Promise<boolean>

/**
 * The proxy's decision for one request: the kind of listing to answer with a
 * 404, or null to let the request through to the page.
 *
 * - A malformed key is missing, without asking Convex.
 * - A prefetch is let through unchecked: the directory and calendar prefetch
 *   every visible link, and the navigation that follows is checked.
 * - A failed check lets the request through: the page's own `notFound()`
 *   still answers (as a noindex soft 404), so an outage never 404s a real
 *   listing.
 */
export async function missingListing(
  request: { pathname: string; method: string; headers: Headers },
  exists: ListingExists,
): Promise<ListingKind | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const listing = listingPath(request.pathname)
  if (!listing) return null
  if (!listing.wellFormed) return listing.kind
  if (isPrefetch(request.headers)) return null
  try {
    return (await exists(listing)) ? null : listing.kind
  } catch {
    return null
  }
}

/** The header's value as a listing kind; null when absent or not one. */
export function missingListingKind(value: string | null | undefined): ListingKind | null {
  return value === "society" || value === "event" || value === "talk" ? value : null
}
