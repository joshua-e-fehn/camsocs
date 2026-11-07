import { fetchQuery } from "convex/nextjs"
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server"
import { api } from "@/convex/_generated/api"
import { refusesAiAgent } from "@/lib/crawlers"
import {
  eventListingState,
  FOUND_TTL_MS,
  type ListingLookup,
  listingGate,
  MISSING_LISTING_PATH,
  rememberFound,
  withTimeout,
} from "@/lib/missing-listing"
import { captureServerEvent } from "@/lib/posthog-server"
import { visitFacts } from "@/lib/visit-count"

/**
 * Next.js middleware (named `proxy` since Next 16), on listing pages only:
 * an unknown society, event or talk URL is answered with a real 404 and the
 * site's not-found page rendered on the server (ENG-20; why it cannot happen
 * in the page: lib/missing-listing.ts), and a talks.cam-derived society event
 * is sent to its page under /talks with a 308 (owner decision G1,
 * lib/talks-boundary.ts) before anything of it is rendered outside /talks,
 * and an event key another source's event superseded (ENG-47) is sent to that
 * event's page with a 308.
 * On the talks pillar it also refuses AI agents with a 403 (lib/crawlers.ts
 * `refusesAiAgent`): robots.txt asks them to stay out, and not every
 * user-triggered fetcher reads it.
 *
 * On the public pages it also counts a visit (lib/visit-count.ts): a
 * browser's top-level page load, reduced to the kind of page and the kind of
 * site it came from, sent to PostHog after the response (`waitUntil`) as the
 * `page_visit` server event. Nothing is read from or stored on the device.
 *
 * It decides nothing about access: Convex functions enforce that, and the
 * existence queries are public and viewer-independent. Everything else
 * bypasses it (the matcher), as before the catch-all no-op proxy was removed
 * for CPU (docs/deploy.md "CPU protection").
 */
export async function proxy(request: NextRequest, event?: NextFetchEvent) {
  if (refusesAiAgent(request.nextUrl.pathname, request.headers.get("user-agent"))) {
    return new NextResponse("AI agents may not read the talks pages (see /robots.txt).", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  }
  const gate = await listingGate(
    { pathname: request.nextUrl.pathname, method: request.method, headers: request.headers },
    listingLookup,
  )
  if (gate.action === "redirect") return boundaryRedirect(request.nextUrl, gate.path)
  if (gate.action === "next") {
    countVisit(request, event)
    return NextResponse.next()
  }
  return NextResponse.rewrite(new URL(MISSING_LISTING_PATH, request.url))
}

/** One `page_visit` for a page we serve as it is (never a 404 or a
 * redirect), sent after the response; `captureServerEvent` never rejects and
 * is a no-op without a PostHog key. */
function countVisit(request: NextRequest, event: NextFetchEvent | undefined): void {
  const facts = visitFacts({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
    siteHost: request.nextUrl.hostname,
  })
  if (facts && event) event.waitUntil(captureServerEvent("page_visit", facts))
}

/**
 * The talks boundary's 308 (lib/missing-listing.ts `listingGate`), on the
 * request's own host. Permanent in meaning (a search engine moves the URL)
 * but never stored: an event's verdict can change with a later harvest, and
 * no browser may keep a redirect the data no longer backs (review of the SEO
 * audit, talks-boundary-redirect-loop).
 */
export function boundaryRedirect(from: { href: string }, path: string): NextResponse {
  const to = new URL(from.href)
  to.pathname = path
  const response = NextResponse.redirect(to, 308)
  response.headers.set("Cache-Control", "no-store")
  return response
}

/** One indexed Convex query, anonymous: whether the listing exists at all
 * (and, for an event, which side of the talks boundary it lives on) is the
 * same for every viewer. A slow answer counts as a failed one (the page
 * answers), and a found listing is remembered per instance for as long as
 * its page is cached at the edge (`FOUND_TTL_MS`); a superseded key's
 * redirect is asked afresh every time (`rememberFound`). */
const listingLookup: ListingLookup = rememberFound(
  withTimeout(async ({ kind, key }) => {
    try {
      switch (kind) {
        case "society":
          return (await fetchQuery(api.orgs.exists, { slug: key })) ? "found" : "missing"
        case "event":
          return eventListingState(await fetchQuery(api.events.locate, { key }))
        case "talk":
          return (await fetchQuery(api.talks.exists, { key })) ? "found" : "missing"
      }
    } catch (error) {
      // The kind only: the key is a visitor's URL.
      console.error(`listing existence check failed (${kind})`, error)
      throw error
    }
  }, 800),
  { ttlMs: FOUND_TTL_MS, max: 5_000 },
)

/** Prefetches skip the proxy here, in the matcher: Next strips
 * `next-router-prefetch` (and `rsc`) from `request.headers` before the proxy
 * sees them (proxy.md "RSC requests and rewrites"). The values must be
 * literals for Next's static analysis. */
export const config = {
  // One segment after /societies and /events; `/events/<key>/ics` is not
  // matched. Static siblings such as /talks/departments are let through by
  // lib/missing-listing.ts.
  matcher: [
    {
      source: "/societies/:key",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/events/:key",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    // The other public pages, for the visit count only (lib/visit-count.ts);
    // the gate lets them through untouched.
    {
      source: "/",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/societies",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/events",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/categories/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/term-dates",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/colleges",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/for/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/guides/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/about",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/privacy",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/terms",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/request",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    {
      source: "/guides/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    // The whole talks pillar, for the AI-agent 403 (and the listing check
    // on /talks/<key> and /talks/events/<key>); `/talks/:path*` includes
    // /talks itself. Prefetches too: an agent that sends `Purpose: prefetch`
    // must not walk past the 403 (review of 2026-11-02). A browser's
    // speculative prefetch is then let through unchecked by the gate
    // (`isPrefetch`); a router prefetch of a talk costs one remembered
    // existence lookup, as its navigation would.
    { source: "/talks/:path*" },
    { source: "/talks.ics" },
  ],
}
