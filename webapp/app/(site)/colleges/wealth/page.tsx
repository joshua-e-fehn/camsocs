import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { CollegeWealthStat } from "@/components/molecules/college-wealth-stat"
import { ExternalLink } from "@/components/molecules/external-link"
import { CollegeWealthTable } from "@/components/organisms/college-wealth-table"
import { formatDate } from "@/lib/calendar"
import {
  BY_ENDOWMENT,
  COLLEGE_WEALTH,
  formatGbp,
  INCOME_FROM_ANNUAL_RETURN,
  JULY_YEAR_END,
  listNames,
  ordinal,
  perStudent,
  rankedBy,
  SHORT_TERM_HOLDERS,
  UNIVERSITY_ENDOWMENT,
  WEALTH_CAVEATS,
  WEALTH_CHECKED_ON,
  WEALTH_FINANCIAL_YEAR,
  WEALTH_FINANCIAL_YEAR_NOTE,
  WEALTH_PATH,
  WEALTH_QUOTED,
  WEALTH_SOURCES,
  WEALTH_STUDENTS_SOURCE_URL,
  WEALTH_TOTAL_NOTE,
  WEALTH_TOTALS,
  wealthTable,
} from "@/lib/college-wealth"
import { COLLEGES_PATH, CREST_CREDIT, CREST_CREDIT_URL } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"
import {
  WEALTH_CRUMB,
  WEALTH_DESCRIPTION,
  WEALTH_SHARE_PCT,
  WEALTH_TITLE,
  wealthJsonLd,
} from "./wealth-json-ld"

/**
 * The colleges ranked by endowment (ENG-272). Static: every figure comes from
 * lib/data/college-wealth.json, read from the 2024-25 accounts each college
 * filed with the Charity Commission, with its PDF and page. The page says
 * what the measure is and what it is not, and answers only what the data
 * answers.
 */

const { total, richest, poorest, median } = WEALTH_TOTALS
const runnerUp = BY_ENDOWMENT[1]
const sharePct = WEALTH_SHARE_PCT
const count = COLLEGE_WEALTH.length
const medianRank = BY_ENDOWMENT.indexOf(median) + 1
const lowestPerStudent = rankedBy(COLLEGE_WEALTH, "perStudent").at(-1) ?? poorest
const rechecked = COLLEGE_WEALTH.filter((row) => row.recheckedOn !== null).length
const withNotes = BY_ENDOWMENT.filter((row) => row.notes.trim() !== "")
const studentsSource = WEALTH_SOURCES.find((source) => source.url === WEALTH_STUDENTS_SOURCE_URL)
const register = WEALTH_SOURCES.find((source) => source.id === "charity-commission-register")
const julyNames = listNames(JULY_YEAR_END.map((row) => row.college.shortName))
const shortTermNames = listNames(SHORT_TERM_HOLDERS.map((row) => row.college.shortName))
const trinity = COLLEGE_WEALTH.find((row) => row.slug === WEALTH_QUOTED.trinityProperty.slug)
const trinityOverNetAssets = trinity !== undefined && trinity.endowmentGbp > trinity.netAssetsGbp

export const metadata: Metadata = pageMetadata({
  title: WEALTH_TITLE,
  description: WEALTH_DESCRIPTION,
  path: WEALTH_PATH,
})

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"

export default function CollegeWealthPage() {
  const table = wealthTable(COLLEGE_WEALTH, collegeHubPath)
  return (
    <article>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(wealthJsonLd()) }}
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
            Cambridge colleges ranked by endowment
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            All {count} colleges by endowment: the investments on each college’s balance sheet at
            market value at the end of the {WEALTH_FINANCIAL_YEAR} financial year (30 June 2025 for
            most, 31 July 2025 for {julyNames}), read from the accounts it filed with the Charity
            Commission. Net assets, also in the table, is the broader measure of what a college
            owns.
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            Checked {formatDate(WEALTH_CHECKED_ON)}
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
            note={`${median.college.shortName}, ${ordinal(medianRank)} of ${count}: half hold more, half less.`}
          />
          <CollegeWealthStat
            label={`${richest.college.shortName}’s share`}
            value={sharePct}
            note={`Of all ${count} colleges’ endowments together.`}
          />
        </dl>

        <section aria-labelledby="ranking" className="flex flex-col gap-4">
          <h2 id="ranking" className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">
            Every college, ranked
          </h2>
          <p className="max-w-3xl text-muted-foreground">
            Sort by endowment, endowment per student, total income, net assets or the change in
            endowment over the year. Each row links the accounts and the page its endowment was read
            from.
          </p>
          <CollegeWealthTable table={table} />
        </section>

        <section aria-labelledby="method" className="flex max-w-3xl flex-col gap-4">
          <h2 id="method" className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">
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
              <strong className="font-semibold">Financial year:</strong>{" "}
              {WEALTH_FINANCIAL_YEAR_NOTE}. The 1-year change compares with the same balance sheet a
              year earlier. It includes new gifts and money withdrawn or spent, so it is not the
              investment return.
            </li>
            <li>
              <strong className="font-semibold">Net assets</strong> are the college’s total
              reserves; <strong className="font-semibold">income</strong> is total income for the
              year, which includes donations and new endowments and so swings from year to year. For{" "}
              {INCOME_FROM_ANNUAL_RETURN.length} colleges whose scanned accounts could not be read
              by machine, income is the figure in the Charity Commission annual return (spot-checked
              against the accounts).
            </li>
            <li>
              <strong className="font-semibold">Students</strong> are undergraduates plus
              postgraduates, as a headcount (part-time included), for 2025-26 (Girton: 2024-25),
              from the University’s{" "}
              <ExternalLink href={WEALTH_STUDENTS_SOURCE_URL} className={LINK}>
                {studentsSource?.title ?? "College key facts and figures"}
              </ExternalLink>
              . That is a later year than the accounts, so endowment per student is a guide, not an
              exact figure.
            </li>
            <li>
              <strong className="font-semibold">Sources:</strong> each college’s audited annual
              report and accounts as filed with the{" "}
              <ExternalLink href={register?.url ?? ""} className={LINK}>
                Charity Commission register
              </ExternalLink>
              , opened through the OpenCharities mirror of the register, which republishes the filed
              documents. The University no longer publishes the colleges’ accounts together, so each
              was read one by one. Scanned accounts were read by text recognition and, where
              possible, cross-checked.
            </li>
            <li>
              Every figure is marked verified. For {rechecked} colleges the accounts figures were
              read a second time, independently, on {formatDate(WEALTH_CHECKED_ON)}; for the other{" "}
              {count - rechecked}, the per-student figures, changes and student numbers were
              re-checked but the accounts figures were read once.
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
              Notes, college by college ({withNotes.length})
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
          <h2 id="limits" className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">
            What the numbers don’t say
          </h2>
          <ul className="flex list-disc flex-col gap-3 pl-5 leading-relaxed">
            <li>
              An endowment is money invested, not money spent. These figures do not show what a
              college spends on its students, what its rooms or formals cost, or what bursaries it
              gives.
            </li>
            <li>
              Investments are not all stocks and shares: Trinity’s include{" "}
              {WEALTH_QUOTED.trinityProperty.text} of property
              {trinityOverNetAssets
                ? ", and its investments are larger than its net assets because of borrowing"
                : ""}
              .
            </li>
            <li>
              Money moves between colleges. Hughes Hall’s financial review, for one, lists a{" "}
              {WEALTH_QUOTED.hughesHallCollegesFundGrant.text} grant from the Colleges Fund in its{" "}
              {WEALTH_FINANCIAL_YEAR} income.
            </li>
            <li>
              The measure leaves out short-term investments. {shortTermNames} hold sizeable sums
              that way (see the notes above), so the table understates them next to colleges that
              hold such money as long-term investments.
            </li>
          </ul>
        </section>

        <section aria-labelledby="faq" className="flex max-w-3xl flex-col gap-5">
          <h2 id="faq" className="font-serif text-2xl font-medium tracking-tight sm:text-3xl">
            Questions
          </h2>
          <Faq question="Which is the richest Cambridge college?">
            {richest.name}, with investments of {formatGbp(richest.endowmentGbp)} at the end of{" "}
            {WEALTH_FINANCIAL_YEAR}: about{" "}
            {(richest.endowmentGbp / runnerUp.endowmentGbp).toFixed(1)} times the next,{" "}
            {runnerUp.name} ({formatGbp(runnerUp.endowmentGbp)}), and {sharePct} of all the
            colleges’ endowments together.
          </Faq>
          <Faq question="Which college has the smallest endowment?">
            {poorest.name}, with {formatGbp(poorest.endowmentGbp)}. Per student, the smallest is{" "}
            {lowestPerStudent.name}, at {formatGbp(perStudent(lowestPerStudent))} for each of its{" "}
            {lowestPerStudent.students.toLocaleString("en-GB")} students.
          </Faq>
          <Faq question="How much is all of Cambridge’s colleges’ endowment?">
            {formatGbp(total)} across all {count} colleges, adding up each college’s balance-sheet
            investments at the end of {WEALTH_FINANCIAL_YEAR}.
          </Faq>
          <Faq question="Is the University’s endowment included?">
            No. The University is a separate body from the colleges. The Cambridge University
            Endowment Fund had a net asset value of{" "}
            {formatGbp(UNIVERSITY_ENDOWMENT.netAssetValueGbp)} at 31 July 2025, of which{" "}
            {formatGbp(UNIVERSITY_ENDOWMENT.attributableToUniversityGroupGbp)} belongs to the
            University, according to its{" "}
            <ExternalLink href={UNIVERSITY_ENDOWMENT.sourceUrl} className={LINK}>
              Reports and Financial Statements {WEALTH_FINANCIAL_YEAR}
            </ExternalLink>
            . Some colleges invest through that fund, so the two figures overlap and should not be
            added together.
          </Faq>
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
            Endowment and net-asset figures checked {formatDate(WEALTH_CHECKED_ON)} against the{" "}
            {WEALTH_FINANCIAL_YEAR} accounts each college filed with the Charity Commission, which
            each row links; student numbers from the University.
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

function Faq({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-semibold">{question}</h3>
      <p className="leading-relaxed text-muted-foreground">{children}</p>
    </div>
  )
}
