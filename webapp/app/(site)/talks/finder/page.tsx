import type { Metadata } from "next"
import { FinderHero } from "@/components/molecules/finder-hero"
import { TalkFinder } from "@/components/organisms/talk-finder"
import { FINDER_PAGES } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"

/** The Talk Finder (ENG-131), inside the talks pillar. */
const PAGE = FINDER_PAGES.talks

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

export default function TalkFinderPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 py-10 sm:px-6">
      <FinderHero
        current="/talks/finder"
        title="Which talks are for you?"
        lede="Choose your subjects and the times that suit you. We pick the 15 best talks of the next week or two, and give you a calendar feed for each area."
      />
      <TalkFinder />
    </div>
  )
}
