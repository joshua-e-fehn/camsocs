import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { AUDIENCE_PAGES } from "@/lib/audience-hubs"
import { GUIDES, GUIDES_DESCRIPTION, GUIDES_PATH, GUIDES_TITLE } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import { DISCLAIMER } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: GUIDES_TITLE,
  description: GUIDES_DESCRIPTION,
  path: GUIDES_PATH,
})

/** The guides' index (lib/guides.ts): one link to each, with what it covers. */
export default function GuidesPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        <h1 className="font-serif text-4xl leading-tight font-normal tracking-[-0.02em] text-balance sm:text-5xl">
          Guides
        </h1>
        <p className="text-lg text-muted-foreground">{GUIDES_DESCRIPTION}</p>
      </header>
      <ul className="flex flex-col divide-y border-y">
        {GUIDES.map((entry) => (
          <li key={entry.slug} className="flex flex-col gap-1 py-5">
            <h2 className="font-serif text-2xl font-normal tracking-[-0.01em]">
              <Link href={entry.path} className="hover:underline">
                {entry.title}
              </Link>
            </h2>
            <p className="text-muted-foreground">{entry.summary}</p>
            <Link
              href={entry.path}
              className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-brand-text sm:min-h-0"
            >
              Read the guide
              <ArrowRightIcon aria-hidden className="size-3.5" />
            </Link>
          </li>
        ))}
      </ul>
      <section aria-labelledby="lists" className="flex flex-col gap-2">
        <h2 id="lists" className="font-serif text-2xl font-normal tracking-[-0.01em]">
          Societies for…
        </h2>
        <ul className="flex flex-col gap-1">
          {AUDIENCE_PAGES.map((page) => (
            <li key={page.slug}>
              <Link href={page.path} className="underline-offset-4 hover:underline">
                {page.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <p className="text-sm text-muted-foreground">{DISCLAIMER}</p>
    </div>
  )
}
