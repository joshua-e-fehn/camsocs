import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FinderHero } from "@/components/molecules/finder-hero"
import { ProseSection } from "@/components/molecules/prose-section"
import { SocietyFinder } from "@/components/organisms/society-finder"
import { api } from "@/convex/_generated/api"
import { categoryHubPath } from "@/lib/directory-hubs"
import { FINDER_COLLEGES, FINDER_PAGES, STARTING_POINTS } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { CATEGORY_LABELS } from "@/lib/vocab"

/**
 * The Society Finder (ENG-128) as a page search engines can rank for "which
 * society should I join" (ENG-134): the quiz, then server-rendered starting
 * points (the finder's own top picks for a beginner in each of nine
 * interests, refreshed with the site) and short answers that link the
 * guides. The quiz itself runs in the browser; everything below it is in
 * the HTML.
 */
const PAGE = FINDER_PAGES.societies

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

/** Five beginner-friendly picks per interest, or null when Convex cannot be read. */
async function loadStartingPoints() {
  try {
    return await Promise.all(
      STARTING_POINTS.map(async (interest) => ({
        interest,
        picks: (
          await publicQuery(api.orgs.finder, {
            answers: { interests: [interest], level: ["beginner"], where: ["anywhere"] },
          })
        ).slice(0, 5),
      })),
    )
  } catch (error) {
    unstable_rethrow(error)
    console.error("orgs.finder failed; /finder without starting points", error)
    return null
  }
}

export default async function SocietyFinderPage() {
  const points = await loadStartingPoints()
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-10">
        <FinderHero
          current="/finder"
          title="Which society should you join?"
          lede="Five quick questions. Then the 15 Cambridge societies and clubs that fit you best, ready to follow in one calendar that keeps itself up to date. No account needed."
        />
        <SocietyFinder colleges={FINDER_COLLEGES} />
      </div>

      {points && (
        <section aria-labelledby="starting-points" className="flex flex-col gap-4">
          <h2 id="starting-points" className="font-serif text-3xl tracking-[-0.01em]">
            Popular starting points
          </h2>
          <p className="text-muted-foreground">
            The Finder’s picks for a complete beginner in nine common interests, from the societies
            CAMsocs lists, busiest first.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {points
              .filter((point) => point.picks.length > 0)
              .map(({ interest, picks }) => (
                <div key={interest} className="flex flex-col gap-2 rounded-2xl border p-4">
                  <h3 className="font-medium">{CATEGORY_LABELS[interest]} for beginners</h3>
                  <ul className="flex flex-col gap-1 text-sm">
                    {picks.map((pick) => (
                      <li key={pick.key}>
                        <Link
                          href={`/societies/${pick.slug}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {pick.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={categoryHubPath(interest)}
                    className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-brand-text"
                  >
                    All {CATEGORY_LABELS[interest].toLowerCase()}
                    <ArrowRightIcon aria-hidden className="size-3.5" />
                  </Link>
                </div>
              ))}
          </div>
        </section>
      )}

      <ProseSection id="choosing" title="Choosing a society">
        <h3>Which society should I join?</h3>
        <p>
          Start from something you already enjoy and add one thing you have always wanted to try.
          The quiz above narrows every listing on CAMsocs to the 15 that fit what you say, with the
          reasons each one fits, and the ones running events this term first.
        </p>
        <h3>Can I join later in the year?</h3>
        <p>
          Many societies take new members all year. The{" "}
          <Link href="/guides/join-a-society">guide to finding and joining societies</Link> covers
          the fairs, joining after them and what it costs, and the{" "}
          <Link href="/guides/freshers">Freshers’ guide</Link> has the Refreshers’ Fair in January.
        </p>
        <h3>Is there a list for me?</h3>
        <p>
          There are lists of societies <Link href="/for/beginners">for beginners</Link>,{" "}
          <Link href="/for/postgraduates">for postgraduates</Link> and{" "}
          <Link href="/for/international-students">for international students</Link>, every{" "}
          <Link href="/categories">category</Link> and every <Link href="/colleges">college</Link>.
        </p>
      </ProseSection>
    </div>
  )
}
