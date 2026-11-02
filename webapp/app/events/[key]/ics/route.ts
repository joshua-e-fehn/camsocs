import { fetchQuery } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import type { NextRequest } from "next/server"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { eventIcsFile } from "@/lib/ics"
import { countIcsFetch } from "@/lib/ics-telemetry"
import { SITE_URL } from "@/lib/site"
import { isEventKey } from "@/lib/url-state"

/**
 * `GET /events/<key>/ics` — one event as an `.ics` file ("Add to calendar" →
 * Apple Calendar / Outlook on the desktop): UID `<key>@camsocs.uk`, the
 * event's page here as its URL; one of the University's own listings says
 * it is listed in the University's public events programme, with its page
 * there (ENG-24, lib/ics.ts `eventIcsFile`). Read with the
 * viewer's session, so a verified Cambridge reader can add a Cambridge-only
 * event — and that file is never cached by a shared cache. An unknown or
 * hidden event is a 404. A served file is counted after the response
 * (`ics_feed_fetched { feed: "event", key }`; ENG-7, lib/ics-telemetry.ts).
 */

export const dynamic = "force-dynamic"

function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  })
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params
  if (!isEventKey(key)) return plain("Not an event.", 404)
  let event: FunctionReturnType<typeof api.events.get>
  try {
    event = await fetchQuery(api.events.get, { key }, { token: await getToken() })
  } catch {
    return plain("The event could not be read just now. Try again later.", 503)
  }
  if (!event) return plain("This event is not listed, or it is Cambridge-only.", 404)
  // A venue known only by its key is still the LOCATION (as on the page).
  let venueText = event.venueText
  if (!venueText && event.venueKey) {
    const venues = await fetchQuery(api.venues.list, {}).catch(() => [])
    venueText = venues.find((venue) => venue.key === event.venueKey)?.name
  }
  const { body, filename } = eventIcsFile(
    { ...event, venueText },
    `${SITE_URL}/events/${event.key}`,
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
