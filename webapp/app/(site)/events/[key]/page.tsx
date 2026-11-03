import type { Metadata } from "next"
import { notFound, permanentRedirect } from "next/navigation"
import { EventPage, EventUnavailable } from "@/components/organisms/event-page"
import { RestrictedEvent } from "@/components/organisms/restricted-event"
import { londonIsoDate } from "@/lib/calendar"
import {
  eventMetadata,
  loadEvent,
  loadTerms,
  loadVenue,
  UNAVAILABLE_METADATA,
  venueNameOf,
} from "@/lib/event-page"
import { eventStructuredData } from "@/lib/events"
import { jsonLdScript } from "@/lib/structured-data"
import { talksBoundaryRedirect } from "@/lib/talks-boundary"
import { termWeekTag } from "@/lib/week-strip"

type Props = { params: Promise<{ key: string }> }

/** No event page is built with the site: each is rendered on its first
 * request and then served from the edge, revalidated as the (site) layout
 * says (docs/webapp.md "Caching"). An unknown key is proxy.ts's 404 first. */
export function generateStaticParams(): { key: string }[] {
  return []
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const event = await loadEvent(key)
  if (event === undefined) notFound()
  if (event === null) return UNAVAILABLE_METADATA
  // proxy.ts has already sent a talks.cam-derived event to /talks (G1); this
  // is the fallback when its check failed, before anything is rendered. Only
  // ever outward: /talks/events/<key> renders any event and never sends one
  // back, so a stale verdict on either side cannot loop a reader
  // (`talksBoundaryRedirect`).
  const away = talksBoundaryRedirect(event, false)
  if (away) permanentRedirect(away)
  return eventMetadata(event, await loadVenue(event.venueKey), Date.now())
}

/**
 * `/events/<key>` (components/organisms/event-page.tsx), with the schema.org
 * graph — WebPage, Event, BreadcrumbList — for a public, confirmed event
 * (lib/events.ts `eventStructuredData`). The render is anonymous and cached,
 * so a Cambridge-only event gets a page that says it is not available, with
 * the sign-in, rather than a 404 that would hide whether it exists only from
 * the signed-in; a reader who may see it gets the event in its place once
 * hydrated (`RestrictedEvent`). A key with no
 * event anyone may see is a real 404 before this runs (proxy.ts,
 * `events.locate`), and a talks.cam-derived event a 308 to
 * `/talks/events/<key>` (owner decision G1); `notFound()`, `Unavailable` and
 * the redirect here cover the rest (taken down since, a failed check).
 *
 * No loading.tsx (SEO audit "content-in-hidden-suspense"): the page waits
 * for its data, so the H1, the text and the JSON-LD are in the first chunk
 * of HTML rather than in a hidden `<div>` after the footer.
 */
export default async function EventRoute({ params }: Props) {
  const { key } = await params
  const event = await loadEvent(key)
  if (event === undefined) notFound()
  if (event === null) {
    return (
      <RestrictedEvent eventKey={key} underTalks={false}>
        <EventUnavailable path={`/events/${key}`} />
      </RestrictedEvent>
    )
  }
  const away = talksBoundaryRedirect(event, false)
  if (away) permanentRedirect(away)

  const [terms, venue] = await Promise.all([loadTerms(), loadVenue(event.venueKey)])
  const structured = eventStructuredData(event, venue)

  return (
    <>
      {structured && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; `<` is escaped (jsonLdScript)
          dangerouslySetInnerHTML={{ __html: jsonLdScript(structured) }}
        />
      )}
      <EventPage
        event={event}
        venueName={venueNameOf(event, venue)}
        termWeek={termWeekTag(londonIsoDate(event.startsAt), terms)}
        now={Date.now()}
      />
    </>
  )
}
