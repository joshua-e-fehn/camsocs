import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { HubList, type HubListCard } from "@/components/molecules/hub-list"
import { crawlerTrapRel } from "@/lib/crawl-traps"

export type HubSection = { id: string; title: string; cards: HubListCard[] }

/**
 * A hub page (SEO audit 2026-11-02, no-category-college-hubs, owner decision
 * G13): a category's page (`/categories/<slug>`) or a college's own page
 * (`/societies/<college>`). One H1 that names Cambridge, an opening paragraph
 * built from counts (lib/directory-hubs.ts), then every listing as a link,
 * in sections, all in the server's HTML — the page a search engine or an
 * answer engine can cite for "<category> societies in Cambridge" or
 * "<college> societies". A server component: no client JavaScript of its own.
 */
export function DirectoryHub({
  eyebrow,
  title,
  intro,
  crumbs,
  sections,
  collegeNames,
  missingHref,
  missingText,
  badge,
  aside,
}: {
  eyebrow: string
  title: string
  intro: string
  /** The trail above the H1, the page itself last (not a link). */
  crumbs: { name: string; href?: string }[]
  sections: HubSection[]
  collegeNames: Record<string, string>
  /** "Missing a society at …? Add it". */
  missingHref: string
  missingText: string
  /** Beside the H1: a college's crest. */
  badge?: React.ReactNode
  /** Links to the other hubs, under the list. */
  aside?: React.ReactNode
}) {
  const total = sections.reduce((sum, section) => sum + section.cards.length, 0)
  return (
    <article>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-x-2">
              {crumbs.map((crumb, index) => (
                <li key={crumb.name} className="flex items-center gap-2">
                  {index > 0 && <span aria-hidden>/</span>}
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      className="hover:text-foreground max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
                    >
                      {crumb.name}
                    </Link>
                  ) : (
                    <span aria-current="page">{crumb.name}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            {eyebrow}
          </p>
          <div className="flex items-center gap-4">
            {badge}
            <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
              {title}
            </h1>
          </div>
          <p className="max-w-3xl text-lg leading-relaxed text-pretty">{intro}</p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-12 px-4 py-8 sm:px-6 lg:py-10">
        {sections
          .filter((section) => section.cards.length > 0)
          .map((section) => (
            <section key={section.id} aria-labelledby={section.id} className="flex flex-col gap-3">
              <h2
                id={section.id}
                className="flex items-baseline gap-3 font-serif text-2xl font-medium tracking-tight"
              >
                {section.title}
                <span className="font-mono text-sm text-muted-foreground tabular-nums">
                  {section.cards.length}
                </span>
              </h2>
              <HubList cards={section.cards} collegeNames={collegeNames} />
            </section>
          ))}

        <p className="flex flex-wrap items-center gap-x-2 rounded-2xl border border-dashed p-5 text-sm">
          <span className="text-muted-foreground">
            {total > 0 ? missingText : "Nothing listed here yet."}
          </span>
          <Link
            href={missingHref}
            rel={crawlerTrapRel(missingHref)}
            className="inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-4 sm:min-h-0"
          >
            Add it
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
        </p>
        {aside}
      </div>
    </article>
  )
}
