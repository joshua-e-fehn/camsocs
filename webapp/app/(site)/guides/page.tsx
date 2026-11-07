import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { DraftNotice } from "@/components/molecules/guide-parts"
import { collectionJsonLd } from "@/lib/directory-hubs"
import { GUIDES, GUIDES_DESCRIPTION, GUIDES_PATH, GUIDES_TITLE, guidesInReview } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER } from "@/lib/site"
import { jsonLdScript } from "@/lib/structured-data"

export const metadata: Metadata = {
  ...pageMetadata({ title: GUIDES_TITLE, description: GUIDES_DESCRIPTION, path: GUIDES_PATH }),
  // A draft asks not to be indexed (lib/guides.ts REVIEW_NOTES).
  ...(guidesInReview() ? { robots: { index: false, follow: true } } : {}),
}

/** The guides index: one row per guide (lib/guides.ts). */
export default function GuidesPage() {
  const jsonLd = collectionJsonLd({
    path: GUIDES_PATH,
    title: GUIDES_TITLE,
    description: GUIDES_DESCRIPTION,
    items: GUIDES.map((entry) => ({ name: entry.title, path: entry.path })),
    crumbs: [{ name: "Guides", path: GUIDES_PATH }],
  })
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      <header className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
          Guides
        </h1>
        <p className="text-lg text-muted-foreground">
          Finding your people in Cambridge, and starting something new. Each guide sums up what the
          SU, the Proctors, the Sports Service and the colleges publish, and links every fact to its
          source.
        </p>
        <DraftNotice />
      </header>

      <ul className="flex flex-col border-t-2 border-foreground">
        {GUIDES.map((entry) => (
          <li key={entry.slug} className="border-b">
            <Link
              href={entry.path}
              className="group flex items-start justify-between gap-4 py-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex flex-col gap-1">
                <span className="font-serif text-2xl leading-snug group-hover:text-brand-text">
                  {entry.title}
                </span>
                <span className="text-sm text-muted-foreground">{entry.summary}</span>
              </span>
              <ArrowRightIcon aria-hidden className="mt-2 size-5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-sm text-muted-foreground">{DISCLAIMER}</p>
    </div>
  )
}
