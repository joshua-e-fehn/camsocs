import Link from "next/link"
import { type FeedEvent, feedSummary } from "@/lib/event-feed"

/**
 * "Newly listed" under the calendar on /events (event indexing, 2026-11-07):
 * links to the events added in the last two weeks (`eventFeed.newest`), in
 * the server HTML. The calendar itself links one week, so an event weeks
 * away, above all one of the University's (no society profile links it),
 * had no link from any page a search engine indexes; this gives each new
 * event one from the calendar's own page the day it is harvested. Renders
 * nothing when there is nothing new.
 */
export function NewlyListed({ events }: { events: readonly FeedEvent[] }) {
  if (events.length === 0) return null
  return (
    <section
      aria-labelledby="newly-listed-heading"
      className="mx-auto w-full max-w-7xl px-4 pt-4 pb-12 sm:px-6"
    >
      <div className="border-t pt-6">
        <h2
          id="newly-listed-heading"
          className="flex items-center gap-2 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
        >
          <span aria-hidden className="size-2 rounded-full bg-events" />
          Newly listed
        </h2>
        <ul className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <li key={event.key} className="min-w-0 text-sm">
              <Link
                href={`/events/${event.key}`}
                prefetch={false}
                className="font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {event.title}
              </Link>
              <span className="block truncate text-xs text-muted-foreground">
                {feedSummary(event)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
