import { DISCLAIMER } from "./site"
import { breadcrumbList, PUBLISHER_ID, pageId, WEBSITE_ID } from "./structured-data"

/**
 * The guides (`/guides`, `/guides/<slug>`): plain editorial pages that answer
 * recurring Cambridge questions (ENG-105). One rule holds them honest: every
 * fact a page states links the public page it comes from, and the page lists
 * its sources with the date they were read. A fact without a source is not
 * written. The guides are unofficial (DISCLAIMER): they sum up what colleges,
 * the SU and the University publish, and never speak for any of them.
 *
 * The join-a-society and start-a-society drafts (PR #46, ENG-106) join this
 * list once their review notes are settled.
 */

export type GuideSlug = "formal-hall"

export type GuideSource = {
  /** Who published it, short: shown inline as the citation. */
  publisher: string
  /** What the page or document is. */
  title: string
  url: string
  /** `YYYY-MM-DD`: when it was read for the guide. */
  retrieved: string
}

export type Guide = {
  slug: GuideSlug
  path: `/guides/${GuideSlug}`
  /** The page's name and h1; the `<title>` adds " · CAMsocs" while it fits. */
  title: string
  /** Meta description, at most 155 characters (a test holds it). */
  description: string
  /** One line for the guides index and llms.txt. */
  summary: string
  /** `YYYY-MM-DD`: when the page first went live (Article `datePublished`). */
  published: string
  /** `YYYY-MM-DD`: when its facts were last checked (Article `dateModified`). */
  updated: string
}

export const GUIDES_PATH = "/guides"
export const GUIDES_TITLE = "Guides to student life in Cambridge"
export const GUIDES_DESCRIPTION =
  "Plain guides for Cambridge students: formal hall and more to come. Unofficial; every fact links the page it comes from."

export const GUIDES: readonly Guide[] = [
  {
    slug: "formal-hall",
    path: "/guides/formal-hall",
    title: "Formal hall in Cambridge: a guide for every college",
    description:
      "How formal hall works in Cambridge, how to go to another college's formal, and each of the 31 colleges' rules on guests, gowns and booking.",
    summary:
      "What formal hall is, how to get into another college's formal (a host or a swap), gowns and dress, and the rules of all 31 colleges.",
    published: "2026-11-07",
    updated: "2026-11-07",
  },
]

export function guide(slug: GuideSlug): Guide {
  const found = GUIDES.find((entry) => entry.slug === slug)
  if (!found) throw new Error(`No guide ${slug}`)
  return found
}

/**
 * A guide's JSON-LD: an Article and its BreadcrumbList (Guides → the guide).
 * Article, not HowTo (Google retired HowTo rich results in 2023) and not
 * FAQPage (its rich results are limited to government and health sites).
 * The publisher is the person who runs CAMsocs; never the University, a
 * college or the SU.
 */
export function guideJsonLd(
  entry: Guide,
  sources: readonly GuideSource[],
): Record<string, unknown> {
  const url = pageId(entry.path)
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        url,
        mainEntityOfPage: url,
        headline: entry.title,
        description: `${entry.description} ${DISCLAIMER}`,
        inLanguage: "en-GB",
        datePublished: entry.published,
        dateModified: entry.updated,
        isPartOf: { "@id": WEBSITE_ID },
        author: { "@id": PUBLISHER_ID },
        publisher: { "@id": PUBLISHER_ID },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        citation: [...new Set(sources.map((source) => source.url))],
      },
      breadcrumbList(entry.path, [
        { name: "Guides", path: GUIDES_PATH },
        { name: entry.title, path: entry.path },
      ]),
    ],
  }
}
