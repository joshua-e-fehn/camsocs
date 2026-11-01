import { fetchQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { EventsCalendar } from "@/components/organisms/events-calendar"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { londonIsoDate } from "@/lib/calendar"
import { currentTermEnd } from "@/lib/date-presets"
import { pageMetadata } from "@/lib/page-metadata"
import { preloadEvents, preloadPublicColleges, preloadRestrictedCount } from "@/lib/public-data"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import {
  eventListArgs,
  eventRestrictedArgs,
  eventsWindow,
  parseEventsParams,
  type SearchParams,
} from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

export const metadata: Metadata = pageMetadata({
  title: "Events",
  description:
    "Socials, shows, matches and formals from Cambridge societies and clubs, day by day. Each event shows where it was listed.",
  path: "/events",
})

async function loadTerms(): Promise<TermDatesRow[]> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

/**
 * The calendar. Preloads, for the view and filters in the URL: the events the
 * viewer may see in the window it loads — one week for the list, not four
 * (the audit's 403 events and 1 MB of HTML) — the count of Cambridge-only
 * events they may not see, and the colleges for the filter. The session
 * token decides whether Cambridge-only events are among the events.
 */
export default async function EventsPage({ searchParams }: Props) {
  const state = parseEventsParams(await searchParams)
  const today = londonIsoDate(Date.now())
  const [token, terms] = await Promise.all([getToken(), loadTerms()])
  const window = eventsWindow(state, today, currentTermEnd(today, terms))
  const args = eventListArgs(state, window)

  const [preloadedEvents, preloadedColleges, preloadedRestricted, orgPage] = await Promise.all([
    preloadEvents(args, token),
    preloadPublicColleges(),
    // A hint, not the page: if the count cannot be had, the calendar still renders.
    preloadRestrictedCount(eventRestrictedArgs(args), token).catch(() => null),
    state.org ? fetchQuery(api.orgs.getBySlug, { slug: state.org }).catch(() => null) : null,
  ])
  const org = orgPage
    ? { key: orgPage.org.key, slug: orgPage.org.slug, name: orgPage.org.name }
    : null

  return (
    <EventsCalendar
      today={today}
      terms={terms}
      org={org}
      preloadedEvents={preloadedEvents}
      preloadedColleges={preloadedColleges}
      preloadedRestricted={preloadedRestricted}
    />
  )
}
