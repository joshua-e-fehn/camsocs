import { AUDIENCE_PAGES } from "./audience-hubs"
import { GUIDES, type Guide, type GuideSlug, guide } from "./guides"
import { matchesWords } from "./palette"

/**
 * Where the guides (lib/guides.ts) are linked from besides /guides and the
 * footer, so a reader finds them without knowing the URL: the header's
 * "Guides" section, the ⌘K palette's "Guides & pages" group, the home page's
 * "Guides" rows and each page's "Related guides". Static: nothing here reads
 * Convex, so the pages that use it stay cached.
 */

/** Each guide's siblings, most useful first; shown under the guide. */
export const RELATED_GUIDES: Record<GuideSlug, readonly GuideSlug[]> = {
  "join-a-society": ["freshers", "start-a-society", "university-sport"],
  "start-a-society": ["join-a-society", "freshers", "theatre"],
  "formal-hall": ["may-balls", "glossary", "postgraduates"],
  "may-balls": ["formal-hall", "rowing", "glossary"],
  rowing: ["varsity", "university-sport", "may-balls"],
  varsity: ["rowing", "university-sport", "glossary"],
  "university-sport": ["rowing", "varsity", "join-a-society"],
  theatre: ["join-a-society", "start-a-society", "freshers"],
  postgraduates: ["freshers", "formal-hall", "join-a-society"],
  freshers: ["join-a-society", "glossary", "postgraduates"],
  glossary: ["freshers", "formal-hall", "may-balls"],
}

export function relatedGuides(slug: GuideSlug): Guide[] {
  return RELATED_GUIDES[slug].map(guide)
}

/** The six guides the home page lists, before "All guides". */
export const HOME_GUIDES: readonly Guide[] = (
  ["join-a-society", "freshers", "formal-hall", "may-balls", "postgraduates", "glossary"] as const
).map(guide)

/** One row of the palette's "Guides & pages" group. */
export type GuidePageLink = {
  href: string
  label: string
  hint: string
  /** Extra words the query may match (never shown). */
  words?: string
}

/**
 * The palette's "Guides & pages": every guide, then the site's static pages
 * that are not one of the header's sections. Matched with `matchesWords`
 * over label, hint and words, so "bumps" finds rowing and "mcr" the
 * colleges. /guides itself is in the palette's "Jump to" list.
 */
export const GUIDE_PAGE_LINKS: readonly GuidePageLink[] = [
  ...GUIDES.map((entry) => ({
    href: entry.path,
    label: entry.short,
    hint: entry.summary,
    words: `guide ${entry.title} ${entry.description}`,
  })),
  {
    href: "/colleges",
    label: "Colleges",
    hint: "Every college's JCR, MCR, boat club and societies",
    words: "college jcr mcr formal hall",
  },
  {
    href: "/colleges/wealth",
    label: "College wealth",
    hint: "Every college ranked by endowment, from its accounts",
    words: "rich richest money endowment finances",
  },
  {
    href: "/formals",
    label: "Formals, night by night",
    hint: "Which colleges hold formal hall tonight",
    words: "formal hall dinner tonight",
  },
  {
    href: "/formals/tracker",
    label: "Formal tracker",
    hint: "Tick off a formal at every college",
    words: "formal hall badges ranks leaderboard",
  },
  {
    href: "/finder",
    label: "Society finder",
    hint: "Which society should you join? A short quiz",
    words: "quiz recommend",
  },
  {
    href: "/finder/events",
    label: "Event finder",
    hint: "What's on this week, picked by a short quiz",
    words: "quiz recommend calendar",
  },
  {
    href: "/term-dates",
    label: "Term dates",
    hint: "Full Term, Michaelmas, Lent and Easter",
    words: "calendar week michaelmas lent easter",
  },
  {
    href: "/categories",
    label: "Societies by kind",
    hint: "Sport, music, politics and the other categories",
    words: "categories",
  },
  ...AUDIENCE_PAGES.map((page) => ({
    href: page.path,
    label: page.title.replace(/ in Cambridge$/, ""),
    hint: page.how,
    words: page.who,
  })),
]

/** The rows a query matches, in list order, at most `limit`. */
export function matchGuidePages(query: string, limit: number): GuidePageLink[] {
  if (!query.trim()) return []
  return GUIDE_PAGE_LINKS.filter((link) =>
    matchesWords(`${link.label} ${link.hint} ${link.words ?? ""}`, query),
  ).slice(0, limit)
}
