import { ArrowUpRightIcon, BanIcon, LandmarkIcon, LockIcon, MapPinIcon } from "lucide-react"
import Link from "next/link"
import { TONE_CLASSES } from "@/components/molecules/org-monogram"
import { formatEventWhen, londonTime } from "@/lib/calendar"
import { EVENT_TYPE_TONE, eventTimes, splitEmoji, spokenTitle, UNIVERSITY_NAME } from "@/lib/events"
import { takesPart } from "@/lib/format"
import type { EventListItem } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { EVENT_TYPE_LABELS, type EventType } from "@/lib/vocab"

/** A small dot per type family, beside the type's name or as a grid chip's
 * marker (decorative: the name is always there in words). */
export const TONE_DOT: Record<(typeof EVENT_TYPE_TONE)[EventType], string> = {
  sage: "bg-primary",
  teal: "bg-[color-mix(in_oklch,var(--primary)_60%,var(--talks))]",
  indigo: "bg-talks",
  plum: "bg-[color-mix(in_oklch,var(--events)_50%,var(--talks))]",
  brick: "bg-events",
  gilt: "bg-gilt",
  neutral: "bg-muted-foreground",
}

/**
 * A title as it is shown: any emoji stays on screen but is hidden from
 * screen readers, which would otherwise read "🚩 HAM-DEFCON" as "triangular
 * flag on post HAM-DEFCON" (lib/events.ts `splitEmoji`).
 */
export function EventTitle({ title }: { title: string }) {
  const parts = splitEmoji(title)
  if (parts.every((part) => !part.emoji)) return <>{title}</>
  if (parts.every((part) => part.emoji)) return <>{title}</>
  return (
    <>
      {parts.map((part, index) =>
        part.emoji ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a title's parts never reorder
          <span key={index} aria-hidden>
            {part.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a title's parts never reorder
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** Someone else's event the listed societies only take part in (decision
 * D6): an arrow off-site and the words, never colour alone — dashed, like
 * the outline of a thing that is not ours. */
export function TakingPartBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-foreground/35 px-1.5 py-0.5 text-xs text-foreground/80">
      <ArrowUpRightIcon aria-hidden className="size-3" />
      Taking part
    </span>
  )
}

/** A listing from the University's public events programme (ENG-24),
 * linked to no student group here. Words and an icon, never colour
 * alone, and no University mark. */
export function UniversityBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-foreground/25 bg-muted/60 px-1.5 py-0.5 text-xs text-foreground/80">
      <LandmarkIcon aria-hidden className="size-3" />
      University
    </span>
  )
}

/** "University", "Taking part", "Cambridge only", "Cancelled", "To be
 * confirmed": words with an icon, not colours. */
export function EventFlags({
  event,
}: {
  event: Pick<EventListItem, "visibility" | "cancelled" | "status" | "hosting"> &
    Partial<Pick<EventListItem, "fromUniversity">>
}) {
  return (
    <>
      {event.cancelled && (
        <span className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-xs font-medium text-destructive">
          <BanIcon aria-hidden className="size-3" />
          Cancelled
        </span>
      )}
      {event.fromUniversity && <UniversityBadge />}
      {event.hosting === "takes_part" && <TakingPartBadge />}
      {event.visibility === "cam_only" && (
        <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-foreground/80">
          <LockIcon aria-hidden className="size-3" />
          Cambridge only
        </span>
      )}
      {event.status === "tbc" && (
        <span className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground">
          To be confirmed
        </span>
      )}
    </>
  )
}

/** The event's type as a tinted chip in its family's colours. */
export function EventTypeChip({ type, className }: { type: EventType; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[EVENT_TYPE_TONE[type]],
        className,
      )}
    >
      <span className="sr-only">Type: </span>
      {EVENT_TYPE_LABELS[type]}
    </span>
  )
}

/** A plain click opens the details in place (`onSelect`); a modified click
 * (new tab, new window) follows the link as usual. */
function selectHandler(onSelect: ((target: HTMLElement) => void) | undefined) {
  if (!onSelect) return undefined
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    onSelect(event.currentTarget)
  }
}

/** Who runs it — or, for someone else's event, who takes part (D6); the
 * University for one of its own listings (ENG-24). */
export function organiserLine(
  event: Pick<EventListItem, "organisers" | "hosting"> &
    Partial<Pick<EventListItem, "fromUniversity">>,
) {
  if (event.fromUniversity) return UNIVERSITY_NAME
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  if (event.hosting === "takes_part") return takesPart(names)
  return names.length > 0 ? names.join(", ") : undefined
}

/**
 * The row's "who" line with each society linked to its profile (SEO audit
 * "events-hub-hosts-unlinked": the calendar lists the week's events but
 * linked none of their societies). The links sit above the row's stretched
 * link (`relative z-10`), so they take their own clicks. Same words as
 * `organiserLine`.
 */
function OrganiserLinks({
  event,
}: {
  event: Pick<EventListItem, "organisers" | "hosting"> &
    Partial<Pick<EventListItem, "fromUniversity">>
}) {
  // The University's own listing (ENG-24) has no profile here to link.
  if (event.fromUniversity) return <>{UNIVERSITY_NAME}</>
  const hosts = event.organisers.filter((o) => o.role !== "sponsor")
  const links = hosts.map((organiser, index) => (
    <span key={`${organiser.key}-${organiser.role}`}>
      {index > 0 && (index === hosts.length - 1 && event.hosting === "takes_part" ? " and " : ", ")}
      <Link
        href={`/societies/${organiser.slug}`}
        className="relative z-10 rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {organiser.name}
      </Link>
    </span>
  ))
  if (event.hosting !== "takes_part") return <>{links}</>
  return (
    <>
      {links} {hosts.length === 1 ? "takes" : "take"} part
    </>
  )
}

/**
 * One event in the day-grouped agenda (talks-redesign-spec §6 "/events"):
 * the day is the sticky header above it, so the row carries no date — a
 * time column (start over end, or "All day"), the title in the serif,
 * "Organiser · Venue", then the type in its colour and the flags in words.
 *
 * The whole row is one link to the event's page; `onSelect` lets a plain
 * click open the details sheet in place instead.
 */
export function EventRow({
  event,
  href,
  onSelect,
  headingLevel = 3,
  className,
}: {
  event: EventListItem
  href: string
  onSelect?: (target: HTMLElement) => void
  headingLevel?: 2 | 3 | 4
  className?: string
}) {
  const { start, end } = eventTimes(event)
  const organisers = organiserLine(event)
  const Heading = `h${headingLevel}` as const
  const tone = EVENT_TYPE_TONE[event.eventType]

  return (
    <article
      className={cn(
        "group relative grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 py-3.5 sm:grid-cols-[4.75rem_minmax(0,1fr)] sm:gap-x-5",
        className,
      )}
    >
      <div className="flex flex-col pt-0.5 font-mono text-[0.8125rem] leading-tight tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
          <time
            dateTime={new Date(event.startsAt).toISOString()}
            className={cn(
              event.allDay && "font-sans text-xs font-medium",
              event.cancelled && "text-muted-foreground line-through",
            )}
          >
            {start}
          </time>
        </span>
        {end && (
          <span
            className={cn(
              "pl-3 text-muted-foreground",
              end.startsWith("until") && "mt-0.5 font-sans text-[0.6875rem] leading-snug",
            )}
          >
            {end}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="font-serif text-[1.0625rem] leading-snug font-medium text-pretty sm:text-lg">
          <Link
            href={href}
            scroll={false}
            onClick={selectHandler(onSelect)}
            className={cn(
              "line-clamp-2 rounded-sm decoration-1 underline-offset-4 after:absolute after:inset-0 after:rounded-lg group-hover:underline",
              "focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring",
              event.cancelled && "text-muted-foreground line-through",
            )}
          >
            <EventTitle title={event.title} />
          </Link>
        </Heading>
        {(organisers || event.venueText) && (
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            {organisers && (
              <span className="truncate">
                <OrganiserLinks event={event} />
              </span>
            )}
            {organisers && event.venueText && (
              <span aria-hidden className="shrink-0">
                ·
              </span>
            )}
            {event.venueText && (
              <span className="inline-flex min-w-0 shrink items-center gap-1">
                <MapPinIcon aria-hidden className="size-3 shrink-0" />
                <span className="sr-only">Venue: </span>
                <span className="truncate">{event.venueText}</span>
              </span>
            )}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <EventTypeChip type={event.eventType} />
          <EventFlags event={event} />
        </div>
      </div>
    </article>
  )
}

/** A row's shape while the agenda loads. */
export function EventRowSkeleton() {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 py-3.5 sm:grid-cols-[4.75rem_minmax(0,1fr)] sm:gap-x-5"
    >
      <div className="h-4 w-11 animate-pulse rounded bg-muted" />
      <div className="flex flex-col gap-2">
        <div className="h-5 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

/** A compact event for the week and month grids: a dot in the type's
 * colour, the time (none for an all-day event: the title needs the room)
 * and the title; someone else's event (D6) dashed with an arrow off-site,
 * the University's own (ENG-24) with a landmark. `when` replaces the time
 * ("until Fri 18 Dec" for an event already running). */
export function EventChip({
  event,
  href,
  onSelect,
  when,
  className,
}: {
  event: EventListItem
  href: string
  onSelect?: (target: HTMLElement) => void
  when?: string
  className?: string
}) {
  const tone = EVENT_TYPE_TONE[event.eventType]
  return (
    <Link
      href={href}
      scroll={false}
      onClick={selectHandler(onSelect)}
      className={cn(
        "flex min-w-0 items-baseline gap-1.5 rounded-md border border-transparent bg-card px-1.5 py-1 text-xs leading-snug shadow-[0_0_0_1px_var(--border)] transition-colors hover:shadow-[0_0_0_1px_color-mix(in_oklab,var(--events)_45%,transparent)] focus-visible:outline-2 focus-visible:outline-ring",
        event.hosting === "takes_part" && "border-dashed border-foreground/30 shadow-none",
        className,
      )}
      title={[formatEventWhen(event), spokenTitle(event.title), organiserLine(event)]
        .filter(Boolean)
        .join(" — ")}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", TONE_DOT[tone])}
      />
      {when || !event.allDay ? (
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          {when ?? londonTime(event.startsAt)}
        </span>
      ) : (
        <span className="sr-only">All day: </span>
      )}
      {/* `relative`: the clipped title is the containing block of its
          sr-only words, which otherwise sit past the cut and widen the page. */}
      <span
        className={cn(
          "relative min-w-0 truncate",
          event.cancelled && "text-muted-foreground line-through",
        )}
      >
        {event.visibility === "cam_only" && (
          <LockIcon aria-label="Cambridge only" className="mr-0.5 inline size-3 align-[-2px]" />
        )}
        {event.fromUniversity && (
          <LandmarkIcon
            aria-label="Listed by the University"
            className="mr-0.5 inline size-3 align-[-2px]"
          />
        )}
        {event.hosting === "takes_part" && (
          <ArrowUpRightIcon
            aria-label="Taking part, someone else’s event"
            className="mr-0.5 inline size-3 align-[-2px]"
          />
        )}
        {event.cancelled && <span className="sr-only">Cancelled: </span>}
        <EventTitle title={event.title} />
        <span className="sr-only">, {EVENT_TYPE_LABELS[event.eventType]}</span>
      </span>
    </Link>
  )
}
