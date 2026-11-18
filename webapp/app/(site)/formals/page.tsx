import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { ExternalLink } from "@/components/molecules/external-link"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { FormalsWeek } from "@/components/organisms/formals-week"
import { api } from "@/convex/_generated/api"
import { addDays, formatDate, londonIsoDate, londonMidnight } from "@/lib/calendar"
import {
  COLLEGE_INFO,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  FORMAL_ANCHOR,
  FORMAL_NIGHTS_CHECKED_ON,
} from "@/lib/colleges"
import { collectionJsonLd, collegeHubPath } from "@/lib/directory-hubs"
import { formalSlots, unpublishedNights } from "@/lib/formal-week"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"
import { loadTermClock } from "@/lib/term-dates"
import { TERM_NAMES, type TermClock, weekOfTerm } from "@/lib/term-week"

/**
 * Formals night by night (ENG-272): which of the 31 colleges hold formal hall
 * on which evening, how a student from another college gets in and what it
 * costs, from the nights in lib/data/colleges.json (re-checked against the
 * colleges', JCRs' and MCRs' own pages). Static: the week is the data file,
 * the term note and the societies' formals are cached public reads, and the
 * client organism only picks a day and filters (docs/webapp.md "Caching").
 */

const PATH = "/formals"
const TITLE = "Formals in Cambridge, night by night"
const DESCRIPTION = `Which Cambridge colleges hold formal hall on which night, for all ${COLLEGE_INFO.length} colleges: start time, how a visitor gets in and the published price.`
/** How far ahead the societies' formals are listed. */
const SOCIETY_DAYS = 28

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: PATH,
})

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
const SECTION_HEAD =
  "border-t-2 border-foreground pt-3 font-serif text-2xl font-medium tracking-tight"

/** Formals societies list in the next four weeks, or null when Convex cannot
 * be read. The window starts at London midnight, so the cache key holds for
 * the day. */
async function loadSocietyFormals() {
  const today = londonIsoDate(Date.now())
  try {
    const events = await publicQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, SOCIETY_DAYS)),
      eventTypes: ["formal"],
      includeTakingPart: false,
      university: "hide",
    })
    return events.filter((event) => !event.cancelled)
  } catch (error) {
    unstable_rethrow(error)
    console.error("events.list failed; /formals without societies' formals", error)
    return null
  }
}

/** Where we are in the year, said plainly: most formals run in Full Term only. */
function termNote(clock: TermClock | null): string {
  if (!clock) {
    return "Most colleges hold formal hall in Full Term only; nights marked “also out of term” run outside it too. Check the college’s page for the dates."
  }
  if (clock.kind === "term" && clock.date < clock.fullTermStart) {
    return `${TERM_NAMES[clock.term]} Full Term starts on ${formatDate(clock.fullTermStart)}. Most formals run in Full Term only, so the nights below start then, except those marked “also out of term”.`
  }
  if (clock.kind === "term") {
    return `It is ${TERM_NAMES[clock.term]} Full Term (${weekOfTerm(clock.week)}), so these are the nights running now. All but those marked “also out of term” stop when Full Term ends on ${formatDate(clock.fullTermEnd)}.`
  }
  const next = clock.next
    ? `start again when ${TERM_NAMES[clock.next.term]} Full Term begins on ${formatDate(clock.next.fullTermStart)}`
    : "start again next term"
  return `It is the vacation. Most colleges hold formal hall in Full Term only, so the nights below ${next}, except those marked “also out of term”. Check the college’s page for the dates.`
}

export default async function FormalsPage() {
  const [societyFormals, { clock }] = await Promise.all([loadSocietyFormals(), loadTermClock()])
  const slots = formalSlots(
    COLLEGE_INFO,
    (college) => `${collegeHubPath(college)}#${FORMAL_ANCHOR}`,
  )
  const unknown = unpublishedNights(COLLEGE_INFO)
  const checked = formatDate(FORMAL_NIGHTS_CHECKED_ON)
  const jsonLd = collectionJsonLd({
    path: PATH,
    title: TITLE,
    description: DESCRIPTION,
    items: COLLEGE_INFO.map((college) => ({ name: college.name, path: collegeHubPath(college) })),
    crumbs: [{ name: "Formals", path: PATH }],
  })

  return (
    <article>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            Formals
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            {TITLE}
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            Which of the {COLLEGE_INFO.length} colleges hold formal hall on which evening, when
            dinner starts, how a student from another college gets in, and the price the college
            publishes. Taken from the colleges’, JCRs’ and MCRs’ own pages, checked {checked}.
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">{termNote(clock)}</p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 py-8 sm:px-6 lg:py-10">
        <FormalsWeek slots={slots} unpublished={unknown.length} />

        {unknown.length > 0 && (
          <section aria-labelledby="unpublished-title" className="flex max-w-3xl flex-col gap-2">
            <h2 id="unpublished-title" className="font-serif text-xl font-medium tracking-tight">
              Nights not published
            </h2>
            <p className="text-sm text-muted-foreground">
              These colleges do not say on a public page which evenings their regular formals are,
              so they are missing from the days above (a night they do publish is listed).
            </p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {unknown.map(({ college, reason }) => (
                <li key={college.key}>
                  <Link href={`${collegeHubPath(college)}#${FORMAL_ANCHOR}`} className={LINK}>
                    {college.shortName}
                  </Link>
                  <span className="text-muted-foreground">: {reason}.</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="societies-title" className="flex flex-col gap-3">
          <h2 id="societies-title" className={SECTION_HEAD}>
            Formals listed by societies
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Swaps and society formals in the next four weeks, from the societies’ own listings on
            CAMsocs.
          </p>
          {societyFormals === null ? (
            <p className="text-sm text-muted-foreground">
              The societies’ formals cannot be shown just now. The{" "}
              <Link href="/events" prefetch={false} className={LINK}>
                events calendar
              </Link>{" "}
              lists them.
            </p>
          ) : (
            <UpcomingEventList
              events={societyFormals}
              limit={20}
              empty="No society has listed a formal in the next four weeks. Swaps are often announced only on JCR and MCR mailing lists, so ask your common room."
            />
          )}
        </section>

        <section aria-labelledby="more-title" className="flex flex-col gap-3">
          <h2 id="more-title" className="sr-only">
            More on formals
          </h2>
          <Link
            href="/formals/tracker"
            className="group flex flex-col gap-1 rounded-xl border p-6 transition-colors duration-200 hover:border-primary/20 hover:bg-muted/40"
          >
            <span className="inline-flex items-center gap-1.5 font-serif text-2xl font-medium tracking-tight">
              One formal at every college — track yours
              <ArrowRightIcon
                aria-hidden
                className="size-5 transition-transform group-hover:translate-x-0.5"
              />
            </span>
            <span className="text-muted-foreground">
              Tick off the {COLLEGE_INFO.length} colleges as you go, earn ranks and badges, and keep
              notes on each dinner.
            </span>
          </Link>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <li>
              <Link
                href="/guides/formal-hall"
                className={`inline-flex min-h-11 items-center ${LINK}`}
              >
                How formal hall works: hosts, swaps and gowns
              </Link>
            </li>
            <li>
              <Link href="/colleges" className={`inline-flex min-h-11 items-center ${LINK}`}>
                Every college’s formal hall rules
              </Link>
            </li>
            <li>
              <Link href="/colleges/wealth" className={`inline-flex min-h-11 items-center ${LINK}`}>
                The richest colleges, by endowment
              </Link>
            </li>
          </ul>
        </section>

        <footer className="flex max-w-3xl flex-col gap-2 text-sm text-muted-foreground">
          <p>
            CAMsocs is unofficial and cannot book you into a formal. The nights, times and prices
            are what each college, JCR or MCR publishes, checked {checked}; each college’s page here
            links its sources. A night can be cancelled, moved for a feast or full, and graduate
            formals are usually for that college’s MCR members and their guests.
          </p>
          <p>
            “Not confirmed” marks a night worked out from what a college says (such as “six nights a
            week” and “none on Saturdays”) or one that runs only some weeks, rather than listed as
            such. Each price shows the year its source gives; an undated one, or one for an earlier
            year, may be out of date. A graduate or other dinner shows its own price only when one
            is published. Members usually wear gowns; ask your host whether a guest needs one, and
            what to wear.
          </p>
          <p>
            <ExternalLink href={CREST_CREDIT_URL} className="underline">
              {CREST_CREDIT}
            </ExternalLink>
          </p>
          <p>{DISCLAIMER}</p>
        </footer>
      </div>
    </article>
  )
}
