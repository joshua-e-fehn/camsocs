import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import { getToken } from "./auth-server"
import { eventIcsFile } from "./ics"
import { countIcsFetch } from "./ics-telemetry"
import { SITE_URL } from "./site"
import { eventIcsPath, eventPath, talksBoundaryRedirect } from "./talks-boundary"
import { isEventKey } from "./url-state"

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

/**
 * One society event as an `.ics` file ("Add to calendar" → Apple Calendar /
 * Outlook on the desktop), for `GET /events/<key>/ics` and — a talks.cam-
 * derived event (owner decision G1, lib/talks-boundary.ts) —
 * `GET /talks/events/<key>/ics`. A talks.cam-derived event asked for outside
 * /talks answers 308 there, before any of the event is written: talks.cam's
 * words stay under /talks. Never the other way (`talksBoundaryRedirect`):
 * any event's file may be served under /talks, its URL the event's own page.
 *
 * UID `<key>@camsocs.uk`, the event's page here as its URL. Read with the
 * viewer's session, so a verified Cambridge reader can add a Cambridge-only
 * event — and that file is never cached by a shared cache. An unknown or
 * hidden event is a 404. A served file is counted after the response
 * (`ics_feed_fetched { feed: "event", key }`; ENG-7, lib/ics-telemetry.ts).
 */
export async function eventIcsResponse(key: string, underTalks: boolean): Promise<Response> {
  if (!isEventKey(key)) return plain("Not an event.", 404)
  let event: FunctionReturnType<typeof api.events.get>
  try {
    event = await fetchQuery(api.events.get, { key }, { token: await getToken() })
  } catch {
    return plain("The event could not be read just now. Try again later.", 503)
  }
  if (!event) return plain("This event is not listed, or it is Cambridge-only.", 404)
  if (talksBoundaryRedirect(event, underTalks) !== null) {
    // Site-relative, so a preview or local deployment stays on its own host.
    return new Response(null, {
      status: 308,
      headers: { Location: eventIcsPath(event), "Cache-Control": "no-store" },
    })
  }
  // A venue known only by its key is still the LOCATION (as on the page).
  let venueText = event.venueText
  if (!venueText && event.venueKey) {
    const venue = await fetchQuery(api.venues.get, { key: event.venueKey }).catch(() => null)
    venueText = venue?.name
  }
  const { body, filename } = eventIcsFile(
    { ...event, venueText },
    `${SITE_URL}${eventPath(event)}`,
    Date.now(),
  )
  countIcsFetch("event", event.key)
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":
        event.visibility === "public"
          ? "public, s-maxage=3600, stale-while-revalidate=86400"
          : "private, no-store",
    },
  })
}
