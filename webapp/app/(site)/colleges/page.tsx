import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { ExternalLink } from "@/components/molecules/external-link"
import { api } from "@/convex/_generated/api"
import { formatDate } from "@/lib/calendar"
import { collegeCards } from "@/lib/college-index"
import {
  COLLEGE_INFO,
  COLLEGES_PATH,
  CREST_CREDIT,
  CREST_CREDIT_URL,
  FORMAL_ANCHOR,
  FORMALS_CHECKED_ON,
} from "@/lib/colleges"
import { collectionJsonLd, collegeHubPath } from "@/lib/directory-hubs"
import { pageMetadata } from "@/lib/page-metadata"
import { publicQuery } from "@/lib/public-data"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"

/**
 * Every college on one page (ENG-107): its crest, its JCR, MCR and boat club,
 * how many societies CAMsocs lists there, and how a student from another
 * college gets into its formal hall. Search Console showed people looking
 * for "<college> jcr/mcr" (Nov 2026); nothing listed the colleges together.
 * Listings come from the directory (`orgs.hub`, cached like every public
 * read); crests and formal rules from lib/colleges.ts.
 */

const TITLE = "Cambridge colleges: societies, JCRs, MCRs and formal hall"
const DESCRIPTION = `All ${COLLEGE_INFO.length} Cambridge colleges with their JCR, MCR, boat club and societies, and each college's formal hall rules for visitors.`

/** Every listing, or null when Convex cannot be read (the page then still
 * lists the colleges and their formal rules, without counts). */
async function loadCards() {
  try {
    return await publicQuery(api.orgs.hub, {})
  } catch (error) {
    unstable_rethrow(error)
    console.error("orgs.hub failed; /colleges without listings", error)
    return null
  }
}

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: COLLEGES_PATH,
})

const LINK =
  "underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"

export default async function CollegesPage() {
  const cards = await loadCards()
  const colleges = collegeCards(COLLEGE_INFO, cards ?? [])
  const jsonLd = collectionJsonLd({
    path: COLLEGES_PATH,
    title: TITLE,
    description: DESCRIPTION,
    items: colleges.map(({ college }) => ({ name: college.name, path: collegeHubPath(college) })),
    crumbs: [{ name: "Colleges", path: COLLEGES_PATH }],
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
            Colleges
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Cambridge colleges
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">
            All {colleges.length} colleges of the University of Cambridge, each with its JCR, MCR
            and boat club, the student societies CAMsocs lists there, and how a student from another
            college can go to its formal hall.
          </p>
          <Link
            href="/guides/formal-hall"
            className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline underline-offset-4 sm:min-h-0"
          >
            How formal hall works across colleges
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-8 sm:px-6 lg:py-10">
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {colleges.map(({ college, count, bodies }) => {
            const hub = collegeHubPath(college)
            return (
              <li
                key={college.key}
                className="flex flex-col gap-3 rounded-2xl border p-5"
                id={college.slug}
              >
                <div className="flex items-center gap-4">
                  <CollegeCrest crest={college.crest} size={56} decorative />
                  <div className="flex min-w-0 flex-col">
                    <h2 className="font-serif text-xl font-medium tracking-tight">
                      <Link href={hub} className={LINK}>
                        {college.name}
                      </Link>
                    </h2>
                    {cards && (
                      <p className="font-mono text-xs text-muted-foreground tabular-nums">
                        {count} {count === 1 ? "society or club" : "societies and clubs"} listed
                      </p>
                    )}
                  </div>
                </div>
                {bodies.length > 0 && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {bodies.map((body) => (
                      <li key={body.slug}>
                        <Link href={`/societies/${body.slug}`} className={LINK}>
                          {body.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Formal hall: </span>
                  {college.formal.bookingSummary}.
                </p>
                <Link
                  href={`${hub}#${FORMAL_ANCHOR}`}
                  className="mt-auto inline-flex min-h-11 items-center gap-1 self-start text-sm underline underline-offset-4 sm:min-h-0"
                >
                  Formal hall rules and societies
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </li>
            )
          })}
        </ul>

        <footer className="flex max-w-3xl flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Formal hall rules checked {formatDate(FORMALS_CHECKED_ON)} against each college’s own
            pages, which each college page links. Rules and prices change between terms: check the
            college’s page before you book.
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
