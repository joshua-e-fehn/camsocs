import type { Metadata } from "next"
import Link from "next/link"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { ExternalLink } from "@/components/molecules/external-link"
import { Cite } from "@/components/molecules/guide-parts"
import { GuideSections } from "@/components/molecules/guide-sections"
import { ProseSection } from "@/components/molecules/prose-section"
import { GuideArticle } from "@/components/organisms/guide-article"
import { formatDate } from "@/lib/calendar"
import { COLLEGES_PATH, collegeInfo } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import { sectionSources } from "@/lib/guide-content"
import { guide } from "@/lib/guides"
import {
  BALL_KIND_LABELS,
  ballsByDate,
  MAY_BALL_ANCHOR,
  MAY_BALL_SECTIONS,
  MAY_BALLS,
  MAY_BALLS_CHECKED_ON,
  MAY_WEEK,
  ticketsInBrief,
} from "@/lib/may-balls"
import { pageMetadata } from "@/lib/page-metadata"

/**
 * May Balls and June Events (ENG-108): what May Week is, how tickets and
 * worker tickets work, and every college's ball for the coming year, from the
 * balls' own sites (lib/data/guides/may-balls.json). Each row links the
 * college's page, whose "May Ball" section keeps one URL from year to year.
 */

const GUIDE = guide("may-balls")

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDE.title, description: GUIDE.description, path: GUIDE.path }),
  openGraph: { type: "article" },
}

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

export default function MayBallsGuide() {
  const ballSection = {
    id: "balls",
    title: "",
    paragraphs: MAY_BALLS.map((ball) => ({ text: "", sources: ball.sources })),
  }
  const mayWeekSection = { id: "may-week", title: "", paragraphs: [MAY_WEEK] }
  // A ball's own site is cited by the ball's name, not its domain.
  const names = Object.fromEntries(
    MAY_BALLS.filter((ball) => ball.website).map((ball) => [
      new URL(ball.website as string).hostname.replace(/^www\./, ""),
      ball.name,
    ]),
  )
  const sources = sectionSources(
    [mayWeekSection, ...MAY_BALL_SECTIONS, ballSection],
    MAY_BALLS_CHECKED_ON,
    names,
  )
  const byUrl = new Map(sources.map((source) => [source.url, source]))
  const balls = ballsByDate()
  return (
    <GuideArticle
      guide={GUIDE}
      sources={sources}
      toc={[
        ["#may-week", "When May Week is"],
        ...MAY_BALL_SECTIONS.map((s) => [`#${s.id}`, s.title] as const),
        ["#balls", "Every college’s ball"],
      ]}
      lede={
        <>
          May Balls are the colleges’ all-night balls at the end of the year, held in June despite
          the name. Here is when May Week is, how tickets and worker tickets work, what to wear, and
          each college’s ball for the coming year.
        </>
      }
      aside={
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Before you buy</h2>
          <p className="text-muted-foreground">
            Buy only from the ball’s own site. CAMsocs sells no tickets and is not linked to any
            ball.
          </p>
          <Link
            href={COLLEGES_PATH}
            className="font-medium text-brand-text underline-offset-4 hover:underline"
          >
            All colleges
          </Link>
        </div>
      }
    >
      <ProseSection id="may-week" title="When May Week is">
        <p>
          {MAY_WEEK.text}
          {MAY_WEEK.sources.map((url) => {
            const source = byUrl.get(url)
            return source ? <Cite key={url} source={source} /> : null
          })}
        </p>
      </ProseSection>

      <GuideSections sections={MAY_BALL_SECTIONS} sources={sources} />

      <section
        id="balls"
        aria-labelledby="balls-title"
        className="flex scroll-mt-20 flex-col gap-3"
      >
        <h2 id="balls-title" className="font-serif text-2xl font-normal tracking-[-0.01em]">
          Every college’s ball
        </h2>
        <p className="text-sm text-muted-foreground">
          As each ball’s own site gives it, checked {formatDate(MAY_BALLS_CHECKED_ON)}. Balls
          announce dates and ticket releases through the year; their sites are the authority.
        </p>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <caption className="sr-only">May Balls and June Events by college</caption>
            <thead className="border-b bg-muted/40">
              <tr>
                <th scope="col" className={TH}>
                  Ball
                </th>
                <th scope="col" className={TH}>
                  Date
                </th>
                <th scope="col" className={TH}>
                  Tickets
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {balls.map((ball) => {
                const college = collegeInfo(ball.collegeKey)
                return (
                  <tr key={`${ball.collegeKey}-${ball.name}`}>
                    <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                      <span className="flex items-start gap-2">
                        {college && <CollegeCrest crest={college.crest} size={28} decorative />}
                        <span className="flex flex-col">
                          {college ? (
                            <Link
                              href={`${collegeHubPath(college)}#${MAY_BALL_ANCHOR}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {ball.name}
                            </Link>
                          ) : (
                            ball.name
                          )}
                          <span className="text-xs font-normal text-muted-foreground">
                            {BALL_KIND_LABELS[ball.kind]}
                            {ball.dress ? ` · ${ball.dress}` : ""}
                          </span>
                        </span>
                      </span>
                    </th>
                    <td className="px-3 py-2.5 align-top">
                      {ball.date ? formatDate(ball.date) : ball.dateText}
                    </td>
                    <td className="px-3 py-2.5 align-top text-muted-foreground">
                      {ticketsInBrief(ball.tickets)}
                      {ball.website && (
                        <>
                          {" "}
                          <ExternalLink href={ball.website} className="text-foreground underline">
                            Site
                          </ExternalLink>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </GuideArticle>
  )
}
