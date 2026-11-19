import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ExternalLink } from "@/components/molecules/external-link"
import { FormalTracker } from "@/components/organisms/formal-tracker"
import {
  COLLEGE_INFO,
  COLLEGES_PATH,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  collegeRefs,
} from "@/lib/colleges"
import { hardestToTickOff } from "@/lib/formal-facts"
import { FORMAL_TRACKER_PATH, FORMALS_PATH, formalCollegePath } from "@/lib/formal-paths"
import { FORMAL_BADGES, FORMAL_RANKS } from "@/lib/formal-ranks"
import { frequencyLabel, isGraduateNight, WEEK, WEEKDAY_NAMES } from "@/lib/formal-week"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER, SITE_NAME } from "@/lib/site"
import { breadcrumbList, jsonLdScript, pageId, WEBSITE_ID } from "@/lib/structured-data"

/**
 * The formal tracker (ENG-272): the "one formal at every college" challenge,
 * ported from the Cambridge Tracker. This page is a static, anonymous shell
 * (no headers, cookies or token, docs/webapp.md "Caching"): the explanation,
 * ranks and badges are in its HTML for readers and crawlers, and the
 * member's own tracker (`FormalTracker`) is drawn in the browser once the
 * session reaches the Convex client.
 */

const PATH = FORMAL_TRACKER_PATH
/** The `<title>` names the challenge people search for; the h1 says it as
 * a name (formals SEO audit 2026-11-19, P0). */
const TITLE = `Cambridge formal challenge: eat at all ${COLLEGE_INFO.length} colleges`
const HEADING = "The every-college formal challenge"
const DESCRIPTION = `Eat formal hall at all ${COLLEGE_INFO.length} Cambridge colleges: tick each one off, earn ranks and badges, keep notes, and plan the next by night and price.`

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: PATH,
})

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
const SECTION_HEAD =
  "border-t-2 border-foreground pt-3 font-serif text-2xl font-medium tracking-tight"

/** The page's graph: the WebPage, the tracker as a free web application,
 * and its breadcrumbs (CAMsocs › Formals › Formal tracker). */
function trackerJsonLd(): Record<string, unknown> {
  const id = pageId(PATH)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": id,
        url: id,
        name: TITLE,
        description: DESCRIPTION,
        isPartOf: { "@id": WEBSITE_ID },
        breadcrumb: { "@id": `${id}#breadcrumb` },
        mainEntity: { "@id": `${id}#app` },
      },
      {
        "@type": "WebApplication",
        "@id": `${id}#app`,
        name: "Formal tracker",
        url: id,
        description: DESCRIPTION,
        applicationCategory: "LifestyleApplication",
        operatingSystem: "Any",
        browserRequirements: "Requires JavaScript",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: 0, priceCurrency: "GBP" },
        isPartOf: { "@id": WEBSITE_ID },
      },
      breadcrumbList(PATH, [
        { name: SITE_NAME, path: "/" },
        { name: "Formals", path: FORMALS_PATH },
        { name: "Formal tracker", path: PATH },
      ]),
    ],
  }
}

/** "Thursday", "Tuesday, Friday (first Friday of the month)": a college's
 * regular (not graduate-only) nights, in week order. */
function regularNights(college: (typeof COLLEGE_INFO)[number]): string {
  const nights = college.formal.nights
    .filter((night) => !isGraduateNight(night))
    .sort((a, b) => WEEK.indexOf(a.weekday) - WEEK.indexOf(b.weekday))
    .map((night) => {
      const often = frequencyLabel(night)
      return often ? `${WEEKDAY_NAMES[night.weekday]} (${often})` : WEEKDAY_NAMES[night.weekday]
    })
  return nights.length > 0 ? nights.join(", ") : "graduate formals only"
}

export default function FormalTrackerPage() {
  const total = COLLEGE_INFO.length
  const hardest = hardestToTickOff(COLLEGE_INFO)
  return (
    <article>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(trackerJsonLd()) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            <Link href={FORMALS_PATH} className={LINK}>
              Formals
            </Link>{" "}
            · Formal tracker
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            {HEADING}
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            There are {total} colleges, and each has a formal hall. Some students try to eat at
            every one before they leave. Tick them off here as you go, collect a rank and a few
            badges on the way, and keep a note of each night.
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-14 px-4 py-8 sm:px-6 lg:py-10">
        <FormalTracker colleges={collegeRefs()} />

        <section aria-labelledby="how" className="grid gap-8 lg:grid-cols-[2fr_3fr]">
          <div className="flex flex-col gap-3">
            <h2 id="how" className={SECTION_HEAD}>
              How it works
            </h2>
            <p className="text-pretty">
              Sign in with your @cam.ac.uk address and press a college’s crest once you have had a
              formal there. Add the date, how many times you have been and a few words to remember
              it by. Most formals need a member of that college to sign you in, or a swap through a
              common room or society:{" "}
              <Link href="/formals" className={LINK}>
                see which colleges dine on which night
              </Link>{" "}
              and{" "}
              <Link href="/guides/formal-hall" className={LINK}>
                how visitors get in
              </Link>
              .
            </p>
            <p className="text-sm text-muted-foreground">
              Your tracker is private to your account. The leaderboard is off unless you switch it
              on; it shows only the name you choose for it, your college if you give one, and your
              counts, and only signed-in Cambridge members can see it. “Erase my tracker” deletes
              everything at once.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Ranks</h3>
              <ol className="flex flex-col">
                {FORMAL_RANKS.map((rank) => (
                  <li
                    key={rank.title}
                    className="flex items-baseline justify-between gap-4 border-t py-2"
                  >
                    <span>{rank.title}</span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {rank.min === 1 ? "1 college" : `${rank.min} colleges`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Badges</h3>
              <ul className="flex flex-col">
                {FORMAL_BADGES.map((badge) => (
                  <li key={badge.id} className="flex flex-col gap-0.5 border-t py-2">
                    <span>{badge.title}</span>
                    <span className="text-sm text-muted-foreground">{badge.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="challenge" className="flex max-w-3xl flex-col gap-3">
          <h2 id="challenge" className={SECTION_HEAD}>
            What is the every-college formal challenge?
          </h2>
          <p className="text-pretty">
            Eating formal hall at all {total} colleges before you graduate. Every college holds its
            own formal on its own nights, with its own hall, gowns and rules, so getting round them
            all takes friends at other colleges, swaps and some planning. On this tracker a college
            counts once you have had a formal there, however you got in: as a member’s guest, on a
            swap or at a society formal.
          </p>
        </section>

        <section aria-labelledby="all" className="flex max-w-3xl flex-col gap-3">
          <h2 id="all" className={SECTION_HEAD}>
            How to get to all {total}
          </h2>
          <p className="text-pretty">
            Start with the colleges that dine least often, and use the busy nights for the rest. The{" "}
            <Link href={FORMALS_PATH} className={LINK}>
              week of formals
            </Link>{" "}
            shows who dines which night, including the{" "}
            <Link href={`${FORMALS_PATH}#weekend`} className={LINK}>
              Saturday and Sunday formals
            </Link>
            ; the{" "}
            <Link href={`${FORMALS_PATH}#cheapest`} className={LINK}>
              cheapest published prices
            </Link>{" "}
            and{" "}
            <Link href={`${FORMALS_PATH}#visitors`} className={LINK}>
              how visitors get in
            </Link>{" "}
            are on the same page.
          </p>
          {hardest.length > 0 && (
            <>
              <h3 className="pt-2 font-semibold">Hardest to tick off</h3>
              <p className="text-sm text-muted-foreground">
                The colleges with at most one regular formal a week in term, or no published way in
                for a visitor, fewest nights first.
              </p>
              <ul className="flex flex-col">
                {hardest.map((college) => (
                  <li
                    key={college.key}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 border-t py-2"
                  >
                    <Link href={formalCollegePath(college.slug)} className={LINK}>
                      {college.shortName}
                    </Link>
                    <span className="text-sm text-muted-foreground">
                      {regularNights(college)}
                      {college.formal.visitorRoute !== "as_guest" &&
                        " · no published visitor route"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="questions" className="flex max-w-3xl flex-col gap-4">
          <h2 id="questions" className={SECTION_HEAD}>
            Questions
          </h2>
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">How many colleges are there?</h3>
            <p className="text-muted-foreground">
              {total}, and each one holds formal hall, so the challenge is {total} formals.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">Do I need to be a Cambridge student?</h3>
            <p className="text-muted-foreground">
              To keep a tracker, yes: you sign in with an @cam.ac.uk address. The ranks, badges and
              this page are open to anyone.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">Does the leaderboard show my name?</h3>
            <p className="text-muted-foreground">
              Only if you switch it on, and then only the name you choose for it, your college if
              you give one, and your counts. Only signed-in Cambridge members can see it.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">Can I add a formal I had last year?</h3>
            <p className="text-muted-foreground">
              Yes. Tick the college and give the date under “Details”: any past date will do.
            </p>
          </div>
        </section>

        <footer className="flex max-w-3xl flex-col gap-2 text-sm text-muted-foreground">
          <Link
            href={COLLEGES_PATH}
            className="inline-flex min-h-11 items-center gap-1 self-start font-medium text-foreground underline underline-offset-4 sm:min-h-0"
          >
            All {COLLEGE_INFO.length} colleges and their formal hall rules
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
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
