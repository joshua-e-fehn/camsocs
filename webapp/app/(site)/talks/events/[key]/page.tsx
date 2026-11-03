import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { EventPage, EventUnavailable } from "@/components/organisms/event-page"
import { RestrictedEvent } from "@/components/organisms/restricted-event"
import { londonIsoDate } from "@/lib/calendar"
import {
  eventMetadata,
  loadEvent,
  loadRepeatsThatDay,
  loadTerms,
  loadVenue,
  UNAVAILABLE_METADATA,
  venueNameOf,
} from "@/lib/event-page"
import { camSignInOpen } from "@/lib/sign-in-options"
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
  // Any event renders here; one not talks.cam-derived has `/events/<key>` as
  // its canonical URL (eventMetadata, by `eventPath`).
  const [venue, atTime] = await Promise.all([loadVenue(event.venueKey), loadRepeatsThatDay(event)])
  return eventMetadata(event, venue, Date.now(), atTime)
}

/**
 * The page of a talks.cam-derived society event (owner decision G1,
 * lib/talks-boundary.ts): a society's talks.cam series, or an event whose
 * listing is on talks.cam. It lives under /talks — where robots.txt keeps AI
 * agents out, as talks.cam itself does — and `/events/<key>` answers it with
 * a 308 here (proxy.ts). The same page as any event's
 * (components/organisms/event-page.tsx) but with no JSON-LD: talks.cam's
 * words never become machine-readable markup here.
 *
 * Any other event is rendered here too, never redirected back: its canonical
 * URL (`eventPath`) and its page's links are `/events/<key>`, and nothing
 * under /talks is outside G1. The proxy reads `events.locate` fresh while
 * this page reads `events.get` through Next's Data Cache; for a cache
 * lifetime after a harvest changes an event's verdict the two disagree, and
 * a redirect each way then looped (review of the SEO audit,
 * talks-boundary-redirect-loop; lib/talks-boundary.ts `talksBoundaryRedirect`).
 */
export default async function TalksEventRoute({ params }: Props) {
  const { key } = await params
  const event = await loadEvent(key)
  if (event === undefined) notFound()
  if (event === null) {
    return (
      <RestrictedEvent eventKey={key} underTalks={true}>
        <EventUnavailable path={`/talks/events/${key}`} camSignIn={await camSignInOpen()} />
      </RestrictedEvent>
    )
  }
  const [terms, venue] = await Promise.all([loadTerms(), loadVenue(event.venueKey)])
  return (
    <EventPage
      event={event}
      venueName={venueNameOf(event, venue)}
      termWeek={termWeekTag(londonIsoDate(event.startsAt), terms)}
      now={Date.now()}
    />
  )
}
