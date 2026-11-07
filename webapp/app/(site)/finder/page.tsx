import type { Metadata } from "next"
import { FinderHero } from "@/components/molecules/finder-hero"
import { SocietyFinder } from "@/components/organisms/society-finder"
import { FINDER_COLLEGES, FINDER_PAGES } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"

/** The Society Finder (ENG-128): a quiz, then 15 societies to follow in one calendar. */
const PAGE = FINDER_PAGES.societies

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

export default function SocietyFinderPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-4 py-10 sm:px-6">
      <FinderHero
        current="/finder"
        title="Find your societies in 60 seconds"
        lede="Five quick questions. Then the 15 societies and clubs that fit you best, ready to follow in one calendar that keeps itself up to date. No account needed."
      />
      <SocietyFinder colleges={FINDER_COLLEGES} />
    </div>
  )
}
