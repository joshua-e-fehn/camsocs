import { fetchQuery } from "convex/nextjs"
import type { NextRequest } from "next/server"
import { api } from "@/convex/_generated/api"
import { DAY_MS, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { eventsCalendar } from "@/lib/ics"
import { countIcsFetch } from "@/lib/ics-telemetry"
import { SITE_URL } from "@/lib/site"
import { isOrgSlug } from "@/lib/url-state"

/**
 * `GET /events.ics` — the events calendar feed (SEO audit
 * "calendar-feeds-discovery"): the public events of the next 60 days from
 * the start of today (London), or one society's (`?org=<slug>`), as RFC
 * 5545; /events and its pages advertise it as their `text/calendar`
 * alternate. Anonymous, so never a Cambridge-only event, and never a
 * talks.cam-derived one (owner decision G1: `events.list` leaves them out,
 * and the feed checks again). Not "taking part" events (D6), as the
 * calendar's default; the University's own listings (ENG-24) are in the
 * whole-site feed, also as the calendar's default, so it is named
 * "Cambridge events", not "society events" (review of the ENG-24 merge,
 * 2026-11-02). It shares `events.list`'s 1,000-row cap with them, society
 * events first (ENG-31), so in a Festival window the feed can lose only the
 * University's later days; `university: "hide"` reads the society stream
 * alone (see docs/webapp.md `events.list`).
 *
 * Cached at the edge for an hour per URL, like `/talks.ics`. A served feed
 * is counted after the response (`ics_feed_fetched { feed: "events" }`,
 * never its society; ENG-7, lib/ics-telemetry.ts).
 */

export const dynamic = "force-dynamic"

/** `events.list` returns at most this window per call (`MAX_WINDOW_MS`). */
const WINDOW_DAYS = 60

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

export async function GET(request: NextRequest): Promise<Response> {
  const slug = request.nextUrl.searchParams.get("org") ?? undefined
  if (slug !== undefined && !isOrgSlug(slug)) return plain("Not a society.", 400)
  const now = Date.now()
  const from = londonMidnight(londonIsoDate(now))
  const to = from + WINDOW_DAYS * DAY_MS

  let read: Awaited<ReturnType<typeof readFeed>>
  try {
    read = await readFeed(from, to, slug)
  } catch {
    return plain("The events could not be read just now. Try again later.", 503)
  }
  if (!read) return plain("No such society.", 404)
  const { name, events, venues } = read

  const body = eventsCalendar(
    events
      .filter((event) => event.visibility === "public" && !event.talksDerived)
      .map((event) => ({
        ...event,
        venueText: event.venueText ?? (event.venueKey ? venues.get(event.venueKey) : undefined),
      })),
    { name, now, pageUrl: (key) => `${SITE_URL}/events/${key}` },
  )
  countIcsFetch("events")
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="camsocs-events.ics"',
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  })
}

/** The feed's name, events and venue names; null for an unknown society. */
async function readFeed(from: number, to: number, slug: string | undefined) {
  const [page, events, venues] = await Promise.all([
    slug ? fetchQuery(api.orgs.getBySlug, { slug }) : undefined,
    fetchQuery(api.events.list, {
      from,
      to,
      includeTakingPart: false,
      ...(slug ? { orgKey: `org-${slug}` } : {}),
    }),
    fetchQuery(api.venues.list, {}),
  ])
  if (page === null) return null
  return {
    name: page ? `${page.org.name} · CAMsocs` : "Cambridge events · CAMsocs",
    events,
    venues: new Map(venues.map((venue) => [venue.key, venue.name])),
  }
}
