import { CalendarClockIcon, LockIcon, MapPinIcon, TicketIcon, UsersIcon } from "lucide-react"
import Image from "next/image"
import Link from "next/link"
import { EventFlags } from "@/components/molecules/event-item"
import { ExternalLink } from "@/components/molecules/external-link"
import { RichText } from "@/components/molecules/rich-text"
import { SourceLine } from "@/components/molecules/source-line"
import { Badge } from "@/components/ui/badge"
import { formatEventWhen, formatInstantDate } from "@/lib/calendar"
import { formatEventPrice } from "@/lib/format"
import type { EventPublic } from "@/lib/public-api"
import { displayHost, hasValue, sourceLine } from "@/lib/source-line"
import { EVENT_SOURCE_LABELS, EVENT_TYPE_LABELS } from "@/lib/vocab"

const ROLE = { organiser: "Organiser", co_host: "Co-host", sponsor: "Sponsor" } as const

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
      <div className="flex min-w-0 flex-col gap-1">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  )
}

/** A row whose value nobody has published: one muted line, not an empty
 * value over a provenance line. */
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

/**
 * Everything public about one event: when (London time, with the term week),
 * where, who organises it, price and booking, speakers, description — and
 * where the listing came from. A mailing-list event names no source URL: the
 * inbox is private.
 */
export function EventDetails({ event, venueName }: { event: EventPublic; venueName?: string }) {
  const price = formatEventPrice(event.price)
  const where = event.venueText ?? venueName
  const sourceHost = event.sourceUrl ? displayHost(event.sourceUrl) : null

  return (
    <div className="flex flex-col gap-5">
      {event.imageUrl && (
        <Image
          src={event.imageUrl}
          alt=""
          width={640}
          height={360}
          sizes="(min-width: 640px) 28rem, 100vw"
          // In a sheet that just opened: load now, not when scrolled to.
          loading="eager"
          className="aspect-video w-full rounded-lg border bg-muted object-cover"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="font-normal">
          {EVENT_TYPE_LABELS[event.eventType]}
        </Badge>
        {event.termWeekLabel && (
          <Badge variant="outline" className="font-mono font-normal">
            {event.termWeekLabel}
          </Badge>
        )}
        <EventFlags event={event} />
      </div>

      <div className="flex flex-col gap-4 text-sm">
        <Row icon={CalendarClockIcon} label="When">
          <span className="font-mono">{formatEventWhen(event)}</span>
          <span className="text-xs text-muted-foreground">UK time</span>
          <SourceLine meta={event.meta.startsAt} />
        </Row>
        <Row icon={MapPinIcon} label="Where">
          {where ? (
            <>
              <span>{where}</span>
              <SourceLine
                meta={hasValue(event.meta.venueText) ? event.meta.venueText : event.meta.venueKey}
              />
            </>
          ) : (
            <Unknown what="Venue" meta={event.meta.venueText} />
          )}
        </Row>
        {event.organisers.length > 0 && (
          <Row icon={UsersIcon} label="Organised by">
            <ul className="flex flex-col gap-0.5">
              {event.organisers.map((organiser) => (
                <li key={`${organiser.key}-${organiser.role}`}>
                  <Link
                    href={`/societies/${organiser.slug}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {organiser.name}
                  </Link>
                  {organiser.role !== "organiser" && (
                    <span className="text-muted-foreground"> · {ROLE[organiser.role]}</span>
                  )}
                </li>
              ))}
            </ul>
          </Row>
        )}
        <Row icon={TicketIcon} label="Price and booking">
          {price && <span>{price}</span>}
          {event.signupRequired && <span>Sign-up required</span>}
          {event.bookingUrl && <ExternalLink href={event.bookingUrl}>Book or sign up</ExternalLink>}
          {price ? (
            <SourceLine meta={event.meta.price} />
          ) : (
            <Unknown what="Price" meta={event.meta.price} />
          )}
        </Row>
      </div>

      {event.speakers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Speakers
          </h3>
          <ul className="flex flex-col gap-0.5 text-sm">
            {event.speakers.map((speaker) => (
              <li key={`${speaker.name}-${speaker.affiliation ?? ""}`}>
                {speaker.name}
                {speaker.affiliation && (
                  <span className="text-muted-foreground"> · {speaker.affiliation}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {event.description && (
        <div className="flex flex-col gap-2">
          <RichText text={event.description} />
          <SourceLine meta={event.meta.description} />
        </div>
      )}

      <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          Listed from <span className="text-foreground">{EVENT_SOURCE_LABELS[event.source]}</span>
          {event.sourceUrl && sourceHost ? (
            <>
              {" — "}
              <ExternalLink href={event.sourceUrl} className="text-foreground">
                {sourceHost}
              </ExternalLink>
            </>
          ) : event.source === "mailing_list" ? (
            <span className="inline-flex items-center gap-1">
              {" "}
              <LockIcon aria-hidden className="size-3" /> (private source)
            </span>
          ) : null}
        </p>
        <p className="font-mono">
          last seen {formatInstantDate(event.lastSeenAt)} · {Math.round(event.confidence * 100)}%
          <span className="sr-only"> confidence</span>
        </p>
      </div>
    </div>
  )
}
