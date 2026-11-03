import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  HistoryIcon,
  LockIcon,
  PencilLineIcon,
} from "lucide-react"
import Link from "next/link"
import { EventActionBar, EventDetails } from "@/components/molecules/event-details"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { TrackView } from "@/components/molecules/track-view"
import { analyticsAttrs } from "@/lib/analytics-events"
import { linkProps } from "@/lib/crawl-traps"
import { eventHasEnded, eventTrail } from "@/lib/events"
import type { EventPublic } from "@/lib/public-api"
import { camSignInHref, SITE_URL } from "@/lib/site"
import { eventPath } from "@/lib/talks-boundary"
import { EMPTY_EVENTS, eventsHref } from "@/lib/url-state"

/**
 * An event's own, shareable page (talks-redesign-spec §6 "/events"): what the
 * calendar's sheet shows, as an article with a canonical URL; on a phone a
 * sticky bar carries Add to calendar, the source and Share. Rendered at
 * `/events/<key>`, or — for a talks.cam-derived event (owner decision G1,
 * lib/talks-boundary.ts) — at `/talks/events/<key>` with the talks trail.
 * The JSON-LD is the route's (only `/events/<key>` has any).
 *
 * Once the event is over the page says so and points at what the society
 * has coming up (owner decision G4).
 */
export function EventPage({
  event,
  venueName,
  termWeek,
  now,
}: {
  event: EventPublic
  venueName?: string
  termWeek?: string
  /** The request's time, for "this event has ended". */
  now: number
}) {
  const path = eventPath(event)
  const pageUrl = `${SITE_URL}${path}`
  const underTalks = path.startsWith("/talks/")
  // The trail the JSON-LD BreadcrumbList repeats (lib/events.ts `eventTrail`).
  const [calendar] = eventTrail()
  const hosts = event.organisers.filter((o) => o.role !== "sponsor")
  const lead = hosts[0]
  const ended = eventHasEnded(event, now)
  // An ended University listing (ENG-24) points on to the University's view.
  const upcomingHref = event.fromUniversity
    ? eventsHref({ ...EMPTY_EVENTS, university: "only" })
    : lead
      ? eventsHref({ ...EMPTY_EVENTS, org: lead.slug })
      : "/events"
  const correctHref = `/request?${new URLSearchParams({
    kind: "correct",
    ...(lead ? { org: lead.slug } : {}),
    event: event.key,
  }).toString()}`

  return (
    <>
      <div className="border-b bg-card/40">
        <nav
          aria-label="Breadcrumb"
          className="mx-auto flex w-full max-w-7xl items-center gap-1.5 px-4 py-3 text-sm text-muted-foreground sm:px-6"
        >
          <Link
            {...linkProps(underTalks ? "/talks" : calendar.path)}
            className="inline-flex min-h-11 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
          >
            <ArrowLeftIcon aria-hidden className="size-3.5 sm:hidden" />
            {underTalks ? "Talks" : calendar.name}
          </Link>
        </nav>
      </div>

      <div className="mx-auto grid w-full max-w-7xl gap-x-16 gap-y-10 px-4 pt-8 pb-32 sm:px-6 sm:pt-12 sm:pb-20 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <article className="flex max-w-3xl flex-col gap-7">
          <TrackView
            event="event_viewed"
            props={{
              eventKey: event.key,
              orgKeys: hosts.map((host) => host.key),
              hosting: event.hosting,
            }}
          />
          {ended && (
            <p className="flex items-start gap-2.5 rounded-xl border bg-card px-4 py-3 text-sm">
              <HistoryIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">This event has ended.</span>{" "}
                <Link
                  {...linkProps(upcomingHref)}
                  className="underline underline-offset-4 hover:text-events focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {event.fromUniversity
                    ? "What else the University has on"
                    : lead
                      ? `What ${lead.name} has coming up`
                      : "What’s on this week"}
                </Link>
              </span>
            </p>
          )}
          <EventDetails
            event={event}
            venueName={venueName}
            pageUrl={pageUrl}
            termWeek={termWeek}
            showTitle
            actions="from-sm"
          />
          <p className="text-sm text-muted-foreground">
            <PencilLineIcon aria-hidden className="mr-1.5 inline size-3.5 align-[-2px]" />
            Something wrong here?{" "}
            <Link
              href={correctHref}
              rel="nofollow"
              className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:min-h-6"
            >
              Report or correct this event
            </Link>
          </p>
        </article>

        {event.fromUniversity ? (
          <FromUniversity listingUrl={event.sourceUrl} />
        ) : lead ? (
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
                  {...linkProps(upcomingHref)}
                  className="inline-flex h-11 items-center justify-between gap-2 rounded-full border border-events px-4 text-sm font-medium text-events transition-colors hover:bg-events-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
                >
                  All its events
                  <ChevronRightIcon aria-hidden className="size-4" />
                </Link>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
      <EventActionBar event={event} pageUrl={pageUrl} venueName={venueName} />
    </>
  )
}

/** The side panel of one of the University's own listings (ENG-24), in place
 * of the society's: its page in the University's programme, and the
 * calendar's University view. */
function FromUniversity({ listingUrl }: { listingUrl?: string }) {
  return (
    <aside aria-label="From the University" className="lg:pt-16">
      <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+1.5rem)]">
        <p className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          <span aria-hidden className="size-2 rounded-full bg-events" />
          From the University
        </p>
        <p className="font-serif text-2xl leading-tight">University of Cambridge</p>
        <p className="text-sm text-muted-foreground">
          Listed in the University’s public events programme; its page there has the full details
          and any booking.
        </p>
        <div className="flex flex-col gap-2">
          {listingUrl && (
            <a
              href={listingUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              {...analyticsAttrs("outbound_link_clicked", { kind: "source" })}
              className="inline-flex h-11 items-center justify-between gap-2 rounded-full border px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
            >
              The University’s listing
              <ArrowUpRightIcon aria-hidden className="size-4" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          <Link
            {...linkProps(eventsHref({ ...EMPTY_EVENTS, university: "only", weeks: 4 }))}
            className="inline-flex h-11 items-center justify-between gap-2 rounded-full border border-events px-4 text-sm font-medium text-events transition-colors hover:bg-events-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
          >
            All University events
            <ChevronRightIcon aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </aside>
  )
}

/** The page of an event this viewer may not see (taken down since the
 * proxy's check, or Cambridge-only): says so, with the sign-in. */
export function EventUnavailable({ path }: { path: string }) {
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
            href={camSignInHref(path)}
            className="font-medium text-foreground underline underline-offset-4"
          >
            sign in with your @cam.ac.uk email
          </Link>{" "}
          to see those.
        </span>
      </p>
      <Link
        {...linkProps("/events")}
        className="inline-flex h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium transition-colors hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        What’s on this week
      </Link>
    </div>
  )
}
