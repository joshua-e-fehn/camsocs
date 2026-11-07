import type { HubCard } from "./directory-hubs"
import { CATEGORY_LABELS, type Category } from "./vocab"

/**
 * "Societies for …" pages (ENG-118): one indexable list per need, built from
 * what the directory already records about each listing (its `audiences`,
 * a sports club's `beginnerFriendly` flag, its categories). A listing is on
 * a page when any of the page's queries matches it; the page says how the
 * list is made, so it claims no more than the sources do. No page is built
 * on a sensitive characteristic (Art 9, DPIA §5): identity and faith
 * audiences such as `lgbtq` get none.
 */

export type HubQuery = {
  audience?: "beginners" | "postgraduates" | "international"
  beginnerFriendly?: boolean
  category?: Category
}

export type AudiencePage = {
  slug: "beginners" | "postgraduates" | "international-students"
  path: `/for/${string}`
  title: string
  description: string
  /** Who the page is for, for the intro: "beginners". */
  who: string
  /** How the list is made, said on the page. */
  how: string
  queries: readonly HubQuery[]
  /** Related pages, shown under the list. */
  related: readonly (readonly [string, string])[]
}

export const AUDIENCE_PAGES: readonly AudiencePage[] = [
  {
    slug: "beginners",
    path: "/for/beginners",
    title: "Societies and clubs for beginners in Cambridge",
    description:
      "Cambridge student societies and sports clubs that welcome complete beginners, from sport and dance to music and languages, each linked to its own page.",
    who: "beginners",
    how: "Listings whose sources say they welcome beginners, and sports clubs marked beginner-friendly.",
    queries: [{ audience: "beginners" }, { beginnerFriendly: true }],
    related: [
      ["/guides/join-a-society", "How to find and join societies"],
      ["/guides/university-sport", "University sport: trials and Give It a Go"],
    ],
  },
  {
    slug: "postgraduates",
    path: "/for/postgraduates",
    title: "Societies and clubs for postgraduates in Cambridge",
    description:
      "Cambridge societies and clubs for postgraduate students: graduate societies, MCRs and groups whose sources say they are open to postgraduates.",
    who: "postgraduates",
    how: "Listings whose sources say they are for, or open to, postgraduate students, including MCRs.",
    queries: [{ audience: "postgraduates" }],
    related: [
      ["/guides/postgraduates", "Postgraduate life in Cambridge"],
      ["/colleges", "Every college's MCR"],
    ],
  },
  {
    slug: "international-students",
    path: "/for/international-students",
    title: "Societies for international students in Cambridge",
    description:
      "Cambridge cultural, national and international societies, and groups whose sources say they welcome international students, each linked to its page.",
    who: "international students",
    how: "Cultural and international societies, and listings whose sources say they welcome international students.",
    queries: [{ category: "cultural_international" }, { audience: "international" }],
    related: [
      ["/categories/cultural-international", "Cultural and international societies"],
      ["/guides/glossary", "Cambridge words explained"],
    ],
  },
]

export function audiencePage(slug: AudiencePage["slug"]): AudiencePage {
  const page = AUDIENCE_PAGES.find((entry) => entry.slug === slug)
  if (!page) throw new Error(`No audience page ${slug}`)
  return page
}

/** The union of several hub reads, once each, by name. */
export function unionCards<T extends HubCard>(lists: readonly (readonly T[])[]): T[] {
  const byKey = new Map<string, T>()
  for (const list of lists)
    for (const card of list) if (!byKey.has(card.key)) byKey.set(card.key, card)
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "en-GB"))
}

/** "CAMsocs lists 131 societies and clubs for beginners, most of them in Sport, Music and …". */
export function audienceIntro(page: AudiencePage, cards: readonly HubCard[]): string {
  if (cards.length === 0) return `CAMsocs lists no societies for ${page.who} yet.`
  const counts = new Map<Category, number>()
  for (const card of cards) for (const c of card.categories) counts.set(c, (counts.get(c) ?? 0) + 1)
  const top = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([c]) => CATEGORY_LABELS[c])
  const many = cards.length === 1 ? "society or club" : "societies and clubs"
  const areas =
    top.length > 0 ? `, most of them in ${top.join(", ").replace(/, ([^,]*)$/, " and $1")}` : ""
  return `CAMsocs lists ${cards.length} ${many} for ${page.who}${areas}. ${page.how}`
}
