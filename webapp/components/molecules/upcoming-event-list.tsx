import Link from "next/link"
import { formatEventWhen } from "@/lib/calendar"
import type { SportEvent } from "@/lib/sport-calendar"

/**
 * A short list of events for a guide ("coming up"): when, the event (its
 * CAMsocs page) and who runs it. Server-rendered; the guide picks the events.
 */
export function UpcomingEventList({
  events,
  empty,
  limit = 12,
}: {
  events: readonly SportEvent[]
  empty: string
  limit?: number
}) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="flex flex-col divide-y rounded-xl border text-sm">
      {events.slice(0, limit).map((event) => (
        <li key={event.key} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:w-44 sm:pt-0.5">
            {formatEventWhen(event)}
          </span>
          <span className="min-w-0">
            <Link
              href={`/events/${event.key}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {event.title}
            </Link>
            {event.organisers[0] && (
              <span className="text-muted-foreground">
                {" · "}
                <Link
                  href={`/societies/${event.organisers[0].slug}`}
                  className="underline-offset-4 hover:underline"
                >
                  {event.organisers[0].name}
                </Link>
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
