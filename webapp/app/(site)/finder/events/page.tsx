import type { Metadata } from "next"
import { FinderHero } from "@/components/molecules/finder-hero"
import { EventFinder } from "@/components/organisms/event-finder"
import { FINDER_COLLEGES, FINDER_PAGES } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"

/** The Events Finder (ENG-130). */
const PAGE = FINDER_PAGES.events

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

export default function EventFinderPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 py-10 sm:px-6">
      <FinderHero
        current="/finder/events"
        title="What should you go to?"
        lede="Tell us what you like and when you are free. We pick the 15 best student events of the next two weeks, each one click from your calendar."
      />
      <EventFinder colleges={FINDER_COLLEGES} />
    </div>
  )
}
