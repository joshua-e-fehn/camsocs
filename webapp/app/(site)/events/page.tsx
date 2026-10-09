import { fetchQuery, preloadQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { EventsCalendar } from "@/components/organisms/events-calendar"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { londonIsoDate, viewWindow } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { eventListArgs, parseEventsParams, type SearchParams } from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

export const metadata: Metadata = pageMetadata({
  title: "Events",
  description:
    "Talks, socials, matches and shows from Cambridge societies and clubs, in one calendar. Each event shows where it was listed.",
  path: "/events",
})

/**
 * The calendar. Preloads, for the view and filters in the URL: the events the
 * viewer may see (the session token decides whether Cambridge-only events are
 * among them), the count of Cambridge-only events they may not, and the
 * colleges for the filter.
 */
export default async function EventsPage({ searchParams }: Props) {
  const state = parseEventsParams(await searchParams)
  const today = londonIsoDate(Date.now())
  const args = eventListArgs(state, viewWindow(state.view, state.date ?? today))
  const token = await getToken()

  const [preloadedEvents, preloadedColleges, preloadedRestricted, orgPage] = await Promise.all([
    preloadQuery(api.events.list, args, { token }),
    preloadQuery(api.orgs.colleges, {}),
    // A hint, not the page: if the count cannot be had, the calendar still renders.
    preloadQuery(api.events.restrictedCount, args, { token }).catch(() => null),
    state.org ? fetchQuery(api.orgs.getBySlug, { slug: state.org }) : null,
  ])
  const org = orgPage
    ? { key: orgPage.org.key, slug: orgPage.org.slug, name: orgPage.org.name }
    : null

  return (
    <>
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-8 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight">
            {org ? `Events: ${org.name}` : "Events"}
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            What Cambridge societies and clubs have published: talks, socials, matches, shows and
            more. Public events are open to everyone; Cambridge-only events need a verified
            @cam.ac.uk sign-in.
          </p>
        </div>
      </header>
      <EventsCalendar
        state={state}
        today={today}
        org={org}
        preloadedEvents={preloadedEvents}
        preloadedColleges={preloadedColleges}
        preloadedRestricted={preloadedRestricted}
      />
    </>
  )
}
