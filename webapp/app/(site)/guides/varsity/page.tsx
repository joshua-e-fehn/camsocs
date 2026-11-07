import type { Metadata } from "next"
import Link from "next/link"
import { ClubLinks } from "@/components/molecules/club-links"
import { GuideSections } from "@/components/molecules/guide-sections"
import { ProseSection } from "@/components/molecules/prose-section"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { GuideArticle } from "@/components/organisms/guide-article"
import { formatDate } from "@/lib/calendar"
import { categoryHubPath } from "@/lib/directory-hubs"
import { sectionSources } from "@/lib/guide-content"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { varsityFixtures } from "@/lib/sport-calendar"
import { loadSportEvents } from "@/lib/sport-events"
import { fixturesByDate, VARSITY_CHECKED_ON, VARSITY_SECTIONS } from "@/lib/varsity"

/**
 * Varsity (ENG-110, with the ski trip, ENG-111): what Cambridge v Oxford
 * sport is, the big fixtures and the Varsity Trip, from the organisers' own
 * pages (lib/data/guides/varsity.json), plus the Varsity fixtures CAMsocs
 * already lists (lib/sport-calendar.ts), which move on with the data.
 */

const GUIDE = guide("varsity")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

/** The clubs each section is about, as they are listed on CAMsocs. */
const CLUBS: Record<string, readonly (readonly [string, string])[]> = {
  blues: [["the-hawks-club", "The Hawks' Club"]],
  "boat-race": [["boat-club-rowing", "Cambridge University Boat Club"]],
  "varsity-match": [["rugby-union-football-club", "Rugby Union Football Club"]],
  hockey: [["hockey-club", "Hockey Club"]],
  other: [
    ["rugby-league-club", "Rugby League"],
    ["amateur-boxing-club", "Boxing"],
    ["ice-hockey-club", "Ice Hockey"],
    ["polo-club", "Polo"],
    ["swimming-and-waterpolo-club", "Swimming and Water Polo"],
    ["athletic-club", "Athletics"],
    ["football-club", "Football"],
    ["cricket-club", "Cricket"],
    ["real-tennis-club", "Real Tennis"],
    ["golf-club", "Golf"],
  ],
  "ski-trip": [["varsity-trip", "Varsity Trip"]],
  "ski-races": [["ski-and-snowboard-society", "Ski and Snowboarding Club"]],
}

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

export default async function VarsityGuide() {
  const events = await loadSportEvents(Date.now())
  const upcoming = events ? varsityFixtures(events) : null
  const sources = sectionSources(VARSITY_SECTIONS, VARSITY_CHECKED_ON)
  const fixtures = fixturesByDate()
  const [first, ...rest] = VARSITY_SECTIONS
  return (
    <GuideArticle
      guide={GUIDE}
      sources={sources}
      toc={[
        ["#what", "What Varsity is"],
        ["#dates", "Dates this season"],
        ...rest.map((section) => [`#${section.id}`, section.title] as const),
      ]}
      lede={
        <>
          Every year Cambridge and Oxford students meet in dozens of sports, from the Boat Race and
          the rugby Varsity Match to boxing, polo and the ski races. Here is what Varsity is, this
          season’s dates and how to watch.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Join a team</h2>
          <p className="text-muted-foreground">
            Every University club CAMsocs lists is on the sport page; many take beginners.
          </p>
          <Link
            href={categoryHubPath("sport")}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Sport and fitness clubs
          </Link>
          <Link
            href="/guides/rowing"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            The rowing guide
          </Link>
        </div>
      }
    >
      {first && <GuideSections sections={[first]} sources={sources} />}

      <ProseSection id="dates" title="Dates this season">
        <p>
          The fixtures whose 2026–27 dates the organisers have published, as of{" "}
          {formatDate(VARSITY_CHECKED_ON)}. Other Varsity dates are usually announced closer to the
          day.
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm text-foreground">
            <caption className="sr-only">Varsity fixtures in 2026–27</caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  Fixture
                </th>
                <th scope="col" className={TH}>
                  When
                </th>
                <th scope="col" className={TH}>
                  Where
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {fixtures.map((fixture) => (
                <tr key={fixture.event}>
                  <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                    {fixture.event}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {fixture.sport}
                    </span>
                  </th>
                  <td className="px-3 py-2.5 align-top">
                    {fixture.date ? formatDate(fixture.date) : fixture.dateText}
                  </td>
                  <td className="px-3 py-2.5 align-top text-muted-foreground">
                    {fixture.venue ?? "Not yet announced"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {upcoming && upcoming.length > 0 && (
          <>
            <h3>Varsity fixtures listed on CAMsocs</h3>
            <UpcomingEventList events={upcoming} empty="" />
          </>
        )}
      </ProseSection>

      {rest.map((section) => (
        <div key={section.id} className="flex flex-col gap-3">
          <GuideSections sections={[section]} sources={sources} />
          <ClubLinks clubs={CLUBS[section.id] ?? []} />
        </div>
      ))}
    </GuideArticle>
  )
}
