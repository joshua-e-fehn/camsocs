import Link from "next/link"
import { GuideSourceList } from "@/components/molecules/guide-parts"
import { ProseSection } from "@/components/molecules/prose-section"
import { formatDate } from "@/lib/calendar"
import { GUIDES_PATH, type Guide, type GuideSource, guideJsonLd } from "@/lib/guides"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"

/**
 * A guide's page (lib/guides.ts), set like About: the text in a readable
 * measure, an aside with "On this page" and anything the page adds (live
 * counts, the term), and, last, the sources every fact on it cites.
 */
export function GuideArticle({
  guide,
  lede,
  toc,
  aside,
  sources,
  children,
}: {
  guide: Guide
  /** Every source the page cites, in the order the source list shows them. */
  sources: readonly GuideSource[]
  lede: React.ReactNode
  /** The page's sections: anchor and label. */
  toc: readonly (readonly [string, string])[]
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-10 sm:px-6 lg:grid-cols-[1fr_18rem]">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(guideJsonLd(guide, sources)) }}
      />
      <article className="flex max-w-3xl min-w-0 flex-col gap-10">
        <header className="flex flex-col gap-3">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <Link href={GUIDES_PATH} className="hover:text-foreground hover:underline">
              Guides
            </Link>
          </nav>
          <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
            {guide.title}
          </h1>
          <p className="text-lg text-muted-foreground">{lede}</p>
          <p className="font-mono text-xs text-muted-foreground tabular-nums">
            Facts checked {formatDate(guide.updated)} · every fact links its source
          </p>
        </header>

        {children}

        <ProseSection id="sources" title="Sources">
          <p>
            Each fact above links the page it comes from. These are the pages, and when they were
            read. Their publishers are the authority: check them for anything that matters, as dates
            and rules change from year to year.
          </p>
          <GuideSourceList sources={sources} />
        </ProseSection>

        <p className="text-sm text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
          <strong className="font-medium text-foreground">{DISCLAIMER}</strong> This guide sums up
          what those bodies publish; it is not their advice. Spotted something wrong or out of date?
          Use the <Link href="/request">request form</Link> or the address in the footer.
        </p>
      </article>

      <aside className="flex flex-col gap-4 text-sm lg:pt-16">
        {aside}
        <nav aria-label="On this page" className="flex flex-col gap-1 rounded-xl border p-5">
          <h2 className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            On this page
          </h2>
          {[...toc, ["#sources", "Sources"] as const].map(([href, label]) => (
            <a key={href} href={href} className="text-muted-foreground hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  )
}
