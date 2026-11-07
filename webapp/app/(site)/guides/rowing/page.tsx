import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ClubLinks } from "@/components/molecules/club-links"
import { Cite } from "@/components/molecules/guide-parts"
import { GuideSections } from "@/components/molecules/guide-sections"
import { ProseSection } from "@/components/molecules/prose-section"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { GuideArticle } from "@/components/organisms/guide-article"
import { api } from "@/convex/_generated/api"
import { formatDate } from "@/lib/calendar"
import { COLLEGES_PATH } from "@/lib/colleges"
import { sectionSources } from "@/lib/guide-content"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import {
  GLOSSARY_SECTION,
  ROWING_CHECKED_ON,
  ROWING_DATES,
  ROWING_GLOSSARY,
  ROWING_SECTIONS,
} from "@/lib/rowing"
import { rowingRaces } from "@/lib/sport-calendar"
import { loadSportEvents } from "@/lib/sport-events"

/**
 * Rowing (ENG-109): college and University rowing, how bumps racing works and
 * the year's races, from CUCBC, CUBC and the clubs' own pages
 * (lib/data/guides/rowing.json). The "coming up" list is CUCBC's timetable as
 * CAMsocs holds it (lib/sport-calendar.ts), so it moves on with the data; the
 * college boat clubs are the directory's own.
 */

const GUIDE = guide("rowing")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

/** The college boat clubs CAMsocs lists, by name; null when Convex cannot be read. */
async function loadBoatClubs() {
  try {
    const cards = await publicQuery(api.orgs.hub, { category: "sport" })
    return cards
      .filter((card) => card.orgType === "college_boat_club")
      .map((card) => [card.slug, card.name] as const)
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

const CLUBS: Record<string, readonly (readonly [string, string])[]> = {
  cucbc: [["cambridge-university-combined-boat-clubs", "CUCBC"]],
  fairbairns: [["jesus-college-boat-club", "Jesus College Boat Club"]],
  cubc: [["boat-club-rowing", "Cambridge University Boat Club"]],
}

function when(start: string | null, end: string | null): string {
  if (!start) return "Not yet announced"
  return end && end !== start ? `${formatDate(start)} – ${formatDate(end)}` : formatDate(start)
}

export default async function RowingGuide() {
  const [events, boatClubs] = await Promise.all([loadSportEvents(Date.now()), loadBoatClubs()])
  const races = events ? rowingRaces(events) : null
  const sources = sectionSources([...ROWING_SECTIONS, GLOSSARY_SECTION], ROWING_CHECKED_ON)
  const byUrl = new Map(sources.map((source) => [source.url, source]))
  const dateSources = sectionSources(
    [
      {
        id: "d",
        title: "",
        paragraphs: ROWING_DATES.map((d) => ({ text: "", sources: d.sources })),
      },
    ],
    ROWING_CHECKED_ON,
  )
  const allSources = [...sources, ...dateSources.filter((s) => !byUrl.has(s.url))]
  const intro = ROWING_SECTIONS.slice(0, 3)
  const rest = ROWING_SECTIONS.slice(3)
  return (
    <GuideArticle
      guide={GUIDE}
      sources={allSources}
      toc={[
        ...intro.map((s) => [`#${s.id}`, s.title] as const),
        ["#dates", "The year’s races"],
        ...rest.map((s) => [`#${s.id}`, s.title] as const),
        ["#glossary", GLOSSARY_SECTION.title],
        ["#clubs", "Every college boat club"],
      ]}
      lede={
        <>
          Every Cambridge college has a boat club, and most rowers start from scratch as novices in
          their first term. Here is how college and University rowing work, how the Bumps are raced,
          and the year’s races.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Find your boat club</h2>
          <p className="text-muted-foreground">
            Each college’s page on CAMsocs links its boat club, JCR and MCR.
          </p>
          <Link
            href={COLLEGES_PATH}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            All colleges
          </Link>
          <Link
            href="/guides/varsity"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Varsity and the Boat Race
          </Link>
        </div>
      }
    >
      {intro.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <GuideSections sections={[section]} sources={allSources} />
          <ClubLinks clubs={CLUBS[section.id] ?? []} />
        </div>
      ))}

      <ProseSection id="dates" title="The year’s races">
        <p>
          Dates as the rowing bodies publish them, checked {formatDate(ROWING_CHECKED_ON)}.
          “Provisional” dates are on CUCBC’s river closures list but not yet on its race pages.
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm text-foreground">
            <caption className="sr-only">Rowing races in 2026–27</caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  Race
                </th>
                <th scope="col" className={TH}>
                  When
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ROWING_DATES.map((row) => (
                <tr key={row.event}>
                  <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                    {row.event}
                  </th>
                  <td className="px-3 py-2.5 align-top">
                    {when(row.start, row.end)}
                    {row.provisional && (
                      <span className="ml-2 text-xs text-muted-foreground">provisional</span>
                    )}
                    {row.sources[0] && (
                      <Cite
                        source={allSources.find((s) => s.url === row.sources[0]) ?? allSources[0]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {races && races.length > 0 && (
          <>
            <h3>Coming up on CAMsocs</h3>
            <UpcomingEventList events={races} empty="" />
          </>
        )}
      </ProseSection>

      {rest.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <GuideSections sections={[section]} sources={allSources} />
          <ClubLinks clubs={CLUBS[section.id] ?? []} />
        </div>
      ))}

      <ProseSection id="glossary" title={GLOSSARY_SECTION.title}>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_1fr]">
          {ROWING_GLOSSARY.map((entry) => (
            <div key={entry.term} className="contents">
              <dt className="font-medium text-foreground">{entry.term}</dt>
              <dd>
                {entry.text}
                {entry.sources.map((url) => {
                  const source = byUrl.get(url)
                  return source ? <Cite key={url} source={source} /> : null
                })}
              </dd>
            </div>
          ))}
        </dl>
      </ProseSection>

      {boatClubs && boatClubs.length > 0 && (
        <ProseSection id="clubs" title="Every college boat club">
          <p>
            The {boatClubs.length} college boat clubs CAMsocs lists. Most take novices every
            October.
          </p>
          <ul className="!flex-row flex-wrap !gap-x-4 !gap-y-1 !list-none !pl-0">
            {boatClubs.map(([slug, name]) => (
              <li key={slug}>
                <Link href={`/societies/${slug}`}>{name}</Link>
              </li>
            ))}
          </ul>
        </ProseSection>
      )}
    </GuideArticle>
  )
}
