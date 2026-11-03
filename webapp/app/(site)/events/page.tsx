import { preloadedQueryResult } from "convex/nextjs"
import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { EventsCalendar } from "@/components/organisms/events-calendar"
import { api } from "@/convex/_generated/api"
import { londonIsoDate } from "@/lib/calendar"
import { currentTermEnd } from "@/lib/date-presets"
import { isThinListing } from "@/lib/directory-indexing"
import { EVENTS_TITLE, eventsListStructuredData, orgEventsTitle } from "@/lib/events"
import { pageMetadata } from "@/lib/page-metadata"
import { publicPreload, publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import {
  type EventListArgs,
  type EventsState,
  eventListArgs,
  eventRestrictedArgs,
  eventsIndexing,
  eventsWindow,
  parseEventsParams,
  type SearchParams,
} from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

const DESCRIPTION =
  "Socials, shows, matches and formals from Cambridge societies and clubs, and the University’s public events, day by day."

/** The `?org=` society, shared by the metadata and the page: its name heads
 * the page and its title, and whether its profile is thin says whether its
 * calendar may be indexed. Null when there is none or it cannot be read. */
const loadOrg = cache(async (slug: string | undefined) => {
  if (!slug) return null
  const page = await publicQuery(api.orgs.getBySlug, { slug }).catch((error) => {
    unstable_rethrow(error)
    return null
  })
  return page
    ? {
        key: page.org.key,
        slug: page.org.slug,
        name: page.org.name,
        // The profile's own G3 test (app/(site)/societies/[slug]/page.tsx);
        // read anonymously, so `page.events` holds public events only.
        thin: isThinListing(page.org, page.hasPublicEvents ?? page.events.length > 0),
      }
    : null
})

/** The view's `events.list` read, shared by the metadata and the page:
 * React's cache compares arguments by identity, so it is keyed by their JSON
 * (as lib/public-data.ts caches them). */
const loadEvents = cache((argsJson: string) =>
  publicPreload(api.events.list, JSON.parse(argsJson) as EventListArgs),
)

/** Today (London), the term dates and the `events.list` arguments for a
 * view: the metadata and the page build them alike, so they share a read. */
async function viewArgs(state: EventsState) {
  const today = londonIsoDate(Date.now())
  const terms = await loadTerms()
  const window = eventsWindow(state, today, currentTermEnd(today, terms))
  return { today, terms, args: eventListArgs(state, window) }
}

/** What `eventsIndexing` needs to know of a society's calendar. */
function calendarFacts(
  org: { thin: boolean } | null,
  events: readonly unknown[],
): { listed: boolean; hasEvents: boolean } {
  return { listed: org !== null && !org.thin, hasEvents: events.length > 0 }
}

/** The calendar's title and description, for the page it is (the whole
 * calendar or one society's). */
function heading(org: { name: string } | null): {
  title: string
  absolute: boolean
  description: string
} {
  if (!org) return { title: EVENTS_TITLE, absolute: false, description: DESCRIPTION }
  return {
    ...orgEventsTitle(org.name),
    // Neutral: not every society has socials, talks or matches.
    description: `What ${org.name} has on in Cambridge, week by week, each event with where it was listed.`,
  }
}

/**
 * The calendar is two pages for search engines (SEO audit
 * "events-param-urls"): `/events` and one society's `/events?org=<slug>`
 * while it lists an event, each canonical with its own title. Every other combination of the URL's
 * filters is noindex, follow, with the canonical of the page it slices
 * (lib/url-state.ts `eventsIndexing`). Both advertise their `.ics` feed
 * (SEO audit "calendar-feeds-discovery").
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseEventsParams(await searchParams)
  const org = await loadOrg(state.org)
  const listed = org !== null && !org.thin
  // Only a listed society's canonical calendar needs its events read: every
  // other view is noindex whatever it lists, and /events is indexed as is.
  let hasEvents = true
  if (state.org && eventsIndexing(state, { listed }).index) {
    const { args } = await viewArgs(state)
    hasEvents = preloadedQueryResult(await loadEvents(JSON.stringify(args))).length > 0
  }
  const { canonical, index } = eventsIndexing(state, { listed, hasEvents })
  const { title, absolute, description } = heading(org)
  const base = pageMetadata({ title, description, path: canonical })
  const feed = state.org && org ? `/events.ics?org=${org.slug}` : "/events.ics"
  return {
    ...base,
    ...(absolute ? { title: { absolute: title } } : {}),
    alternates: {
      ...base.alternates,
      types: { "text/calendar": [{ url: feed, title: org ? `${org.name} events` : "Events" }] },
    },
    ...(index ? {} : { robots: { index: false, follow: true } }),
  }
}

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
 * (the audit's 403 events and 1 MB of HTML), four for one society's — the
 * count of Cambridge-only events they may not see, and the colleges for the
 * filter. All anonymous and cached (lib/public-data.ts): a signed-in
 * @cam.ac.uk reader's Cambridge-only events are added by the calendar's live
 * query once the Convex client has the session, and talks.cam-derived ones
 * never are here (owner decision G1: the calendar adds them in the browser).
 *
 * No loading.tsx (SEO audit "content-in-hidden-suspense"): the page waits
 * for its data, so the H1 and the events are in the HTML's first chunk, not
 * in a hidden `<div>` after the footer.
 */
export default async function EventsPage({ searchParams }: Props) {
  const state = parseEventsParams(await searchParams)
  const { today, terms, args } = await viewArgs(state)

  const [preloadedEvents, preloadedColleges, preloadedRestricted, org] = await Promise.all([
    loadEvents(JSON.stringify(args)),
    publicPreload(api.orgs.colleges, {}),
    // A hint, not the page: if the count cannot be had, the calendar still renders.
    publicPreload(api.events.restrictedCount, eventRestrictedArgs(args)).catch((error) => {
      unstable_rethrow(error)
      return null
    }),
    loadOrg(state.org),
  ])

  return (
    <>
      <ListJsonLd
        state={state}
        org={org}
        facts={calendarFacts(org, preloadedQueryResult(preloadedEvents))}
        events={preloadedQueryResult(preloadedEvents)}
      />
      <EventsCalendar
        today={today}
        terms={terms}
        org={org}
        preloadedEvents={preloadedEvents}
        preloadedColleges={preloadedColleges}
        preloadedRestricted={preloadedRestricted}
      />
    </>
  )
}

/** The CollectionPage / ItemList of the events on screen, for the two
 * indexable pages only (lib/events.ts `eventsListStructuredData`). */
function ListJsonLd({
  state,
  org,
  facts,
  events,
}: {
  state: EventsState
  org: { name: string } | null
  facts: { listed: boolean; hasEvents: boolean }
  events: Parameters<typeof eventsListStructuredData>[0]["events"]
}) {
  const { canonical, index } = eventsIndexing(state, facts)
  if (!index) return null
  const data = eventsListStructuredData({ path: canonical, name: heading(org).title, events })
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; `<` is escaped (jsonLdScript)
      dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }}
    />
  )
}
