import type { Metadata } from "next"
import Link from "next/link"
import { FinderHero } from "@/components/molecules/finder-hero"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { EventFinder } from "@/components/organisms/event-finder"
import { linkProps } from "@/lib/crawl-traps"
import { rankEvents } from "@/lib/finder"
import { FINDER_COLLEGES, FINDER_PAGES } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"
import { loadUpcomingEvents } from "@/lib/sport-events"

/**
 * The Events Finder (ENG-130) as a page that can rank for "what's on in
 * Cambridge this week" (ENG-134): the quiz, then this week's picks in the
 * HTML (the finder's own ranking with no answers: one row per show, at most
 * two per society), refreshed with the site.
 */
const PAGE = FINDER_PAGES.events

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

export default async function EventFinderPage() {
  const now = Date.now()
  const events = await loadUpcomingEvents(now, 7)
  const picks = events ? rankEvents(events, {}, now).map((s) => s.item) : []
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-10">
        <FinderHero
          current="/finder/events"
          title="What’s on in Cambridge this week?"
          lede="Tell us what you like and when you are free, and we pick the 15 best student events of the next two weeks, each one click from your calendar. Or start with this week’s picks below."
        />
        <EventFinder colleges={FINDER_COLLEGES} />
      </div>
      {picks.length > 0 && (
        <section aria-labelledby="this-week" className="flex flex-col gap-4">
          <h2 id="this-week" className="font-serif text-3xl tracking-[-0.01em]">
            This week’s picks
          </h2>
          <p className="text-muted-foreground">
            A spread of what Cambridge societies and clubs have on in the next seven days.{" "}
            <Link
              {...linkProps("/events")}
              className="text-foreground underline underline-offset-4"
            >
              See everything on
            </Link>
            .
          </p>
          <UpcomingEventList events={picks} empty="" limit={15} />
        </section>
      )}
    </div>
  )
}
