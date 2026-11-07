import { fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { eventFeedXml, FEED_CACHE } from "@/lib/event-feed"

/**
 * `GET /events.atom` — the newly listed events as Atom (lib/event-feed.ts):
 * the pages a search engine should learn of first, read from
 * `eventFeed.newest`. Rendered per request and cached at the edge for an
 * hour, like the sitemaps; a backend failure is a 503, never an empty feed
 * that would read as "nothing new".
 */

export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  try {
    const events = await fetchQuery(api.eventFeed.newest, {})
    return new Response(eventFeedXml(events, Date.now()), {
      headers: {
        "Content-Type": "application/atom+xml; charset=utf-8",
        "Cache-Control": FEED_CACHE,
      },
    })
  } catch (error) {
    console.error("events.atom failed", error)
    return new Response("The feed could not be read just now. Try again later.", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "600",
      },
    })
  }
}
