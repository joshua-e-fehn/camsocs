import { fetchQuery } from "convex/nextjs"
import { type NextRequest, NextResponse } from "next/server"
import { api } from "@/convex/_generated/api"
import {
  type ListingExists,
  MISSING_LISTING_HEADER,
  MISSING_LISTING_PATH,
  missingListing,
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
  const kind = await missingListing(
    { pathname: request.nextUrl.pathname, method: request.method, headers: request.headers },
    listingExists,
  )
  if (!kind) return NextResponse.next()
  const headers = new Headers(request.headers)
  headers.set(MISSING_LISTING_HEADER, kind)
  return NextResponse.rewrite(new URL(MISSING_LISTING_PATH, request.url), { request: { headers } })
}

/** One indexed Convex query, anonymous: whether the listing exists at all is
 * the same for every viewer. */
const listingExists: ListingExists = async ({ kind, key }) => {
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
}

export const config = {
  // One segment after each section; `/events/<key>/ics` and the like are
  // not matched. Static siblings such as /talks/departments are let through
  // by lib/missing-listing.ts.
  matcher: ["/societies/:key", "/events/:key", "/talks/:key"],
}
