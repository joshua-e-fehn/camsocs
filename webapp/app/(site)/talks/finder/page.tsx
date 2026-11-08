import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FinderHero } from "@/components/molecules/finder-hero"
import { TalkFinder } from "@/components/organisms/talk-finder"
import { api } from "@/convex/_generated/api"
import { addDays, formatEventWhen, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { rankTalks } from "@/lib/finder"
import { FINDER_PAGES } from "@/lib/finder-pages"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"

/**
 * The Talk Finder (ENG-131), inside the talks pillar, as a page that can
 * rank for "interesting talks in Cambridge this week" (ENG-134): the quiz,
 * then this week's picks in the HTML (the finder's own ranking with no
 * answers, at most two per series). Talks are read here, under /talks, as
 * the talks boundary requires (G1); never in a module outside it.
 */
const PAGE = FINDER_PAGES.talks

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
})

async function loadWeek(now: number) {
  const today = londonIsoDate(now)
  try {
    const page = await publicQuery(api.talks.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, 7)),
      paginationOpts: { numItems: 100, cursor: null },
    })
    return page.page
  } catch (error) {
    unstable_rethrow(error)
    console.error("talks.list failed; the talk finder without its picks", error)
    return null
  }
}

export default async function TalkFinderPage() {
  const now = Date.now()
  const talks = await loadWeek(now)
  const picks = talks ? rankTalks(talks, {}, now, 12).map((s) => s.item) : []
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-10">
        <FinderHero
          current="/talks/finder"
          title="Which talks are for you?"
          lede="Choose your subjects and the times that suit you. We pick the 15 best Cambridge talks of the next week or two, and give you a calendar feed for each area. Or start with this week’s picks below."
        />
        <TalkFinder />
      </div>
      {picks.length > 0 && (
        <section aria-labelledby="this-week" className="flex flex-col gap-4">
          <h2 id="this-week" className="font-serif text-3xl tracking-[-0.01em]">
            Talks this week
          </h2>
          <p className="text-muted-foreground">
            A spread of the talks on across the University in the next seven days.{" "}
            <Link href="/talks" className="text-foreground underline underline-offset-4">
              See every talk
            </Link>
            .
          </p>
          <ul className="flex flex-col divide-y rounded-xl border text-sm">
            {picks.map((talk) => (
              <li key={talk.key} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:w-44 sm:pt-0.5">
                  {formatEventWhen({
                    startsAt: talk.startsAt,
                    endsAt: talk.endsAt ?? undefined,
                    allDay: talk.allDay,
                  })}
                </span>
                <span className="min-w-0">
                  <Link
                    href={`/talks/${talk.key}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {talk.title}
                  </Link>
                  {talk.departments[0] && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {talk.departments[0].shortName}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
