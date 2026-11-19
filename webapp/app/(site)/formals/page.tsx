import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { ExternalLink } from "@/components/molecules/external-link"
import { FormalsTonight } from "@/components/molecules/formals-tonight"
import { UpcomingEventList } from "@/components/molecules/upcoming-event-list"
import { FormalsWeek } from "@/components/organisms/formals-week"
import { api } from "@/convex/_generated/api"
import { addDays, formatDate, londonIsoDate, londonMidnight } from "@/lib/calendar"
import {
  COLLEGE_INFO,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  FORMAL_NIGHTS_CHECKED_ON,
} from "@/lib/colleges"
import { collectionJsonLd } from "@/lib/directory-hubs"
import {
  busiestAndQuietest,
  collegesOn,
  dressMentions,
  listNames,
  nightCounts,
  type PriceRow,
  priceRange,
  priceRows,
  tonightCounts,
} from "@/lib/formal-facts"
import { FORMAL_TRACKER_PATH, FORMALS_PATH, formalCollegePath } from "@/lib/formal-paths"
import { dayId, formalSlots, londonWeekday, WEEK, WEEKDAY_NAMES } from "@/lib/formal-week"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { DISCLAIMER, SITE_NAME } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"
import { loadTermClock } from "@/lib/term-dates"
import { TERM_NAMES, type TermClock, weekOfTerm } from "@/lib/term-week"

/**
 * Formals night by night (ENG-272): which of the 31 colleges hold formal hall
 * on which evening, how a student from another college gets in and what it
 * costs, from the nights in lib/data/colleges.json (re-checked against the
 * colleges', JCRs' and MCRs' own pages, and student guides, menus and listings
 * where a college publishes no weekdays). Static: the week is the data file,
 * the term note and the societies' formals are cached public reads, and the
 * client organism only picks a day and filters (docs/webapp.md "Caching").
 */

const PATH = FORMALS_PATH
/** The `<title>`: the head term first, then what only this page answers
 * (formals SEO audit 2026-11-19, P0). The h1 says it in a sentence. */
const TITLE = "Cambridge formal hall: which college, which night"
const HEADING = "Formal hall in Cambridge, night by night"
const DESCRIPTION = `Cambridge formal hall at all ${COLLEGE_INFO.length} colleges, night by night: who dines tonight, start times, the cheapest published prices, weekend formals, swaps and gowns.`
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
const SECTION = "flex scroll-mt-20 flex-col gap-3"
const TH =
  "px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-muted-foreground uppercase"

/** The page's sections, for the jump nav under the h1. */
const JUMP = [
  ["#tonight", "Tonight"],
  ["#week", "The week"],
  ["#weekend", "Weekend formals"],
  ["#cheapest", "Cheapest"],
  ["#dress-code", "Dress code"],
  ["#visitors", "Visitors"],
  ["#swaps", "Swaps"],
  ["#faq", "Questions"],
] as const

/** Where a swap is described: a common room's own page, and the other
 * Cambridge use of the word (read 19 Nov 2026). */
const SWAP_SOURCE = {
  publisher: "Clare MCR",
  title: "College Swaps",
  url: "https://mcr.clare.cam.ac.uk/social/college-swaps",
}
const DRINKING_SWAP_SOURCE = {
  publisher: "Varsity",
  title: "Social Deconstruction: Cambridge Swaps (2017)",
  url: "https://varsity.co.uk/violet/12866",
}

const POUNDS = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
})

function pounds(value: number | null): string {
  return value === null ? "—" : POUNDS.format(value)
}

/** "Jesus’s £9.40 (by May 2023 …; 2023 figure)": a guest price with its year
 * and any qualifier, so a conditional figure never reads as a plain one. */
function cheapText({ college, price }: PriceRow): string {
  const terms = [price.asOf ?? "undated", price.caveat].filter(Boolean).join("; ")
  return `${college.shortName}’s ${pounds(price.guest)} (${terms})`
}

function colleges(count: number): string {
  return `${count} ${count === 1 ? "college" : "colleges"}`
}

/** Whether Full Term is on today: null when the term dates are unknown. */
function inFullTerm(clock: TermClock | null): boolean | null {
  if (!clock) return null
  return (
    clock.kind === "term" && clock.date >= clock.fullTermStart && clock.date <= clock.fullTermEnd
  )
}

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
  const slots = formalSlots(COLLEGE_INFO, (college) => formalCollegePath(college.slug))
  const checked = formatDate(FORMAL_NIGHTS_CHECKED_ON)
  const total = COLLEGE_INFO.length
  const counts = nightCounts(COLLEGE_INFO)
  const { busiest, quietest } = busiestAndQuietest(counts)
  const saturday = collegesOn(COLLEGE_INFO, "sat")
  const sunday = collegesOn(COLLEGE_INFO, "sun")
  const prices = priceRows(COLLEGE_INFO)
  const guestPrices = prices.filter((row) => !row.memberOnly)
  const guestRange = priceRange(prices, "guest")
  const memberRange = priceRange(prices, "student")
  const unpriced = total - prices.length
  const gowns = dressMentions(COLLEGE_INFO, /gown/i)
  const gownsOptional = dressMentions(COLLEGE_INFO, /gowns?[^;.]*\b(?:optional|not required)/i)
  const noCode = dressMentions(COLLEGE_INFO, /\bno (?:other )?dress code/i)
  const blackTie = dressMentions(COLLEGE_INFO, /black tie/i)
  const noDress = COLLEGE_INFO.filter((college) => !college.formal.dress)
  const asGuest = COLLEGE_INFO.filter((college) => college.formal.visitorRoute === "as_guest")
  const noRoute = COLLEGE_INFO.filter((college) => college.formal.visitorRoute !== "as_guest")
  const outOfTerm = COLLEGE_INFO.filter((college) =>
    college.formal.nights.some((night) => !night.termOnly),
  )
  const names = (list: readonly { shortName: string }[]) =>
    listNames(list.map((college) => college.shortName))
  const jsonLd = collectionJsonLd({
    path: PATH,
    title: TITLE,
    description: DESCRIPTION,
    items: COLLEGE_INFO.map((college) => ({
      name: `Formal hall at ${college.name}`,
      path: formalCollegePath(college.slug),
    })),
    crumbs: [
      { name: SITE_NAME, path: "/" },
      { name: "Formals", path: PATH },
    ],
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
            {HEADING}
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            Which of the {total} colleges hold formal hall on which evening, when dinner starts, how
            a student from another college gets in, and the price the college publishes. Taken from
            the colleges’, JCRs’ and MCRs’ own pages, and from student guides, menus and listings
            where a college gives no weekdays, checked {checked}.
          </p>
          <p className="max-w-3xl text-sm text-muted-foreground">{termNote(clock)}</p>
          <nav aria-label="On this page" className="pt-1">
            <ul className="flex flex-wrap gap-x-4 text-sm">
              {JUMP.map(([href, label]) => (
                <li key={href}>
                  <a href={href} className={`inline-flex min-h-11 items-center ${LINK}`}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 py-8 sm:px-6 lg:py-10">
        <section id="tonight" aria-labelledby="tonight-title" className={SECTION}>
          <h2 id="tonight-title" className={SECTION_HEAD}>
            Formal tonight
          </h2>
          <FormalsTonight
            counts={tonightCounts(COLLEGE_INFO)}
            serverDay={londonWeekday(Date.now())}
            inFullTerm={inFullTerm(clock)}
          />
          <p className="max-w-3xl text-sm text-muted-foreground">
            Across a week of term:{" "}
            {WEEK.map((day, index) => (
              <span key={day}>
                {index > 0 && " · "}
                <a href={`#${dayId(day)}`} className={LINK}>
                  {WEEKDAY_NAMES[day]}
                </a>{" "}
                {counts[day]}
              </span>
            ))}
            . {WEEKDAY_NAMES[busiest]} is the busiest night ({colleges(counts[busiest])}),{" "}
            {WEEKDAY_NAMES[quietest]} the quietest ({colleges(counts[quietest])}). The counts
            include graduate formals.
          </p>
        </section>

        <FormalsWeek slots={slots} serverDay={londonWeekday(Date.now())} />

        <section id="weekend" aria-labelledby="weekend-title" className={SECTION}>
          <h2 id="weekend-title" className={SECTION_HEAD}>
            Saturday and Sunday formals
          </h2>
          <p className="max-w-3xl text-pretty">
            {saturday.length === 0
              ? "No college publishes a formal on a Saturday."
              : `On a Saturday ${saturday.length === 1 ? "only 1 college holds" : `${saturday.length} colleges hold`} formal hall: ${names(saturday)}.`}{" "}
            {sunday.length === 0
              ? "No college publishes a formal on a Sunday."
              : `On a Sunday ${colleges(sunday.length)} do: ${names(sunday)}.`}{" "}
            Times, prices and how often each night runs are in the{" "}
            <a href="#saturday" className={LINK}>
              Saturday
            </a>{" "}
            and{" "}
            <a href="#sunday" className={LINK}>
              Sunday
            </a>{" "}
            lists above.
          </p>
        </section>

        <section id="cheapest" aria-labelledby="cheapest-title" className={SECTION}>
          <h2 id="cheapest-title" className={SECTION_HEAD}>
            Cheapest formals, by guest price
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The {prices.length} colleges that publish a price for their regular formal, cheapest
            published guest price first (a college with only a member’s price is placed by that).
            {unpriced > 0 &&
              ` The other ${colleges(unpriced)} publish none, so the cheapest published price is not always the cheapest formal.`}{" "}
            Each price shows the year its source gives; an undated one, or one for an earlier year,
            may be out of date.
          </p>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <caption className="sr-only">Published formal hall prices, cheapest first</caption>
              <thead className="border-b bg-muted/40">
                <tr>
                  <th scope="col" className={TH}>
                    College
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Guest
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Member
                  </th>
                  <th scope="col" className={TH}>
                    Price for
                  </th>
                  <th scope="col" className={TH}>
                    Source
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {prices.map(({ college, price }) => (
                  <tr key={college.key}>
                    <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                      <Link
                        href={formalCollegePath(college.slug)}
                        className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                      >
                        <CollegeCrest crest={college.crest} size={24} decorative />
                        {college.shortName}
                      </Link>
                      {price.caveat && (
                        <span className="block pt-0.5 text-xs font-normal text-muted-foreground">
                          {price.caveat}
                        </span>
                      )}
                    </th>
                    <td className="px-3 py-2.5 text-right align-top font-mono tabular-nums">
                      {pounds(price.guest)}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top font-mono tabular-nums">
                      {pounds(price.student)}
                    </td>
                    <td className="px-3 py-2.5 align-top text-muted-foreground">
                      {price.asOf ?? "undated"}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {price.sourceUrl ? (
                        <ExternalLink href={price.sourceUrl} className="underline">
                          Source
                        </ExternalLink>
                      ) : (
                        <Link href={formalCollegePath(college.slug)} className={LINK}>
                          Sources
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="dress-code" aria-labelledby="dress-code-title" className={SECTION}>
          <h2 id="dress-code-title" className={SECTION_HEAD}>
            What to wear: gowns and dress code
          </h2>
          <div className="flex max-w-3xl flex-col gap-2 text-pretty">
            <p>
              Each college sets its own dress code. Most that spell one out ask for smart or formal
              dress: a suit, or a jacket and tie, a dress or the equivalent.
              {noCode.length > 0 &&
                ` ${names(noCode)} publish no dress code apart from their gown rules.`}{" "}
              {gowns.length} of the {total} colleges’ published dress codes mention gowns, usually
              for their own members
              {gownsOptional.length > 0 &&
                `; ${names(gownsOptional)} make them optional or do not require them`}
              . Whether a guest from another college wears one differs, so ask your host.
              {blackTie.length > 0 &&
                ` Black tie is mentioned only by ${names(blackTie)}: see their rows below.`}
            </p>
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <caption className="sr-only">Formal hall dress codes and gowns, by college</caption>
              <thead className="border-b bg-muted/40">
                <tr>
                  <th scope="col" className={TH}>
                    College
                  </th>
                  <th scope="col" className={TH}>
                    Dress code and gowns, as published
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {COLLEGE_INFO.map((college) => (
                  <tr key={college.key}>
                    <th scope="row" className="px-3 py-2.5 text-left align-top font-medium">
                      <Link
                        href={formalCollegePath(college.slug)}
                        className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                      >
                        <CollegeCrest crest={college.crest} size={24} decorative />
                        {college.shortName}
                      </Link>
                    </th>
                    <td className="px-3 py-2.5 align-top text-muted-foreground">
                      {college.formal.dress ?? "Not published; ask your host."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {noDress.length > 0 && (
            <p className="text-sm text-muted-foreground">
              No current dress code is published for {names(noDress)}.
            </p>
          )}
        </section>

        <section id="visitors" aria-labelledby="visitors-title" className={SECTION}>
          <h2 id="visitors-title" className={SECTION_HEAD}>
            How to go to another college’s formal
          </h2>
          <div className="flex max-w-3xl flex-col gap-2 text-pretty">
            <p>
              At {asGuest.length} of the {total} colleges the published way in for a student from
              another college is as a member’s guest: a friend there books you in.
              {noRoute.length > 0 &&
                ` ${names(noRoute)} ${noRoute.length === 1 ? "publishes" : "publish"} no route for visitors.`}{" "}
              The other ways in are a swap through your JCR or MCR (below) and a formal a society
              organises. The{" "}
              <Link href="/guides/formal-hall#routes" className={LINK}>
                formal hall guide
              </Link>{" "}
              explains each, and what to check before you pay for a guest place.
            </p>
            <p className="text-sm text-muted-foreground">
              The “Visitors can go” filter on the week keeps only the colleges whose published route
              lets a guest in.
            </p>
          </div>
        </section>

        <section id="swaps" aria-labelledby="swaps-title" className={SECTION}>
          <h2 id="swaps-title" className={SECTION_HEAD}>
            Formal swaps
          </h2>
          <div className="flex max-w-3xl flex-col gap-2 text-pretty">
            <p>
              On a formal swap, members of one college’s common room go together to another
              college’s formal hall, usually as part of an exchange. The common room’s officer
              announces it and members book through their own JCR or MCR; Clare’s MCR, for example,
              books its swaps through the MCR’s events system (
              <ExternalLink href={SWAP_SOURCE.url} className="underline">
                {SWAP_SOURCE.publisher}, {SWAP_SOURCE.title}
              </ExternalLink>
              ).
            </p>
            <p>
              In Cambridge “swap” also means something else: two drinking or sports societies
              meeting for a meal in a restaurant (
              <ExternalLink href={DRINKING_SWAP_SOURCE.url} className="underline">
                {DRINKING_SWAP_SOURCE.publisher}, {DRINKING_SWAP_SOURCE.title}
              </ExternalLink>
              ). This page is about the formal hall kind. See the{" "}
              <Link href="/guides/formal-hall#swaps" className={LINK}>
                guide’s section on formal swaps
              </Link>
              .
            </p>
          </div>
        </section>

        <section aria-labelledby="societies-title" className="flex flex-col gap-3">
          <h2 id="societies-title" className={SECTION_HEAD}>
            Swaps and society formals coming up
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

        <section id="faq" aria-labelledby="faq-title" className={SECTION}>
          <h2 id="faq-title" className={SECTION_HEAD}>
            Questions about formals
          </h2>
          <div className="flex max-w-3xl flex-col gap-5 text-pretty">
            <Question q="Which Cambridge colleges have formal hall tonight?">
              It depends on the night. {WEEKDAY_NAMES[busiest]} is the busiest (
              {colleges(counts[busiest])}) and {WEEKDAY_NAMES[quietest]} the quietest (
              {colleges(counts[quietest])}).{" "}
              <a href="#tonight" className={LINK}>
                Tonight’s count
              </a>{" "}
              and{" "}
              <a href="#week" className={LINK}>
                the week
              </a>{" "}
              are above.
            </Question>
            <Question q="Which colleges have a formal on a Saturday?">
              {saturday.length > 0 ? `${names(saturday)}` : "None publishes one"}, from the nights
              checked {checked}. On a Sunday, {colleges(sunday.length)} do (
              <a href="#weekend" className={LINK}>
                weekend formals
              </a>
              ).
            </Question>
            {guestPrices.length > 0 && (
              <Question q="What is the cheapest formal in Cambridge?">
                The lowest published guest price is {cheapText(guestPrices[0])}
                {guestPrices[1] && `, then ${cheapText(guestPrices[1])}`}.
                {unpriced > 0 && ` ${colleges(unpriced)} publish no price.`} See{" "}
                <a href="#cheapest" className={LINK}>
                  every published price
                </a>
                .
              </Question>
            )}
            {guestRange && (
              <Question q="How much does formal hall cost?">
                Published guest prices run from {pounds(guestRange.min)} to {pounds(guestRange.max)}
                {memberRange &&
                  `; a college’s own students pay ${pounds(memberRange.min)} to ${pounds(memberRange.max)}`}
                . The year of each price is in the{" "}
                <a href="#cheapest" className={LINK}>
                  price table
                </a>
                .
              </Question>
            )}
            <Question q="Can you go to a formal at another college?">
              Yes, usually as a member’s guest (the published route at {asGuest.length} of the{" "}
              {total} colleges), on a JCR or MCR swap, or at a formal a society organises. See{" "}
              <a href="#visitors" className={LINK}>
                how visitors get in
              </a>
              .
            </Question>
            <Question q="What is a formal swap?">
              Members of one college’s common room going together to another college’s formal,
              booked through their own JCR or MCR. See{" "}
              <a href="#swaps" className={LINK}>
                formal swaps
              </a>
              .
            </Question>
            <Question q="What do you wear to a Cambridge formal? Is it black tie?">
              Usually smart or formal dress, as each college sets it: a suit, or a jacket and tie, a
              dress or the equivalent.{" "}
              {blackTie.length > 0
                ? `Of the published dress codes, only ${names(blackTie)} mention black tie.`
                : "No published dress code asks for black tie."}{" "}
              <a href="#dress-code" className={LINK}>
                Every college’s dress code
              </a>
              .
            </Question>
            <Question q="Do you need a gown?">
              {gowns.length} of the {total} colleges’ published dress codes mention gowns, mostly
              for their own members
              {gownsOptional.length > 0 &&
                `; at ${names(gownsOptional)} they are optional or not required`}
              . Whether a guest wears one differs by college: ask your host.
            </Question>
            <Question q="Do formals run outside term?">
              Most nights run in Full Term only. {colleges(outOfTerm.length)} have a night that also
              runs outside it, marked “also out of term” in the week above.
            </Question>
          </div>
        </section>

        <section aria-labelledby="more-title" className="flex flex-col gap-3">
          <h2 id="more-title" className="sr-only">
            More on formals
          </h2>
          <Link
            href={FORMAL_TRACKER_PATH}
            className="group flex flex-col gap-1 rounded-xl border p-6 transition-colors duration-200 hover:border-primary/20 hover:bg-muted/40"
          >
            <span className="inline-flex items-center gap-1.5 font-serif text-2xl font-medium tracking-tight">
              The every-college formal challenge — track yours
              <ArrowRightIcon
                aria-hidden
                className="size-5 transition-transform group-hover:translate-x-0.5"
              />
            </span>
            <span className="text-muted-foreground">
              Tick off the {total} colleges as you go, earn ranks and badges, and keep notes on each
              dinner.
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
            come from each college, JCR or MCR and from student guides, menus and listings, checked{" "}
            {checked}; each college’s page here links its sources. A night can be cancelled, moved
            for a feast or full, and graduate formals are usually for that college’s MCR members and
            their guests.
          </p>
          <p>
            A night that does not run every week says how often it does: every other week, the first
            of its weekday in the month, or some weeks, when a Super Hall or themed dinner takes its
            place. Each price shows the year its source gives; an undated one, or one for an earlier
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

/** One question and its answer, as plain text (no FAQPage markup: Google
 * shows FAQ results only for government and health sites, lib/guides.ts). */
function Question({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">{q}</h3>
      <p className="text-muted-foreground">{children}</p>
    </div>
  )
}
