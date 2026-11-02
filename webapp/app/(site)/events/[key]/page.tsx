import { fetchQuery } from "convex/nextjs"
import { ArrowLeftIcon, ChevronRightIcon, LockIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound, unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { EventActionBar, EventDetails } from "@/components/molecules/event-details"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { TrackView } from "@/components/molecules/track-view"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { formatDayShort, londonIsoDate } from "@/lib/calendar"
import { eventJsonLd, eventMetaDescription, spokenTitle } from "@/lib/events"
import { pageMetadata } from "@/lib/page-metadata"
import { camSignInHref, SITE_NAME, SITE_URL } from "@/lib/site"
import { jsonLdScript } from "@/lib/talks"
import { fetchTermDates } from "@/lib/term-dates"
import type { TermDatesRow } from "@/lib/term-week"
import { EMPTY_EVENTS, eventsHref, isEventKey } from "@/lib/url-state"
import { termWeekTag } from "@/lib/week-strip"

type Props = { params: Promise<{ key: string }> }

/** One read per request, shared by the metadata and the page. The viewer's
 * token decides whether a Cambridge-only event is theirs to see. */
const loadEvent = cache(async (key: string) => {
  if (!isEventKey(key)) return undefined
  const token = await getToken()
  return await fetchQuery(api.events.get, { key }, { token })
})

async function loadTerms(): Promise<TermDatesRow[]> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

async function loadVenueName(venueKey: string | undefined): Promise<string | undefined> {
  if (!venueKey) return undefined
  try {
    const venues = await fetchQuery(api.venues.list, {})
    return venues.find((venue) => venue.key === venueKey)?.name
  } catch (error) {
    unstable_rethrow(error)
    return undefined
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const event = await loadEvent(key)
  if (event === undefined) notFound()
  if (event === null) {
    return { title: "Event not available", robots: { index: false, follow: false } }
  }
  const title = spokenTitle(event.title)
  return {
    ...pageMetadata({
      title: event.cancelled ? `Cancelled: ${title}` : title,
      description: eventMetaDescription(event),
      path: `/events/${event.key}`,
    }),
    // A Cambridge-only event's page is for signed-in readers, not search.
    ...(event.visibility === "cam_only" ? { robots: { index: false, follow: false } } : {}),
  }
}

/**
 * An event's own, shareable page (talks-redesign-spec §6 "/events"): what the
 * calendar's sheet shows, as an article with schema.org `Event` JSON-LD and a
 * canonical URL; on a phone a sticky bar carries Add to calendar, the source
 * and Share. A Cambridge-only event the viewer may not see gets a page that
 * says so, with the sign-in, rather than a 404 that would hide whether it
 * exists only from the signed-in. A key with no event anyone may see is a
 * real 404 before this runs (proxy.ts, `events.exists`); `notFound()` and
 * `Unavailable` here also cover an event taken down since that check.
 */
export default async function EventPage({ params }: Props) {
  const { key } = await params
  const event = await loadEvent(key)
  if (event === undefined) notFound()
  if (event === null) return <Unavailable eventKey={key} />

  const [terms, venueName] = await Promise.all([
    loadTerms(),
    event.venueText ? undefined : loadVenueName(event.venueKey),
  ])
  const pageUrl = `${SITE_URL}/events/${event.key}`
  const day = londonIsoDate(event.startsAt)
  const termWeek = termWeekTag(day, terms)
  const hosts = event.organisers.filter((o) => o.role !== "sponsor")
  const lead = hosts[0]

  return (
    <>
      {event.visibility === "public" && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; `<` is escaped (jsonLdScript)
          dangerouslySetInnerHTML={{
            __html: jsonLdScript({
              ...eventJsonLd(event, pageUrl, venueName),
              isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
            }),
          }}
        />
      )}
      <div className="border-b bg-card/40">
        <nav
          aria-label="Breadcrumb"
          className="mx-auto flex w-full max-w-7xl items-center gap-1.5 px-4 py-3 text-sm text-muted-foreground sm:px-6"
        >
          <Link
            href="/events"
            className="inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
          >
            <ArrowLeftIcon aria-hidden className="size-3.5 sm:hidden" />
            Events
          </Link>
          <ChevronRightIcon aria-hidden className="hidden size-3.5 sm:block" />
          <Link
            href={eventsHref({ ...EMPTY_EVENTS, date: day })}
            className="hidden min-h-8 items-center underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:inline-flex"
          >
            {formatDayShort(day)}
          </Link>
        </nav>
      </div>

      <div className="mx-auto grid w-full max-w-7xl gap-x-16 gap-y-10 px-4 pt-8 pb-32 sm:px-6 sm:pt-12 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="max-w-3xl">
          <TrackView
            event="event_viewed"
            props={{
              eventKey: event.key,
              orgKeys: hosts.map((host) => host.key),
              hosting: event.hosting,
            }}
          />
          <EventDetails
            event={event}
            venueName={venueName}
            pageUrl={pageUrl}
            termWeek={termWeek}
            showTitle
            actions="from-sm"
          />
        </article>

        {lead && (
          <aside aria-label={`More from ${lead.name}`} className="lg:pt-16">
            <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+1.5rem)]">
              <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
                <span aria-hidden className="size-2 rounded-full bg-events" />
                {event.hosting === "takes_part" ? "Taking part" : "The society"}
              </p>
              <div className="flex items-center gap-3">
                <OrgMonogram name={lead.name} size={44} />
                <p className="font-serif text-2xl leading-tight">{lead.name}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                {event.hosting === "takes_part"
                  ? "Someone else’s event, on this society’s calendar because it takes part."
                  : "What it does, how to join, and everything else it has on."}
              </p>
              <div className="flex flex-col gap-2">
                <Link
                  href={`/societies/${lead.slug}`}
                  className="inline-flex h-11 items-center justify-between gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
                >
                  The society’s page
                  <ChevronRightIcon aria-hidden className="size-4" />
                </Link>
                <Link
                  href={eventsHref({ ...EMPTY_EVENTS, org: lead.slug, weeks: 4 })}
                  className="inline-flex h-11 items-center justify-between gap-2 rounded-full border border-events px-4 text-sm font-medium text-events transition-colors hover:bg-events-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
                >
                  All its events
                  <ChevronRightIcon aria-hidden className="size-4" />
                </Link>
              </div>
            </div>
          </aside>
        )}
      </div>
      <EventActionBar event={event} pageUrl={pageUrl} venueName={venueName} />
    </>
  )
}

function Unavailable({ eventKey }: { eventKey: string }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-4 px-4 py-16 sm:px-6 sm:py-24">
      <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-events uppercase">
        <span aria-hidden className="h-px w-6 bg-events" />
        Events
      </p>
      <h1 className="font-serif text-[clamp(2rem,5vw,3rem)] leading-[1.08] font-normal tracking-[-0.02em]">
        This event is not available
      </h1>
      <p className="flex gap-2.5 text-pretty text-muted-foreground">
        <LockIcon aria-hidden className="mt-1 size-4 shrink-0" />
        <span>
          It may have been taken down, or it is a Cambridge-only event:{" "}
          <Link
            href={camSignInHref(`/events/${eventKey}`)}
            className="font-medium text-foreground underline underline-offset-4"
          >
            sign in with your @cam.ac.uk email
          </Link>{" "}
          to see those.
        </span>
      </p>
      <Link
        href="/events"
        className="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        What’s on this week
      </Link>
    </div>
  )
}
