import { CalendarOffIcon } from "lucide-react"
import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { ExternalLink } from "@/components/molecules/external-link"
import { ProseSection } from "@/components/molecules/prose-section"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { formatDayShort } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER } from "@/lib/site"
import {
  academicYearLabel,
  byAcademicYear,
  formatDayWithYear,
  termTitle,
  termWeeks,
} from "@/lib/term-calendar"
import { fetchTermDates } from "@/lib/term-dates"
import { startsIn, TEACHING_WEEKS, TERM_NAMES, termClock, weekOfTerm } from "@/lib/term-week"

/**
 * Cambridge's Full Term dates and what week of term it is (SEO audit
 * 2026-11-02, answer-and-editorial-content): a recurring question whose
 * search results are third-party calendars that disagree. Built only from
 * the dates the site already holds (`termDates`, read from the University's
 * published page by the pipeline's `term_dates` stage) and the week rule the
 * term clock uses (lib/term-week.ts); nothing is written by hand, so it can
 * be no more wrong than the source, which every table links.
 */

type Rows = Awaited<ReturnType<typeof fetchTermDates>>

/** The term dates, or null when Convex cannot be read (the page then says so
 * rather than showing nothing, and is kept out of the index). */
async function loadRows(): Promise<Rows | null> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    console.error("termDates.list failed; the term dates page without dates", error)
    return null
  }
}

/** The academic year whose dates lead the page: the one the current or next
 * term belongs to, else the latest. */
function currentYear(rows: Rows, now: number): string | undefined {
  const clock = termClock(now, rows)
  const start = clock.kind === "term" ? clock.fullTermStart : clock.next?.fullTermStart
  return rows.find((row) => row.fullTermStart === start)?.academicYear ?? rows.at(-1)?.academicYear
}

export async function generateMetadata(): Promise<Metadata> {
  const rows = await loadRows()
  const year = rows && rows.length > 0 ? currentYear(rows, Date.now()) : undefined
  const metadata = pageMetadata({
    title: year
      ? `Cambridge term dates ${academicYearLabel(year)}: what week is it?`
      : "Cambridge term dates: what week is it?",
    description:
      "Cambridge Full Term dates for Michaelmas, Lent and Easter, the week of term today and when each week starts, from the University's published dates.",
    path: "/term-dates",
  })
  return rows && rows.length > 0 ? metadata : { ...metadata, robots: { index: false } }
}

const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"
const TD = "px-3 py-2.5 align-top"

export default async function TermDatesPage() {
  const now = Date.now()
  const rows = await loadRows()

  if (!rows || rows.length === 0) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
        <Empty className="rounded-xl border border-dashed py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarOffIcon />
            </EmptyMedia>
            <EmptyTitle>
              <h1 className="text-base font-semibold">Term dates are not available right now</h1>
            </EmptyTitle>
            <EmptyDescription>
              The dates could not be read. Please try again in a few minutes.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const clock = termClock(now, rows)
  const years = byAcademicYear(rows)
  const year = currentYear(rows, now)
  // The term whose weeks are listed: the current one, else the next.
  const focusStart = clock.kind === "term" ? clock.fullTermStart : clock.next?.fullTermStart
  const focus = rows.find((row) => row.fullTermStart === focusStart)
  const sources = [...new Set(rows.map((row) => row.sourceUrl))]

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_18rem]">
      <div className="flex max-w-3xl min-w-0 flex-col gap-10">
        <header className="flex flex-col gap-3">
          <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
            Cambridge term dates
          </h1>
          <p className="text-lg text-muted-foreground">
            Full Term for Michaelmas, Lent and Easter
            {year ? ` ${academicYearLabel(year)}` : ""}, and which week of term it is, from the
            dates the University publishes.
          </p>
        </header>

        <section
          aria-labelledby="today-title"
          className="flex flex-col gap-1 rounded-xl border bg-card p-5"
        >
          <h2 id="today-title" className="text-sm font-semibold">
            What week is it?
          </h2>
          <p className="font-serif text-2xl leading-snug">
            {clock.kind === "term"
              ? `${TERM_NAMES[clock.term]} ${clock.fullTermStart.slice(0, 4)}, ${weekOfTerm(clock.week)}`
              : clock.next
                ? `Vacation: ${TERM_NAMES[clock.next.term]} Full Term starts ${startsIn(clock.next.inDays)}`
                : "Vacation"}
          </p>
          <p className="font-mono text-sm text-muted-foreground tabular-nums">
            Today is {formatDayWithYear(clock.date)}
            {clock.kind === "term"
              ? ` · Full Term ${formatDayShort(clock.fullTermStart)} – ${formatDayShort(clock.fullTermEnd)}`
              : clock.next
                ? ` · Full Term from ${formatDayWithYear(clock.next.fullTermStart)}`
                : ""}
          </p>
        </section>

        {years.map(({ academicYear, terms }) => (
          <section
            key={academicYear}
            id={`year-${academicYear}`}
            aria-labelledby={`year-${academicYear}-title`}
            className="flex scroll-mt-20 flex-col gap-3"
          >
            <h2
              id={`year-${academicYear}-title`}
              className="font-serif text-2xl font-normal tracking-[-0.01em]"
            >
              Term dates {academicYearLabel(academicYear)}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Full Term dates for {academicYearLabel(academicYear)}
                </caption>
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th scope="col" className={TH}>
                      Term
                    </th>
                    <th scope="col" className={TH}>
                      Full Term starts
                    </th>
                    <th scope="col" className={TH}>
                      Full Term ends
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {terms.map((term) => (
                    <tr key={term.term}>
                      <th scope="row" className={`${TD} text-left font-medium`}>
                        {TERM_NAMES[term.term]}
                      </th>
                      <td className={`${TD} font-mono tabular-nums`}>
                        {formatDayWithYear(term.fullTermStart)}
                      </td>
                      <td className={`${TD} font-mono tabular-nums`}>
                        {formatDayWithYear(term.fullTermEnd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        {focus && (
          <section aria-labelledby="weeks-title" className="flex flex-col gap-3">
            <h2 id="weeks-title" className="font-serif text-2xl font-normal tracking-[-0.01em]">
              Weeks of {termTitle(focus)}
            </h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  When each week of {termTitle(focus)} starts and ends
                </caption>
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th scope="col" className={TH}>
                      Week
                    </th>
                    <th scope="col" className={TH}>
                      From
                    </th>
                    <th scope="col" className={TH}>
                      To
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {termWeeks(focus).map(({ week, from, to }) => {
                    const current =
                      clock.kind === "term" &&
                      clock.fullTermStart === focus.fullTermStart &&
                      clock.week === week
                    return (
                      <tr key={week} className={current ? "bg-accent/60" : undefined}>
                        <th scope="row" className={`${TD} text-left font-medium`}>
                          Week {week}
                          {current && (
                            <span className="ml-2 text-xs text-brand-text">this week</span>
                          )}
                        </th>
                        <td className={`${TD} font-mono tabular-nums`}>{formatDayShort(from)}</td>
                        <td className={`${TD} font-mono tabular-nums`}>{formatDayShort(to)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <ProseSection id="weeks" title="How Cambridge numbers its weeks">
          <p>
            Full Term starts on a Tuesday. <strong>Week 1</strong> begins on the first Thursday of
            Full Term, and every week runs from Thursday to Wednesday. <strong>Week 0</strong> is
            the week before Week 1, when most students arrive. There are {TEACHING_WEEKS} teaching
            weeks; a Full Term that runs past Week 8, as Michaelmas and Lent normally do, ends in a
            short Week 9.
          </p>
          <p>
            Societies’ term cards and events on camsocs use the same numbering, so “Week 4” on an
            event is the week shown here.
          </p>
        </ProseSection>
      </div>

      <aside className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2 rounded-xl border p-5">
          <h2 className="font-semibold">Where these dates come from</h2>
          <p className="text-muted-foreground">
            Read from the University’s published term dates
            {sources.length > 0 && (
              <>
                {": "}
                {sources.map((url) => (
                  <ExternalLink key={url} href={url} className="text-foreground underline" />
                ))}
              </>
            )}
            . Check that page for anything that matters.
          </p>
          <p className="text-muted-foreground">{DISCLAIMER}</p>
        </div>
      </aside>
    </div>
  )
}
