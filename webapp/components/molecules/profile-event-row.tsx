import { LockIcon } from "lucide-react"
import Link from "next/link"
import { EventFlags } from "@/components/molecules/event-item"
import { TermDateBlock } from "@/components/molecules/term-date-block"
import { formatEventTime, formatInstantDate, londonIsoDate, weekdayShort } from "@/lib/calendar"
import { linkProps } from "@/lib/crawl-traps"
import { type EventRun, runSummary } from "@/lib/event-runs"
import type { EventListItem } from "@/lib/public-api"
import { camSignInHref } from "@/lib/site"
import { cn } from "@/lib/utils"

/**
 * A society profile's "Coming up" pieces, shared by the server-rendered
 * profile (organisms/org-profile.tsx) and the browser's Cambridge-only top-up
 * (organisms/profile-cam-only-events.tsx), so a signed-in reader's extra
 * events look like the rest.
 */

/** One upcoming event (or a run of a show) as a row with its term-week date block. */
export function ProfileEventRow({ run, href }: { run: EventRun<EventListItem>; href: string }) {
  const event = run.events[0]
  const day = londonIsoDate(event.startsAt)
  const when = run.events.length > 1 ? runSummary(run) : formatEventTime(event)
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-start gap-4 rounded-xl border bg-card p-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        event.hosting === "takes_part" && "border-dashed",
      )}
    >
      <TermDateBlock
        startsAt={event.startsAt}
        termWeekLabel={event.termWeekLabel}
        label={`${weekdayShort(day)} ${formatInstantDate(event.startsAt)}${event.termWeekLabel ? `, ${event.termWeekLabel}` : ""}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <h3
          className={cn(
            "leading-snug font-semibold text-pretty group-hover:underline group-hover:underline-offset-4",
            event.cancelled && "line-through decoration-muted-foreground",
          )}
        >
          {event.title}
        </h3>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-xs tabular-nums">{when}</span>
          {event.venueText && <span> · {event.venueText}</span>}
        </p>
        <div className="flex flex-wrap gap-1 empty:hidden">
          <EventFlags event={event} />
        </div>
      </div>
    </Link>
  )
}

/** "N more Cambridge-only events — sign in with your @cam.ac.uk email", or
 * nothing when there are none (or the count is unknown). */
export function CamOnlyHint({ count, path }: { count: number | null; path: string }) {
  if (count === null || count <= 0) return null
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LockIcon aria-hidden className="size-4" />
      <span>
        {count} more Cambridge-only {count === 1 ? "event" : "events"} —{" "}
        <Link {...linkProps(camSignInHref(path))} className="underline underline-offset-4">
          sign in with your @cam.ac.uk email
        </Link>
      </span>
    </p>
  )
}
