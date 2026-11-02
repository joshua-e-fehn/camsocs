import { fetchQuery } from "convex/nextjs"
import { type NextRequest, NextResponse } from "next/server"
import { api } from "@/convex/_generated/api"
import {
  type ListingExists,
  MISSING_LISTING_HEADER,
  MISSING_LISTING_PATH,
  missingListing,
  rememberFound,
  withTimeout,
} from "@/lib/missing-listing"

/**
 * Next.js middleware (named `proxy` since Next 16), on listing pages only:
 * an unknown society, event or talk URL is answered with a real 404 and the
 * site's not-found page rendered on the server (ENG-20; why it cannot happen
 * in the page: lib/missing-listing.ts).
 *
 * It decides nothing about access: Convex functions enforce that, and the
 * existence queries are public and viewer-independent. Everything else
 * bypasses it (the matcher), as before the catch-all no-op proxy was removed
 * for CPU (docs/deploy.md "CPU protection").
 */
export async function proxy(request: NextRequest) {
  // Only this proxy may name a missing listing to app/not-found.tsx; a
  // visitor's own copy of the header is dropped (the last matcher entry).
  const headers = new Headers(request.headers)
  headers.delete(MISSING_LISTING_HEADER)
  const kind = await missingListing(
    { pathname: request.nextUrl.pathname, method: request.method, headers },
    listingExists,
  )
  if (!kind) return NextResponse.next({ request: { headers } })
  headers.set(MISSING_LISTING_HEADER, kind)
  return NextResponse.rewrite(new URL(MISSING_LISTING_PATH, request.url), { request: { headers } })
}

/** One indexed Convex query, anonymous: whether the listing exists at all is
 * the same for every viewer. A slow answer counts as a failed one (the page
 * answers), and a found listing is remembered for a minute per instance. */
const listingExists: ListingExists = rememberFound(
  withTimeout(async ({ kind, key }) => {
    try {
      switch (kind) {
        case "society":
          return await fetchQuery(api.orgs.exists, { slug: key })
        case "event":
          return await fetchQuery(api.events.exists, { key })
        case "talk":
          return await fetchQuery(api.talks.exists, { key })
      }
    } catch (error) {
      // The kind only: the key is a visitor's URL.
      console.error(`listing existence check failed (${kind})`, error)
      throw error
    }
  }, 800),
  { ttlMs: 60_000, max: 5_000 },
)

/** Prefetches skip the proxy here, in the matcher: Next strips
 * `next-router-prefetch` (and `rsc`) from `request.headers` before the proxy
 * sees them (proxy.md "RSC requests and rewrites"). The values must be
 * literals for Next's static analysis. */
export const config = {
  // One segment after each section; `/events/<key>/ics` and the like are
  // not matched. Static siblings such as /talks/departments are let through
  // by lib/missing-listing.ts.
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
    {
      source: "/talks/:key",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose", value: ".*prefetch.*" },
      ],
    },
    // Any request that brings its own x-camsocs-missing-listing header, so
    // the proxy can drop it; no ordinary request carries one.
    { source: "/:path*", has: [{ type: "header", key: "x-camsocs-missing-listing" }] },
  ],
}
