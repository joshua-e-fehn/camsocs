import {
  ArrowUpRightIcon,
  InfoIcon,
  LandmarkIcon,
  LockIcon,
  MapPinIcon,
  TicketIcon,
} from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { AddToCalendar, type CalendarLinks } from "@/components/molecules/add-to-calendar"
import { ClampedText } from "@/components/molecules/clamped-text"
import { EventFlags, EventTitle, EventTypeChip } from "@/components/molecules/event-item"
import { ExternalLink } from "@/components/molecules/external-link"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { RichText } from "@/components/molecules/rich-text"
import { ShareAction } from "@/components/molecules/share-action"
import { SourcedChip, type SourcedFact } from "@/components/molecules/sourced-chip"
import { TermDateBlock } from "@/components/molecules/term-date-block"
import { analyticsAttrs, analyticsContext } from "@/lib/analytics-events"
import { formatEventTime, formatInstantDate, londonIsoDate } from "@/lib/calendar"
import {
  eventGoogleCalendarUrl,
  eventOutlookCalendarUrl,
  spokenTitle,
  UNIVERSITY_NAME,
} from "@/lib/events"
import { formatEventPrice } from "@/lib/format"
import type { EventPublic } from "@/lib/public-api"
import { displayHost, hasValue, sourceLine } from "@/lib/source-line"
import { eventIcsPath } from "@/lib/talks-boundary"
import { cn } from "@/lib/utils"
import { EVENT_SOURCE_LABELS, EVENT_TYPE_LABELS } from "@/lib/vocab"

const ROLE = { organiser: "Organiser", co_host: "Co-host", sponsor: "Sponsor" } as const
const LONG_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "Tuesday 3 November". */
function longDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  return `${LONG_WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()} ${LONG_MONTHS[date.getUTCMonth()]}`
}

/** The calendar links for one event (its `.ics` is beside its page:
 * `/events/<key>/ics`, or under /talks for a talks.cam-derived one, G1).
 * A venue known only by its key (`venueName`) is still the location. */
export function eventCalendarLinks(
  event: EventPublic,
  pageUrl: string,
  venueName?: string,
): CalendarLinks {
  const located = { ...event, venueText: event.venueText ?? venueName }
  return {
    google: eventGoogleCalendarUrl(located, pageUrl),
    ics: eventIcsPath(event),
    outlook: eventOutlookCalendarUrl(located, pageUrl),
    office365: eventOutlookCalendarUrl(located, pageUrl, "outlook.office.com"),
  }
}

/** Where the event's own page is: someone else's event links its organiser's
 * page (D6); otherwise the listing it was read from. */
function ownPage(event: EventPublic): { url: string; host: string } | undefined {
  const url =
    event.hosting === "takes_part" ? (event.externalUrl ?? event.sourceUrl) : event.sourceUrl
  const host = url ? displayHost(url) : null
  return url && host ? { url, host } : undefined
}

/** The first organiser that is not a sponsor, for outbound-link events. */
function leadOrgKey(event: EventPublic): string | undefined {
  return event.organisers.find((organiser) => organiser.role !== "sponsor")?.key
}

/** The type and who runs it over the title, in the events brick:
 * "Performance · CU Jazz Society" ("Talk · University of Cambridge" for one
 * of the University's own listings, ENG-24). */
export function EventEyebrow({ event, className }: { event: EventPublic; className?: string }) {
  const lead = event.fromUniversity
    ? UNIVERSITY_NAME
    : event.organisers.find((o) => o.role !== "sponsor")?.name
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-events uppercase",
        className,
      )}
    >
      <span>{EVENT_TYPE_LABELS[event.eventType]}</span>
      {lead && (
        <>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <span className="normal-case tracking-[0.06em]">
            {event.hosting === "takes_part" ? `${lead} takes part` : lead}
          </span>
        </>
      )}
    </p>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MapPinIcon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  )
}

/** A value nobody has published: one muted line ("Venue not published yet"). */
function Unknown({ what, meta }: { what: string; meta: EventPublic["meta"][string] | undefined }) {
  const model = sourceLine(meta)
  const reason = model.kind === "missing" ? model.label.toLowerCase() : "not published yet"
  return (
    <span
      className="text-muted-foreground"
      title={model.kind === "missing" ? model.detail : undefined}
    >
      {what} {reason}
    </span>
  )
}

/** One of the University's own listings (ENG-24): the University as plain
 * text — it has no page here — and where the listing comes from. */
function UniversityOrganiser({ event }: { event: EventPublic }) {
  return (
    <section aria-labelledby={`people-${event.key}`} className="flex flex-col gap-2.5">
      <h2
        id={`people-${event.key}`}
        className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
      >
        Listed by
      </h2>
      <p className="flex min-h-11 items-center gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted/60"
        >
          <LandmarkIcon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{UNIVERSITY_NAME}</span>
          <span className="text-xs text-muted-foreground">From its public events programme</span>
        </span>
      </p>
    </section>
  )
}

/** Who runs it, with a monogram per society, or — for someone else's event
 * (D6) — who takes part, never "organised by". */
function People({ event }: { event: EventPublic }) {
  const external = event.hosting === "takes_part"
  if (event.fromUniversity) return <UniversityOrganiser event={event} />
  if (event.organisers.length === 0) return null
  return (
    <section aria-labelledby={`people-${event.key}`} className="flex flex-col gap-2.5">
      <h2
        id={`people-${event.key}`}
        className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
      >
        {external ? "Taking part" : event.organisers.length === 1 ? "Organiser" : "Organisers"}
      </h2>
      <ul className="flex flex-col gap-2">
        {event.organisers.map((organiser) => (
          <li key={`${organiser.key}-${organiser.role}`}>
            <Link
              href={`/societies/${organiser.slug}`}
              className="group flex min-h-11 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <OrgMonogram name={organiser.name} size={36} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium underline-offset-4 group-hover:underline">
                  {organiser.name}
                </span>
                {(external || organiser.role !== "organiser") && (
                  <span className="text-xs text-muted-foreground">
                    {external ? "Takes part" : ROLE[organiser.role]}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {external && (
        <p className="flex gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <ArrowUpRightIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          Someone else’s event, on the society’s calendar because it takes part — not one it
          organises.
        </p>
      )}
    </section>
  )
}

/**
 * Everything public about one event, for the /events details sheet and the
 * shareable /events/[key] page (talks-redesign-spec §6): the type eyebrow and
 * serif title (`showTitle`; the sheet has its own), a date tile with the
 * term week, where, price and booking, who runs it — or who takes part
 * (D6) — speakers, the description (clamped), the actions (Add to calendar
 * ▾, Book, the event's own page, Share) and the listing's provenance as one
 * compact "Sourced" chip. A mailing-list event names no source URL: the
 * inbox is private.
 */
export function EventDetails({
  event,
  venueName,
  pageUrl,
  termWeek,
  showTitle = false,
  actions = "inline",
  className,
}: {
  event: EventPublic
  venueName?: string
  /** Absolute URL of the event's page here, for calendar entries. */
  pageUrl: string
  /** "Mich · Wk 5", when the day is in term. */
  termWeek?: string
  /** Render the eyebrow and an h1 title (the page); the sheet has its own. */
  showTitle?: boolean
  /** The action row: always, from `sm` up (the page's phone layout has
   * `EventActionBar`), or not at all. */
  actions?: "inline" | "from-sm" | "none"
  className?: string
}) {
  const price = formatEventPrice(event.price)
  const where = event.venueText ?? venueName
  const day = londonIsoDate(event.startsAt)
  const time = formatEventTime(event)
  const page = ownPage(event)
  const sourceHost = event.sourceUrl ? displayHost(event.sourceUrl) : null
  const mapsUrl = where
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${where}, Cambridge`)}`
    : undefined
  const path = new URL(pageUrl).pathname
  const venueMeta = hasValue(event.meta.venueText) ? event.meta.venueText : event.meta.venueKey
  const facts: SourcedFact[] = [
    { label: "Title", meta: event.meta.title },
    { label: "Date and time", meta: event.meta.startsAt },
    { label: "Venue", meta: venueMeta },
    { label: "Who runs it", meta: event.meta.hosting ?? event.meta.organiserKeys },
    { label: "Price", meta: event.meta.price },
    { label: "Booking link", meta: event.meta.bookingUrl },
    { label: "Speakers", meta: event.meta.speakers },
    { label: "Description", meta: event.meta.description },
    { label: "The event’s own page", meta: event.meta.externalUrl },
  ]

  return (
    <div
      className={cn("flex flex-col gap-7", className)}
      {...analyticsContext({ orgKey: leadOrgKey(event) })}
    >
      {showTitle && (
        <header className="flex flex-col gap-3">
          <EventEyebrow event={event} />
          <h1
            className={cn(
              "font-serif text-[clamp(1.85rem,4.6vw,3rem)] leading-[1.08] font-normal tracking-[-0.02em] text-balance",
              event.cancelled && "text-muted-foreground line-through decoration-2",
            )}
          >
            <EventTitle title={event.title} />
          </h1>
        </header>
      )}

      {event.imageUrl && (
        <Image
          src={event.imageUrl}
          // A poster carries the event's words; name it (SEO audit "image-alt-text").
          alt={`Poster for ${spokenTitle(event.title)}`}
          width={640}
          height={360}
          sizes="(min-width: 640px) 32rem, 100vw"
          // In a sheet that just opened: load now, not when scrolled to.
          loading="eager"
          // On the event's own page it sits under the title, above the fold:
          // the likely LCP element, fetched first (SEO audit 2026-11-02,
          // mobile-lcp-js-weight). Not in a sheet, behind the calendar.
          fetchPriority={showTitle ? "high" : undefined}
          className="aspect-video w-full rounded-xl border bg-muted object-cover"
        />
      )}

      {event.cancelled && (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive">
          <InfoIcon aria-hidden className="size-4" />
          The organisers have cancelled this event.
        </p>
      )}

      <div className="flex items-start gap-4">
        <TermDateBlock
          startsAt={event.startsAt}
          termWeekLabel={termWeek}
          accent="events"
          size="lg"
          label={`${longDay(day)}, ${time}`}
        />
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          <p aria-hidden className="font-serif text-xl leading-tight">
            {longDay(day)}
          </p>
          <p className="font-mono text-sm tabular-nums">
            {time} <span className="text-muted-foreground">UK time</span>
          </p>
          {termWeek && (
            <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
              {termWeek}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <EventTypeChip type={event.eventType} />
        <EventFlags event={event} />
      </div>

      <div className="flex flex-col gap-4 text-[0.9375rem]">
        <Row icon={MapPinIcon} label="Where">
          {where ? (
            <>
              <span className="font-medium">{where}</span>
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"
                >
                  Open in Maps
                  <ArrowUpRightIcon aria-hidden className="size-3.5" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </>
          ) : (
            <Unknown what="Venue" meta={event.meta.venueText} />
          )}
        </Row>
        <Row icon={TicketIcon} label="Price and booking">
          {price ? (
            <span className="font-medium">{price}</span>
          ) : (
            <Unknown what="Price" meta={event.meta.price} />
          )}
          {event.signupRequired && <span className="text-sm">Sign-up required</span>}
        </Row>
      </div>

      <People event={event} />

      {event.speakers.length > 0 && (
        <section aria-labelledby={`speakers-${event.key}`} className="flex flex-col gap-2.5">
          <h2
            id={`speakers-${event.key}`}
            className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
          >
            {event.speakers.length === 1 ? "Speaker" : "Speakers"}
          </h2>
          <ul className="flex flex-col gap-1 text-[0.9375rem]">
            {event.speakers.map((speaker) => (
              <li key={`${speaker.name}-${speaker.affiliation ?? ""}`}>
                <span className="font-medium">{speaker.name}</span>
                {speaker.affiliation && (
                  <span className="text-muted-foreground"> · {speaker.affiliation}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {event.description && (
        <section aria-labelledby={`about-${event.key}`} className="flex flex-col gap-2.5">
          <h2
            id={`about-${event.key}`}
            className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
          >
            About
          </h2>
          <ClampedText lines={8}>
            <RichText text={event.description} className="text-[0.9375rem] leading-7" />
          </ClampedText>
        </section>
      )}

      {actions !== "none" && (
        <div
          className={cn(
            "flex-wrap items-center gap-2",
            actions === "from-sm" ? "hidden sm:flex" : "flex",
          )}
        >
          <AddToCalendar
            links={eventCalendarLinks(event, pageUrl, venueName)}
            accent="events"
            noun="event"
            item={{ feed: "event", key: event.key }}
          />
          {event.bookingUrl && (
            <a
              href={event.bookingUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              {...analyticsAttrs("outbound_link_clicked", { kind: "other" })}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-events px-4 text-sm font-medium text-events transition-colors duration-150 hover:bg-events-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
            >
              <TicketIcon aria-hidden className="size-4" />
              Book or sign up
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {page && (
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              {...analyticsAttrs("outbound_link_clicked", { kind: "source" })}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border bg-card px-4 text-sm font-medium transition-colors duration-150 hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
            >
              {event.hosting === "takes_part" ? "The event’s own page" : "Read at source"}
              <ArrowUpRightIcon aria-hidden className="size-4" />
              <span className="sr-only"> (opens {page.host} in a new tab)</span>
            </a>
          )}
          <div className="hidden sm:block">
            <ShareAction title={spokenTitle(event.title)} path={path} />
          </div>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed pt-4 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-center gap-x-1">
          <span>Listed from</span>
          <span className="text-foreground/80">{EVENT_SOURCE_LABELS[event.source]}</span>
          {event.sourceUrl && sourceHost ? (
            <>
              <span aria-hidden>·</span>
              <ExternalLink
                href={event.sourceUrl}
                className="font-mono text-foreground/80"
                outbound={{ kind: "source" }}
              >
                {sourceHost}
              </ExternalLink>
            </>
          ) : event.source === "mailing_list" ? (
            <span className="inline-flex items-center gap-1">
              <LockIcon aria-hidden className="size-3" /> private source
            </span>
          ) : null}
          <span aria-hidden>·</span>
          <span>
            seen <span className="font-mono">{formatInstantDate(event.lastSeenAt)}</span>
          </span>
        </p>
        <SourcedChip section="This listing" facts={facts} />
      </footer>
    </div>
  )
}

/** The page's phone action bar: Add to calendar, the source, Share — fixed
 * to the bottom edge, above the home indicator. */
export function EventActionBar({
  event,
  pageUrl,
  venueName,
}: {
  event: EventPublic
  pageUrl: string
  venueName?: string
}) {
  const page = ownPage(event)
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-background/85 sm:hidden">
      <div className="flex items-center gap-3">
        <AddToCalendar
          links={eventCalendarLinks(event, pageUrl, venueName)}
          accent="events"
          noun="event"
          item={{ feed: "event", key: event.key }}
          className="flex-1"
        />
        {page && (
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            {...analyticsAttrs("outbound_link_clicked", {
              kind: "source",
              orgKey: leadOrgKey(event),
            })}
            className="flex flex-col items-center gap-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex size-11 items-center justify-center rounded-full border bg-card">
              <ArrowUpRightIcon aria-hidden className="size-5" />
            </span>
            Source
            <span className="sr-only"> (opens {page.host} in a new tab)</span>
          </a>
        )}
        <ShareAction title={spokenTitle(event.title)} path={new URL(pageUrl).pathname} />
      </div>
    </div>
  )
}
