import type { Metadata } from "next"
import Link from "next/link"
import { Cite } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { ResearchedGuide } from "@/components/organisms/researched-guide"
import { formatDate, londonIsoDate } from "@/lib/calendar"
import {
  FRESHERS_CHECKED_ON,
  FRESHERS_DATES,
  FRESHERS_LINKS,
  FRESHERS_SECTIONS,
} from "@/lib/freshers"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { loadWelcomeEvents } from "@/lib/welcome-events"

/**
 * Freshers' Week and Refreshers' (ENG-117): what happens before and after
 * you arrive, the fairs, postgraduate inductions, the Refreshers' Fair and
 * settling in, from the University, Cambridge SU and the colleges
 * (lib/data/guides/freshers.json); key dates; and the welcome and taster
 * events CAMsocs lists, which fill up each September and January.
 */

const GUIDE = guide("freshers")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

export default async function FreshersGuide() {
  const now = Date.now()
  const today = londonIsoDate(now)
  const welcome = await loadWelcomeEvents(now)
  const upcomingDates = FRESHERS_DATES.filter((row) => !row.date || row.date >= today).sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"),
  )
  const datesSection = {
    id: "dates",
    title: "Key dates",
    paragraphs: FRESHERS_DATES.map((row) => ({ text: row.event, sources: row.sources })),
  }
  return (
    <ResearchedGuide
      guide={GUIDE}
      sections={FRESHERS_SECTIONS}
      extraSections={[datesSection]}
      checkedOn={FRESHERS_CHECKED_ON}
      clubs={FRESHERS_LINKS}
      lede={
        <>
          Your first weeks at Cambridge are run mostly by your college: a welcome timetable,
          matriculation, the fairs and a lot of new words. Here is what happens before you arrive,
          in Freshers’ Week and at the Refreshers’ Fair in January.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Find your people</h2>
          <Link
            href="/for/beginners"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Societies for beginners
          </Link>
          <Link
            href="/for/postgraduates"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Societies for postgraduates
          </Link>
          <Link
            href="/for/international-students"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Societies for international students
          </Link>
          <Link
            href="/guides/glossary"
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            Cambridge words explained
          </Link>
        </div>
      }
    >
      {(sources) => (
        <>
          {upcomingDates.length > 0 && (
            <ProseSection id="dates" title="Key dates">
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full text-sm text-foreground">
                  <caption className="sr-only">Key dates for new students</caption>
                  <tbody className="divide-y">
                    {upcomingDates.map((row) => {
                      const source = sources.find((s) => s.url === row.sources[0])
                      return (
                        <tr key={row.event}>
                          <th scope="row" className={`${TH} w-40 font-mono normal-case`}>
                            {row.date ? formatDate(row.date) : "Not yet announced"}
                          </th>
                          <td className="px-3 py-2.5 align-top">
                            {row.event}
                            {source && <Cite source={source} />}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </ProseSection>
          )}
          {welcome && welcome.length > 0 && (
            <ProseSection id="welcome-events" title="Welcome and taster events on CAMsocs">
              <UpcomingEventList events={welcome} empty="" />
            </ProseSection>
          )}
        </>
      )}
    </ResearchedGuide>
  )
}
