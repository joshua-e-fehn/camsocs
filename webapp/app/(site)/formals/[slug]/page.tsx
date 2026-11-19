import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { ExternalLink } from "@/components/molecules/external-link"
import { RichText } from "@/components/molecules/rich-text"
import { formatDate } from "@/lib/calendar"
import {
  COLLEGE_INFO,
  type CollegeInfo,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  type FormalAudience,
  type FormalNight,
  type FormalPrice,
} from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import {
  formalCollegeBySlug,
  formalCollegeDescription,
  formalCollegeHeading,
  formalCollegeTitle,
  formalDays,
  formalSourceUrls,
  nightsSummary,
} from "@/lib/formal-college-page"
import { collegesOn } from "@/lib/formal-facts"
import { FORMAL_TRACKER_PATH, FORMALS_PATH, formalCollegePath } from "@/lib/formal-paths"
import { dayId, frequencyLabel, priceLabel, WEEK, WEEKDAY_NAMES } from "@/lib/formal-week"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER, SITE_NAME } from "@/lib/site"
import {
  breadcrumbList,
  jsonLdScript,
  organizationId,
  pageId,
  WEBSITE_ID,
} from "@/lib/structured-data"

/**
 * One college's formal hall, `/formals/<slug>` (formals SEO audit
 * 2026-11-19, content plan P1 option a): its nights with how often they run
 * and when dinner starts, the published price with its year and source,
 * booking and the deadline, dress code and gowns, how a visitor gets in, the
 * other colleges dining the same nights, and every source. Static data only
 * (lib/data/colleges.json): no Convex read, so every build, a placeholder
 * one included, prerenders all 31.
 */

type Props = { params: Promise<{ slug: string }> }

/** The 31 colleges, built with the site (a fixed list, like the category
 * hubs); any other slug is an unmatched URL with the static 404. */
export function generateStaticParams(): { slug: string }[] {
  return COLLEGE_INFO.map((college) => ({ slug: college.slug }))
}

export const dynamicParams = false

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const college = formalCollegeBySlug((await params).slug)
  if (!college) notFound()
  return pageMetadata({
    title: formalCollegeTitle(college),
    description: formalCollegeDescription(college),
    path: formalCollegePath(college.slug),
  })
}

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
const SECTION_HEAD =
  "border-t-2 border-foreground pt-3 font-serif text-2xl font-medium tracking-tight"
const SECTION = "flex scroll-mt-20 flex-col gap-3"
const FACTS = "grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]"

const AUDIENCE: Readonly<Record<FormalAudience, string>> = {
  all_members: "Every member",
  jcr: "Undergraduates (JCR)",
  mcr: "Graduates (MCR)",
}

const JUMP = [
  ["#nights", "Nights"],
  ["#price", "Price"],
  ["#booking", "Booking"],
  ["#dress-code", "Dress code"],
  ["#visitors", "Visitors"],
  ["#same-night", "Same night"],
  ["#sources", "Sources"],
] as const

function byWeek(a: FormalNight, b: FormalNight): number {
  return WEEK.indexOf(a.weekday) - WEEK.indexOf(b.weekday)
}

function jsonLd(college: CollegeInfo, title: string, description: string) {
  const path = formalCollegePath(college.slug)
  const id = pageId(path)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": id,
        url: id,
        name: title,
        description,
        inLanguage: "en-GB",
        dateModified: college.formal.nightsCheckedOn,
        isPartOf: { "@id": WEBSITE_ID },
        breadcrumb: { "@id": `${id}#breadcrumb` },
        // The college's own Organization node, on its hub page.
        about: { "@id": organizationId(college.slug), name: college.name },
      },
      breadcrumbList(path, [
        { name: SITE_NAME, path: "/" },
        { name: "Formals", path: FORMALS_PATH },
        { name: college.name, path },
      ]),
    ],
  }
}

export default async function FormalCollegePage({ params }: Props) {
  const college = formalCollegeBySlug((await params).slug)
  if (!college) notFound()
  const { formal } = college
  const title = formalCollegeTitle(college)
  const description = formalCollegeDescription(college)
  const nights = [...formal.nights].sort(byWeek)
  const priced = nights.filter((night) => night.price)
  const days = formalDays(college)
  const hub = collegeHubPath(college)
  const sources = formalSourceUrls(college)

  return (
    <article>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd(college, title, description)) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <nav aria-label="Breadcrumb">
            <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
              <Link href={FORMALS_PATH} className={LINK}>
                Formals
              </Link>{" "}
              · {college.shortName}
            </p>
          </nav>
          <div className="flex items-center gap-4">
            <CollegeCrest crest={college.crest} size={64} decorative />
            <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
              {formalCollegeHeading(college)}
            </h1>
          </div>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            {nightsSummary(college)}. {formal.visitors}
          </p>
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

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-4 py-8 sm:px-6 lg:py-10">
        <section id="nights" aria-labelledby="nights-title" className={SECTION}>
          <h2 id="nights-title" className={SECTION_HEAD}>
            Formal nights at {college.shortName}
          </h2>
          <ul className="divide-y rounded-xl border">
            {nights.map((night) => (
              <li key={`${night.weekday}-${night.label}`} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span className="font-medium">
                    <a href={`${FORMALS_PATH}#${dayId(night.weekday)}`} className={LINK}>
                      {WEEKDAY_NAMES[night.weekday]}
                    </a>
                    {" · "}
                    {night.label}
                  </span>
                  <span className="font-mono text-sm tabular-nums">
                    {night.startTime ?? (
                      <span className="text-muted-foreground">time not published</span>
                    )}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {AUDIENCE[night.audience]} · {frequencyLabel(night) ?? "every week"} ·{" "}
                  {night.termOnly ? "in Full Term" : "also out of term"}
                </p>
                {night.notes && <p className="text-sm">{night.notes}</p>}
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">The nights rest on: {formal.nightsQuote}</p>
        </section>

        <section id="price" aria-labelledby="price-title" className={SECTION}>
          <h2 id="price-title" className={SECTION_HEAD}>
            How much a formal at {college.shortName} costs
          </h2>
          {formal.priceGbp ? (
            <PriceFacts price={formal.priceGbp} />
          ) : (
            <p>No price is published for {college.shortName}’s formal; ask your host.</p>
          )}
          {priced.map((night) => (
            <div key={`${night.weekday}-${night.label}`} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">
                {night.label} ({WEEKDAY_NAMES[night.weekday]})
              </h3>
              {night.price && <PriceFacts price={night.price} />}
            </div>
          ))}
          {formal.price && <p className="text-sm text-muted-foreground">{formal.price}</p>}
          <p className="text-sm">
            <Link href={`${FORMALS_PATH}#cheapest`} className={LINK}>
              Every college’s published price, cheapest first
            </Link>
          </p>
        </section>

        <section id="booking" aria-labelledby="booking-title" className={SECTION}>
          <h2 id="booking-title" className={SECTION_HEAD}>
            Booking and deadline
          </h2>
          <dl className={FACTS}>
            <Fact label="How to book">{formal.bookingSummary}</Fact>
            {formal.booking && <Fact label="Booking">{formal.booking}</Fact>}
            <Fact label="Deadline">{formal.bookingDeadline ?? "Not published."}</Fact>
            <Fact label="Guests">{formal.guestNote}</Fact>
            {formal.guests && <Fact label="Guest rules">{formal.guests}</Fact>}
            <Fact label="Main rule">{formal.rulesSummary}</Fact>
          </dl>
          {formal.nightsGaps.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Not published:{" "}
              {formal.nightsGaps
                .map((gap) => gap.replace(/\s+not (?:public|published)\.?$/i, ""))
                .join("; ")}
              .
            </p>
          )}
        </section>

        <section id="dress-code" aria-labelledby="dress-title" className={SECTION}>
          <h2 id="dress-title" className={SECTION_HEAD}>
            Dress code and gowns
          </h2>
          <p className="text-pretty">
            {formal.dress ?? `${college.shortName} publishes no current dress code; ask your host.`}
          </p>
          <p className="text-sm">
            <Link href={`${FORMALS_PATH}#dress-code`} className={LINK}>
              Every college’s dress code
            </Link>
            {" · "}
            <Link href="/guides/formal-hall" className={LINK}>
              What to wear to a formal
            </Link>
          </p>
        </section>

        <section id="visitors" aria-labelledby="visitors-title" className={SECTION}>
          <h2 id="visitors-title" className={SECTION_HEAD}>
            Getting in as a visitor
          </h2>
          <p className="text-pretty">{formal.visitors}</p>
          <RichText text={formal.note} className="text-sm leading-relaxed text-muted-foreground" />
          <p className="text-sm">
            <Link href={`${FORMALS_PATH}#visitors`} className={LINK}>
              How to go to another college’s formal
            </Link>
            {" · "}
            <Link href={`${FORMALS_PATH}#swaps`} className={LINK}>
              Formal swaps
            </Link>
          </p>
        </section>

        <section id="same-night" aria-labelledby="same-night-title" className={SECTION}>
          <h2 id="same-night-title" className={SECTION_HEAD}>
            Other colleges the same night
          </h2>
          <dl className={FACTS}>
            {days.map((day) => {
              const others = collegesOn(COLLEGE_INFO, day).filter(
                (other) => other.key !== college.key,
              )
              return (
                <div key={day} className="contents">
                  <dt>
                    <a href={`${FORMALS_PATH}#${dayId(day)}`} className={`font-medium ${LINK}`}>
                      {WEEKDAY_NAMES[day]}
                    </a>
                  </dt>
                  <dd className="min-w-0">
                    {others.length === 0 ? (
                      <span className="text-muted-foreground">
                        No other college publishes a formal that night.
                      </span>
                    ) : (
                      others.map((other, index) => (
                        <span key={other.key}>
                          {index > 0 && ", "}
                          <Link href={formalCollegePath(other.slug)} className={LINK}>
                            {other.shortName}
                          </Link>
                        </span>
                      ))
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        </section>

        <section aria-labelledby="more-title" className="flex flex-col gap-3">
          <h2 id="more-title" className="sr-only">
            More on {college.shortName}
          </h2>
          <Link
            href={FORMAL_TRACKER_PATH}
            className="group flex flex-col gap-1 rounded-xl border p-6 transition-colors duration-200 hover:border-primary/20 hover:bg-muted/40"
          >
            <span className="inline-flex items-center gap-1.5 font-serif text-2xl font-medium tracking-tight">
              Tick {college.shortName} off
              <ArrowRightIcon
                aria-hidden
                className="size-5 transition-transform group-hover:translate-x-0.5"
              />
            </span>
            <span className="text-muted-foreground">
              The every-college formal challenge: track your formals at all {COLLEGE_INFO.length}{" "}
              colleges.
            </span>
          </Link>
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <li>
              <Link href={hub} className={`inline-flex min-h-11 items-center ${LINK}`}>
                {college.name}: its societies and clubs
              </Link>
            </li>
            <li>
              <Link href={FORMALS_PATH} className={`inline-flex min-h-11 items-center ${LINK}`}>
                Formals at every college, night by night
              </Link>
            </li>
          </ul>
        </section>

        <section id="sources" aria-labelledby="sources-title" className={SECTION}>
          <h2 id="sources-title" className={SECTION_HEAD}>
            Sources
          </h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {formal.nightsSources.map((source) => (
              <li key={source.url}>
                <ExternalLink href={source.url} className="underline">
                  {source.publisher}
                </ExternalLink>{" "}
                <span className="text-muted-foreground">({source.date})</span>
              </li>
            ))}
            {sources.map((url) => (
              <li key={url} className="break-words">
                <ExternalLink href={url} className="underline">
                  {url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                </ExternalLink>
              </li>
            ))}
          </ul>
          <p className="font-mono text-xs text-muted-foreground">
            Nights, visitor route and price checked {formatDate(formal.nightsCheckedOn)}; rules
            checked {formatDate(formal.checkedOn)}. The{" "}
            <ExternalLink href={formal.primarySourceUrl} className="underline">
              college’s own page
            </ExternalLink>{" "}
            is the authority; rules change between terms.
          </p>
        </section>

        <footer className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            CAMsocs cannot book you into a formal. A night can be cancelled, moved for a feast or
            full.
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** A published price: the figures with the year its source gives
 * (`priceLabel`), any qualifier, the source's note and a link to it. */
function PriceFacts({ price }: { price: FormalPrice }) {
  const label = priceLabel(price)
  return (
    <div className="flex flex-col gap-1">
      {label && <p className="font-mono tabular-nums">{label}</p>}
      {price.caveat && <p className="text-sm">{price.caveat}</p>}
      {price.note && <p className="text-sm text-muted-foreground">{price.note}</p>}
      {price.sourceUrl && (
        <p className="text-xs text-muted-foreground">
          <ExternalLink href={price.sourceUrl} className="underline">
            Price source
          </ExternalLink>
        </p>
      )}
    </div>
  )
}
