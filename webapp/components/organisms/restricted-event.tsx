"use client"

import { EventPage } from "@/components/organisms/event-page"
import { useSignedInEvent } from "@/hooks/convex/events"
import type { EventPublic } from "@/lib/public-api"
import { talksBoundaryRedirect } from "@/lib/talks-boundary"

/** Whether the signed-in reader's event may be drawn on this page: never a
 * talks.cam-derived one outside /talks (owner decision G1); any event under
 * /talks (`talksBoundaryRedirect`). proxy.ts sends a talks.cam-derived event
 * to /talks before anything renders; this only keeps the browser from
 * drawing one outside should that check have failed. */
export function belongsHere(event: EventPublic | null | undefined, underTalks: boolean) {
  return event != null && talksBoundaryRedirect(event, underTalks) === null
}

/**
 * An event page a signed-out reader is told is not available (`children`:
 * `EventUnavailable`), in the browser: every event page is one cached,
 * anonymous render (docs/webapp.md "Caching"), so a Cambridge-only event is
 * "not available" there. Once a signed-in reader's session reaches the
 * Convex client, the event itself replaces that page if they may see it (a
 * verified @cam.ac.uk address, or the broker). It stays noindex: the
 * metadata is the cached page's.
 *
 * The server's render and the first client render are `children`, so nothing
 * changes at hydration. The venue's name and the term-week tag, decoration the
 * server adds for public events, are left out here.
 */
export function RestrictedEvent({
  eventKey,
  underTalks,
  children,
}: {
  eventKey: string
  /** `/talks/events/<key>` rather than `/events/<key>`. */
  underTalks: boolean
  children: React.ReactNode
}) {
  const event = useSignedInEvent(eventKey)
  if (!belongsHere(event, underTalks) || !event) return <>{children}</>
  return <EventPage event={event} now={Date.now()} />
}
