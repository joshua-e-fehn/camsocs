import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { CollegeWealthStat } from "@/components/molecules/college-wealth-stat"
import { ExternalLink } from "@/components/molecules/external-link"
import { CollegeWealthTable } from "@/components/organisms/college-wealth-table"
import { CollegeWealthTrend } from "@/components/organisms/college-wealth-trend"
import { formatDate } from "@/lib/calendar"
import {
  COLLEGE_WEALTH,
  changePct,
  formatGbp,
  formatPct,
  INCOME_FROM_ANNUAL_RETURN,
  listNames,
  ordinal,
  perStudent,
  rankedBy,
  SHORT_TERM_HOLDERS,
  WEALTH_CAVEATS,
  WEALTH_QUOTED,
  WEALTH_REGISTER_CHECK,
  WEALTH_SOURCES,
  WEALTH_STUDENTS_SOURCE_URL,
  WEALTH_TOTAL_NOTE,
  wealthTable,
} from "@/lib/college-wealth"
import {
  biggestRisers,
  endowmentRank,
  type FaqPart,
  freshnessText,
  netAssetsMover,
  nextYearText,
  possessive,
  registerCheckText,
  richestMultiple,
  sharePct,
  studentsLater,
  studentsYearText,
  WEALTH_CRUMB,
  WEALTH_H1,
  type WealthView,
  wealthFaqs,
  wealthLede,
  wealthLedePoorest,
  yearEndText,
} from "@/lib/college-wealth-view"
import { COLLEGES_PATH, CREST_CREDIT, CREST_CREDIT_URL } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"
import { WEALTH_CSV_PATH, wealthJsonLd } from "./wealth-json-ld"

/**
 * /colleges/wealth's content (page.tsx loads the view and renders this).
 * Every sentence comes from lib/college-wealth-view.ts, so the lede, the
 * lists, the FAQ and the JSON-LD all move with the year the view shows.
 */

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
const H2 = "font-serif text-2xl font-medium tracking-tight sm:text-3xl"

const studentsSource = WEALTH_SOURCES.find((source) => source.url === WEALTH_STUDENTS_SOURCE_URL)
const register = WEALTH_SOURCES.find((source) => source.id === "charity-commission-register")
const withNotes = [...COLLEGE_WEALTH]
  .filter((row) => row.notes.trim() !== "")
  .sort((a, b) => a.name.localeCompare(b.name))
const shortTermNames = listNames(SHORT_TERM_HOLDERS.map((row) => row.college.shortName))
const trinityVerified = COLLEGE_WEALTH.find(
  (row) => row.slug === WEALTH_QUOTED.trinityProperty.slug,
)

/** The page's article for one view: the page renders it with Convex's, a
 * test with the verified view or a synthetic register year. */
export function CollegeWealthArticle({ view }: { view: WealthView }) {
  const { total, richest, median } = view.totals
  const count = view.rows.length
  const year = view.financialYear
  const runnerUp = view.byEndowment[1]
  const table = wealthTable(view.rows, collegeHubPath)
  const top = view.byEndowment.slice(0, 10)
  const bottom = view.byEndowment.slice(-5).reverse()
  const byStudent = rankedBy(view.rows, "perStudent")
  const byNetAssets = rankedBy(view.rows, "netAssets")
  const mover = netAssetsMover(view)
  const risers = biggestRisers(view)
  const faqs = wealthFaqs(view)
  const nextLine = nextYearText(view)
  const trinityShown = view.rows.find((row) => row.slug === WEALTH_QUOTED.trinityProperty.slug)

  return (
    <article>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(wealthJsonLd(view)) }}
      />
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-x-2">
              <li className="flex items-center gap-2">
                <Link
                  href={COLLEGES_PATH}
                  className="hover:text-foreground max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                >
                  Colleges
                </Link>
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden>/</span>
                <span aria-current="page">{WEALTH_CRUMB}</span>
              </li>
            </ol>
          </nav>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            {WEALTH_H1}
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            {wealthLede(view)} {wealthLedePoorest(view)}
          </p>
          <p className="max-w-3xl leading-relaxed text-pretty text-muted-foreground">
            The endowment here is the investments on each college’s balance sheet at market value at
            the end of the {year} financial year ({yearEndText(view)}),{" "}
            {view.basis === "verified"
              ? "read from the accounts it filed with the Charity Commission"
              : "as filed in its annual return on the Charity Commission register"}
            . Net assets, also in the table, is the broader measure of what a college owns.
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            <time dateTime={view.updatedOn}>{freshnessText(view)}</time>
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 py-8 sm:px-6 lg:py-10">
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <CollegeWealthStat
            label="All colleges together"
            value={formatGbp(total)}
            note={`The ${count} endowments added up (year ends differ by a month).`}
          />
          <CollegeWealthStat
            label="The richest"
            value={formatGbp(richest.endowmentGbp)}
            note={`${richest.college.shortName}; next is ${runnerUp.college.shortName} at ${formatGbp(runnerUp.endowmentGbp)}.`}
          />
          <CollegeWealthStat
            label="The middle college"
            value={formatGbp(median.endowmentGbp)}
            note={`${median.college.shortName}, ${ordinal(endowmentRank(view, median.slug))} of ${count}: half hold more, half less.`}
          />
          <CollegeWealthStat
            label={`${possessive(richest.college.shortName)} share`}
            value={sharePct(view)}
            note={`Of all ${count} colleges’ endowments together.`}
          />
        </dl>

        <section aria-labelledby="richest" className="flex flex-col gap-4">
          <h2 id="richest" className={H2}>
            The richest Cambridge colleges
          </h2>
          <p className="max-w-3xl text-muted-foreground">
            The ten largest endowments at the end of {year}. {richest.college.shortName} alone holds
            about {richestMultiple(view)} times as much as {runnerUp.college.shortName}, the next.
          </p>
          <ol className="grid max-w-3xl gap-x-8 gap-y-1 sm:grid-cols-2">
            {top.map((row, index) => (
              <RankItem
                key={row.slug}
                rank={index + 1}
                row={row}
                value={formatGbp(row.endowmentGbp)}
              />
            ))}
          </ol>
        </section>

        <section aria-labelledby="ranking" className="flex flex-col gap-4">
          <h2 id="ranking" className={H2}>
            All {count} colleges ranked
          </h2>
          <p className="max-w-3xl text-muted-foreground">
            Sort by endowment, endowment per student, total income, net assets or the change in
            endowment over the year. Each row links{" "}
            {view.basis === "verified"
              ? "the accounts and the page its endowment was read from"
              : "the college’s record on the Charity Commission register"}
            . The same figures are{" "}
            <a href={WEALTH_CSV_PATH} className={LINK}>
              available as a CSV
            </a>
            .
          </p>
          <CollegeWealthTable table={table} />
        </section>

        <section aria-labelledby="poorest" className="flex max-w-3xl flex-col gap-4">
          <h2 id="poorest" className={H2}>
            The poorest Cambridge colleges
          </h2>
          <p className="leading-relaxed text-muted-foreground">
            {wealthLedePoorest(view)} Per student the order changes, because colleges differ in
            size.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Smallest endowments</h3>
              <ol className="flex flex-col gap-1">
                {bottom.map((row) => (
                  <RankItem
                    key={row.slug}
                    rank={endowmentRank(view, row.slug)}
                    row={row}
                    value={formatGbp(row.endowmentGbp)}
                  />
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="font-semibold">Smallest per student</h3>
              <ol className="flex flex-col gap-1">
                {byStudent
                  .slice(-5)
                  .reverse()
                  .map((row) => (
                    <RankItem
                      key={row.slug}
                      rank={byStudent.indexOf(row) + 1}
                      row={row}
                      value={formatGbp(perStudent(row))}
                    />
                  ))}
              </ol>
            </div>
          </div>
        </section>

        <section aria-labelledby="per-student" className="flex max-w-3xl flex-col gap-4">
          <h2 id="per-student" className={H2}>
            Endowment per student
          </h2>
          <p className="leading-relaxed text-muted-foreground">
            Each college’s endowment divided by its students (undergraduates and postgraduates, as a
            headcount) {studentsYearText(view)}
            {studentsLater(view)
              ? ". That is a later year than the accounts, so treat these as a guide, not exact figures."
              : "."}
          </p>
          <ol className="flex flex-col gap-1">
            {byStudent.slice(0, 5).map((row, index) => (
              <RankItem
                key={row.slug}
                rank={index + 1}
                row={row}
                value={`${formatGbp(perStudent(row))} for each of ${row.students.toLocaleString("en-GB")}`}
              />
            ))}
          </ol>
        </section>

        {trinityVerified && trinityShown && (
          <section aria-labelledby="trinity" className="flex max-w-3xl flex-col gap-4">
            <h2 id="trinity" className={H2}>
              Why is Trinity so rich?
            </h2>
            <p className="leading-relaxed">
              Much of Trinity’s wealth is property. Its {view.verifiedYear} investments of{" "}
              {formatGbp(trinityVerified.endowmentGbp)} include {WEALTH_QUOTED.trinityProperty.text}{" "}
              of property, according to{" "}
              <ExternalLink href={trinityVerified.sourceUrl} className={LINK}>
                its accounts
              </ExternalLink>
              {trinityVerified.endowmentGbp > trinityVerified.netAssetsGbp
                ? `, and they are larger than its net assets (${formatGbp(trinityVerified.netAssetsGbp)}) because the college has borrowed`
                : ""}
              . At the end of {year} it held {sharePct(view)} of all {count} colleges’ endowments,
              and {formatGbp(perStudent(trinityShown))} for each of its{" "}
              {trinityShown.students.toLocaleString("en-GB")} students.
            </p>
          </section>
        )}

        <section aria-labelledby="net-assets" className="flex max-w-3xl flex-col gap-4">
          <h2 id="net-assets" className={H2}>
            Endowment vs net assets
          </h2>
          <p className="leading-relaxed">
            Net assets count everything a college owns, its buildings included, less everything it
            owes. Many rankings use net assets or older accounts, so their figures differ from
            these.
            {mover
              ? ` ${mover.row.college.shortName} is ${ordinal(mover.endowmentRank)} by endowment but ${ordinal(mover.netAssetsRank)} by net assets (${formatGbp(mover.row.netAssetsGbp)}).`
              : ""}{" "}
            By net assets, the five largest at the end of {year} were:
          </p>
          <ol className="flex flex-col gap-1">
            {byNetAssets.slice(0, 5).map((row, index) => (
              <RankItem
                key={row.slug}
                rank={index + 1}
                row={row}
                value={formatGbp(row.netAssetsGbp)}
              />
            ))}
          </ol>
        </section>

        <section aria-labelledby="trend" className="flex flex-col gap-4">
          <h2 id="trend" className={H2}>
            How college endowments have changed
          </h2>
          <p className="max-w-3xl leading-relaxed text-muted-foreground">
            {view.trendYears.length > 1
              ? `Each college’s endowment at the end of each financial year from ${view.trendYears[0]} to ${view.trendYears.at(-1)}.`
              : `Each college’s endowment at the end of ${year}.`}
            {risers.length > 0
              ? ` Over ${year} the largest rises were ${listNames(risers.map((row) => `${row.college.shortName} (${formatPct(changePct(row) ?? 0)})`))}; a rise includes new gifts, so it is not the investment return.`
              : ""}
          </p>
          <CollegeWealthTrend view={view} />
        </section>

        <section aria-labelledby="method" className="flex max-w-3xl flex-col gap-4">
          <h2 id="method" className={H2}>
            How we measured this
          </h2>
          <ul className="flex list-disc flex-col gap-3 pl-5 leading-relaxed">
            <li>
              <strong className="font-semibold">Endowment</strong> is the investments on the
              college’s consolidated balance sheet at year end, at market (fair) value. It includes
              investment property and unrestricted money invested alongside the endowment, and
              leaves out the college’s own buildings, cash and short-term deposits. We use it
              because every college reports it the same way (in the Recommended Cambridge College
              Accounts format), so the figures compare like for like.
            </li>
            <li>
              It is not the balance sheet’s “endowment reserve”, which counts only restricted
              endowment funds and is much smaller for many colleges, nor the headline a college
              chooses for its own report. Where we found a different headline figure in a college’s
              report, the notes below record it.
            </li>
            <li>
              <strong className="font-semibold">Financial year:</strong> {year}, ending{" "}
              {yearEndText(view)}. The 1-year change compares with the same balance sheet a year
              earlier. It includes new gifts and money withdrawn or spent, so it is not the
              investment return.
            </li>
            <li>
              <strong className="font-semibold">Net assets</strong> are the college’s total
              reserves; <strong className="font-semibold">income</strong> is total income for the
              year, which includes donations and new endowments and so swings from year to year.
              {view.basis === "verified"
                ? ` For ${INCOME_FROM_ANNUAL_RETURN.length} colleges whose scanned accounts could not be read by machine, income is the figure in the Charity Commission annual return.`
                : " Income is the figure in each college’s annual return."}
            </li>
            <li>
              <strong className="font-semibold">Students</strong> are undergraduates plus
              postgraduates, as a headcount (part-time included), {studentsYearText(view)}, from the
              University’s{" "}
              <ExternalLink href={WEALTH_STUDENTS_SOURCE_URL} className={LINK}>
                {studentsSource?.title ?? "College key facts and figures"}
              </ExternalLink>
              .
            </li>
            <li>
              <strong className="font-semibold">Sources:</strong> each college’s audited annual
              report and accounts as filed with the{" "}
              <ExternalLink href={register?.url ?? ""} className={LINK}>
                Charity Commission register
              </ExternalLink>
              , opened through the OpenCharities mirror of the register, which republishes the filed
              documents. The University no longer publishes the colleges’ accounts together, so each
              was read one by one. Scanned accounts were read by text recognition.
            </li>
            <li>
              <strong className="font-semibold">Checks:</strong> {registerCheckText()} Each
              college’s figures were read from its accounts and compared with the{" "}
              <ExternalLink href={WEALTH_REGISTER_CHECK.url} className={LINK}>
                register’s bulk data
              </ExternalLink>{" "}
              on {formatDate(WEALTH_REGISTER_CHECK.checkedOn)}.
            </li>
            <li>
              <strong className="font-semibold">Keeping it current:</strong> the register is read
              every week
              {view.registerReadOn ? ` (last on ${formatDate(view.registerReadOn)})` : ""}. Colleges
              must file each year’s accounts within ten months of their year end. When every college
              has filed a new year and its figures pass our checks, the ranking moves to that year;
              a figure that fails a check is held back until it has been read in the accounts.
              {view.basis === "register"
                ? ` The ${year} figures are as filed in each college’s annual return, not yet read from the accounts.`
                : ""}
              {nextLine ? ` ${nextLine}` : ""}
            </li>
          </ul>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
            {WEALTH_CAVEATS.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
            <li>{WEALTH_TOTAL_NOTE}</li>
          </ul>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer font-medium">
              Notes on the {view.verifiedYear} accounts, college by college ({withNotes.length})
            </summary>
            <dl className="mt-3 flex flex-col gap-3 text-sm">
              {withNotes.map((row) => (
                <div key={row.slug}>
                  <dt className="font-medium">{row.college.shortName}</dt>
                  <dd className="text-muted-foreground">
                    {row.notes}{" "}
                    <ExternalLink href={row.sourceUrl} className={LINK}>
                      Accounts
                    </ExternalLink>{" "}
                    ({row.sourceRef})
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </section>

        <section aria-labelledby="limits" className="flex max-w-3xl flex-col gap-4">
          <h2 id="limits" className={H2}>
            What the numbers don’t say
          </h2>
          <ul className="flex list-disc flex-col gap-3 pl-5 leading-relaxed">
            <li>
              An endowment is money invested, not money spent. These figures do not show what a
              college spends on its students, what its rooms or formals cost, or what bursaries it
              gives.
            </li>
            <li>
              Money moves between colleges. Hughes Hall’s financial review, for one, lists a{" "}
              {WEALTH_QUOTED.hughesHallCollegesFundGrant.text} grant from the Colleges Fund in its{" "}
              {view.verifiedYear} income.
            </li>
            {shortTermNames && (
              <li>
                The measure leaves out short-term investments. In {view.verifiedYear}{" "}
                {shortTermNames} held sizeable sums that way (see the notes above), so the table
                understates them next to colleges that hold such money as long-term investments.
              </li>
            )}
          </ul>
        </section>

        <section aria-labelledby="faq" className="flex max-w-3xl flex-col gap-5">
          <h2 id="faq" className={H2}>
            Questions
          </h2>
          {faqs.map((entry) => (
            <div key={entry.id} id={`faq-${entry.id}`} className="flex flex-col gap-1.5">
              <h3 className="font-semibold">{entry.question}</h3>
              <p className="leading-relaxed text-muted-foreground">
                <FaqAnswer parts={entry.answer} />
              </p>
            </div>
          ))}
        </section>

        <nav aria-label="More on colleges" className="flex flex-col gap-2">
          {[
            { href: COLLEGES_PATH, label: "Every college: JCRs, MCRs, societies and formal rules" },
            { href: "/formals", label: "Formals in Cambridge, night by night" },
            { href: "/guides/formal-hall", label: "How formal hall works across colleges" },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline underline-offset-4 sm:min-h-0"
            >
              {link.label}
              <ArrowRightIcon aria-hidden className="size-3.5" />
            </Link>
          ))}
        </nav>

        <footer className="flex max-w-3xl flex-col gap-2 text-sm text-muted-foreground">
          <p>
            {view.basis === "verified"
              ? `Figures read from the ${year} accounts each college filed with the Charity Commission, which each row links, and checked against the register on ${formatDate(WEALTH_REGISTER_CHECK.checkedOn)}; student numbers from the University.`
              : `Figures as filed with the Charity Commission for ${year}, which each row links; student numbers from the University.`}
          </p>
          <p>
            Register data from the Charity Commission for England and Wales.{" "}
            {WEALTH_REGISTER_CHECK.licence.replace(/Open Government Licence v3\.0\.?$/, "")}
            <ExternalLink href={WEALTH_REGISTER_CHECK.licenceUrl} className="underline">
              Open Government Licence v3.0
            </ExternalLink>
            .
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

function RankItem({
  rank,
  row,
  value,
}: {
  rank: number
  row: { slug: string; college: { shortName: string; slug: string } }
  value: string
}) {
  return (
    <li className="flex items-baseline gap-3 border-b py-1.5">
      <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
        {rank}
      </span>
      <a href={`#${row.slug}`} className={`min-w-0 flex-1 font-medium ${LINK}`}>
        {row.college.shortName}
      </a>
      <span className="font-mono text-sm tabular-nums">{value}</span>
    </li>
  )
}

function FaqAnswer({ parts }: { parts: readonly FaqPart[] }) {
  return parts.map((part, index) => {
    if (typeof part === "string") return part
    const key = `${index}-${part.href}`
    return part.href.startsWith("/") ? (
      <Link key={key} href={part.href} className={LINK}>
        {part.text}
      </Link>
    ) : (
      <ExternalLink key={key} href={part.href} className={LINK}>
        {part.text}
      </ExternalLink>
    )
  })
}
