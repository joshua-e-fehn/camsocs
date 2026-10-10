import { ArrowUpRightIcon, LockIcon } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import {
  formatEventTime,
  formatEventWhen,
  londonIsoDate,
  londonTime,
  monthShort,
  weekdayShort,
} from "@/lib/calendar"
import { takesPart } from "@/lib/format"
import type { EventListItem } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { EVENT_TYPE_LABELS } from "@/lib/vocab"

/** Someone else's event the listed societies only take part in (decision
 * D6): an arrow off-site and the words, never colour alone — and dashed, like
 * the card that carries it. */
export function TakingPartBadge() {
  return (
    <Badge variant="outline" className="gap-1 border-dashed font-normal">
      <ArrowUpRightIcon aria-hidden />
      Taking part
    </Badge>
  )
}

/** "Cambridge only", "Cancelled", "Time TBC", "Taking part" — words, not colours. */
export function EventFlags({
  event,
}: {
  event: Pick<EventListItem, "visibility" | "cancelled" | "status" | "hosting">
}) {
  return (
    <>
      {event.hosting === "takes_part" && <TakingPartBadge />}
      {event.visibility === "cam_only" && (
        <Badge variant="outline" className="gap-1 font-normal">
          <LockIcon aria-hidden />
          Cambridge only
        </Badge>
      )}
      {event.cancelled && (
        <Badge variant="destructive" className="font-normal">
          Cancelled
        </Badge>
      )}
      {event.status === "tbc" && (
        <Badge variant="outline" className="font-normal">
          To be confirmed
        </Badge>
      )}
    </>
  )
}

/** A plain click opens the details in place (`onSelect`); a modified click
 * (new tab, new window) follows the link as usual. */
function selectHandler(onSelect: (() => void) | undefined) {
  if (!onSelect) return undefined
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    onSelect()
  }
}

/** Who runs it — or, for someone else's event, who takes part (D6). */
function organiserLine(event: EventListItem): string | undefined {
  const names = event.organisers.filter((o) => o.role !== "sponsor").map((o) => o.name)
  if (event.hosting === "takes_part") return takesPart(names)
  return names.length > 0 ? names.join(", ") : undefined
}

/** One event in a list: date block, time, title, organisers and venue. Links
 * to its details (`href`, usually the calendar URL with `event=` set). With
 * `runLabel` it stands for a run of the same show (lib/event-runs.ts): the
 * label ("Tue 27 Oct – Sat 31 Oct · 6 performances") replaces the time. */
export function EventItem({
  event,
  href,
  onSelect,
  runLabel,
  className,
}: {
  event: EventListItem
  href: string
  onSelect?: () => void
  runLabel?: string
  className?: string
}) {
  const day = londonIsoDate(event.startsAt)
  const date = Number(day.slice(8, 10))
  const organisers = organiserLine(event)
  const where = event.venueText

  return (
    <Link
      href={href}
      scroll={false}
      onClick={selectHandler(onSelect)}
      className={cn(
        "group flex gap-4 rounded-xl border bg-card p-3 text-card-foreground transition-colors duration-200 hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-4",
        event.hosting === "takes_part" && "border-dashed",
        event.cancelled && "opacity-70",
        className,
      )}
    >
      <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-muted py-1.5 font-mono leading-tight">
        <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
          {weekdayShort(day)}
        </span>
        <span className="text-lg font-semibold tabular-nums">{date}</span>
        <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
          {monthShort(day)}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <time dateTime={new Date(event.startsAt).toISOString()} className="font-mono">
            {runLabel ?? formatEventTime(event)}
          </time>
          {!runLabel && event.termWeekLabel && (
            <span className="font-mono text-xs tracking-tight">· {event.termWeekLabel}</span>
          )}
          <Badge variant="secondary" className="font-normal">
            {EVENT_TYPE_LABELS[event.eventType]}
          </Badge>
          <EventFlags event={event} />
        </div>
        <h3
          className={cn(
            "font-medium leading-snug group-hover:underline group-hover:underline-offset-4",
            event.cancelled && "line-through",
          )}
        >
          {event.title}
        </h3>
        {(organisers || where) && (
          <p className="truncate text-sm text-muted-foreground">
            {[organisers, where].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
    </Link>
  )
}

/** A compact event for the week and month grids: time and title; someone
 * else's event (D6) dashed, with an arrow off-site. */
export function EventChip({
  event,
  href,
  onSelect,
}: {
  event: EventListItem
  href: string
  onSelect?: () => void
}) {
  return (
    <Link
      href={href}
      scroll={false}
      onClick={selectHandler(onSelect)}
      className={cn(
        "block truncate rounded-md border bg-card px-1.5 py-1 text-xs transition-colors hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-ring",
        event.hosting === "takes_part" && "border-dashed",
        event.cancelled && "line-through opacity-70",
      )}
      title={[formatEventWhen(event), event.title, organiserLine(event)]
        .filter(Boolean)
        .join(" — ")}
    >
      <span className="mr-1 font-mono text-muted-foreground">
        {event.allDay ? "All day" : londonTime(event.startsAt)}
      </span>
      {event.visibility === "cam_only" && (
        <LockIcon aria-label="Cambridge only" className="mr-0.5 inline size-3 align-[-2px]" />
      )}
      {event.hosting === "takes_part" && (
        <ArrowUpRightIcon
          aria-label="Taking part, someone else’s event"
          className="mr-0.5 inline size-3 align-[-2px]"
        />
      )}
      {event.title}
    </Link>
  )
}
