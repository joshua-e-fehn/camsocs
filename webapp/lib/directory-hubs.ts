import { breadcrumbList, pageId, WEBSITE_ID } from "./structured-data"
import { activeDirectoryFilterCount, type DirectoryState } from "./url-state"
import { CATEGORIES, CATEGORY_LABELS, type Category, type OrgType } from "./vocab"

/**
 * The directory's hubs (SEO audit 2026-11-02, no-category-college-hubs, owner
 * decision G13): one indexable, self-canonical page per category and per
 * college, so "cambridge sports clubs" and "<college> societies" have a page
 * that answers them instead of a `?cat=` view that canonicalises away.
 *
 *  - Category hubs live at `/categories/<slug>`, outside `/societies/`, so no
 *    hub path can ever collide with a society's slug (slugs are never renamed,
 *    G9). The slug is the category with hyphens (`science-tech`).
 *  - College hubs are the colleges' own pages, `/societies/<college slug>`,
 *    which already exist as counterpart listings (college-counterpart-pages).
 *
 * A single-category or single-college view of `/societies` names its hub as
 * canonical; every other filtered or searched view is `noindex, follow`
 * (directory-pagination-search-canonical). Every parameter view but
 * `?page=N` is also robots-disallowed and linked rel=nofollow (bot policy
 * 2026-11-03, lib/crawl-traps.ts); the hubs are plain paths, crawlable.
 */

export const CATEGORIES_PATH = "/categories"

/** `/categories/<slug>` for a category. */
export function categoryHubPath(category: Category): string {
  return `${CATEGORIES_PATH}/${category.replaceAll("_", "-")}`
}

/** The category a hub slug names, or undefined for anything else. */
export function categoryFromSlug(slug: string): Category | undefined {
  return CATEGORIES.find((category) => category.replaceAll("_", "-") === slug)
}

/** Every category hub's path, in vocabulary order (for the sitemap). */
export function categoryHubPaths(): string[] {
  return CATEGORIES.map(categoryHubPath)
}

/** A college hub's path: the college's own listing. */
export function collegeHubPath(college: { slug: string }): string {
  return `/societies/${college.slug}`
}

// --- the directory's canonical and robots ------------------------------------------------

export type DirectorySeo = {
  /** Site-relative canonical. */
  canonical: string
  /** False for views a search engine should follow but not index. */
  index: boolean
}

/**
 * Where a `/societies` view points search engines:
 *  - nothing filtered: itself, page by page (`?page=N` is its own page with
 *    its own title, per Google's pagination guidance);
 *  - exactly one category, or one college, and nothing else: that hub, which
 *    lists all of them on one page. Its later pages and other orders too:
 *    each is a subset of the hub, so the canonical alone says so (adding
 *    noindex would contradict the canonical, a mixed signal);
 *  - a text search, any other filter or combination, or another order: the
 *    directory, and not indexed (thin, near-duplicate result pages).
 */
export function directorySeo(
  state: DirectoryState,
  collegeSlug: (key: string) => string | undefined,
): DirectorySeo {
  const filters = activeDirectoryFilterCount(state)
  if (!state.q && !state.sort && filters === 0) {
    return {
      canonical: state.page > 1 ? `/societies?page=${state.page}` : "/societies",
      index: true,
    }
  }
  if (!state.q && filters === 1 && state.categories.length === 1) {
    return { canonical: categoryHubPath(state.categories[0]), index: true }
  }
  if (!state.q && filters === 1 && state.collegeKeys.length === 1) {
    const slug = collegeSlug(state.collegeKeys[0])
    if (slug) return { canonical: collegeHubPath({ slug }), index: true }
  }
  return { canonical: "/societies", index: false }
}

// --- what a hub says about its listings -------------------------------------------------

/** What a hub needs of a listing (`orgs.hub`). */
export type HubCard = {
  key: string
  slug: string
  name: string
  orgType?: OrgType
  level?: string
  collegeKeys: string[]
  categories: Category[]
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of items) {
    for (const key of keyOf(item)) out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

/** "a, b and c" (or "or"). */
export function listWords(words: string[], conjunction = "and"): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * A category hub's opening paragraph, from counts only (never a model, never
 * a guess): how many listings, how many are university-wide and how many
 * belong to a college, and the categories they most often share.
 */
export function categoryHubIntro(category: Category, cards: readonly HubCard[]): string {
  const label = CATEGORY_LABELS[category]
  if (cards.length === 0) {
    return `camsocs lists no ${label} groups in Cambridge yet. If you run one, tell us and we will add it.`
  }
  const university = cards.filter((card) => card.level === "university").length
  const college = cards.filter((card) => card.collegeKeys.length > 0).length
  const parts = [
    `camsocs lists ${plural(cards.length, "Cambridge student group", "Cambridge student groups")} under ${label}`,
  ]
  const split = [
    university > 0 ? `${university} university-wide` : undefined,
    college > 0 ? `${college} run within a college` : undefined,
  ].filter((part): part is string => part !== undefined)
  const first = split.length > 0 ? `${parts[0]}: ${listWords(split)}.` : `${parts[0]}.`
  const shared = [...countBy(cards, (card) => card.categories.filter((c) => c !== category))]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([other]) => CATEGORY_LABELS[other as Category])
  const second = shared.length > 0 ? ` Many are also listed under ${listWords(shared)}.` : ""
  return `${first}${second} Each listing links to its sources; nothing here is official.`
}

/** Org types as words in a sentence: singular with its article, plural. */
export const TYPE_WORDS: Record<OrgType, [string, string]> = {
  society: ["a society", "societies"],
  sports_club: ["a sports club", "sports clubs"],
  college_club: ["a college club", "college clubs"],
  jcr: ["a JCR", "JCRs"],
  mcr: ["an MCR", "MCRs"],
  college_boat_club: ["a boat club", "boat clubs"],
  college: ["a college", "colleges"],
  department: ["a department", "departments"],
  uni_office: ["a University office", "University offices"],
  student_union: ["a students' union", "students' unions"],
  company: ["a company", "companies"],
  ngo: ["a charity", "charities"],
  public_body: ["a public body", "public bodies"],
  other_university_society: ["a society at another university", "societies at other universities"],
  media: ["a student publication", "student publications"],
  theatre_company: ["a theatre company", "theatre companies"],
  other: ["another group", "other groups"],
}

/** The types a college's listings fall into, most first ("an MCR, a JCR
 * and 4 college clubs"). */
export function typeSummary(cards: readonly HubCard[]): string | undefined {
  const types = [...countBy(cards, (card) => (card.orgType ? [card.orgType] : []))]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([type, n]) => {
      const [one, many] = TYPE_WORDS[type as OrgType]
      return n === 1 ? one : `${n} ${many}`
    })
  return types.length > 0 ? listWords(types) : undefined
}

/**
 * A college hub's opening paragraph: how many listings belong to the
 * college, what kinds, and their most common categories. Counts only.
 */
export function collegeHubIntro(college: string, cards: readonly HubCard[]): string {
  if (cards.length === 0) {
    return `camsocs lists no societies or clubs at ${college} yet. If you know one, tell us and we will add it.`
  }
  const kinds = typeSummary(cards)
  const top = [...countBy(cards, (card) => card.categories)]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([category]) => CATEGORY_LABELS[category as Category])
  return [
    `camsocs lists ${plural(cards.length, "student society or club", "student societies and clubs")} at ${college}, Cambridge${kinds ? `, including ${kinds}` : ""}.`,
    top.length > 0 ? ` The most common areas are ${listWords(top)}.` : "",
    " Each listing links to its sources; nothing here is run by the college.",
  ].join("")
}

/** Listings grouped by their first category, groups by size then label; for
 * a college hub's sections. Cards without a category go last, as "Other". */
export function groupByCategory<T extends HubCard>(
  cards: readonly T[],
): { category?: Category; label: string; cards: T[] }[] {
  const groups = new Map<Category | undefined, T[]>()
  for (const card of cards) {
    const key = card.categories[0]
    groups.set(key, [...(groups.get(key) ?? []), card])
  }
  return [...groups]
    .map(([category, items]) => ({
      category,
      label: category ? CATEGORY_LABELS[category] : "Other",
      cards: items,
    }))
    .sort(
      (a, b) =>
        Number(a.category === undefined) - Number(b.category === undefined) ||
        b.cards.length - a.cards.length ||
        a.label.localeCompare(b.label),
    )
}

// --- JSON-LD -----------------------------------------------------------------------------

/**
 * A list page's JSON-LD (listing-itemlist): a CollectionPage whose main
 * entity is an ItemList of the listings it links (name, URL and position
 * only; each profile describes itself), with its breadcrumbs, joined to the
 * site by `@id` (lib/structured-data.ts). `about` names the entity the page
 * is about (a college hub's college).
 */
export function collectionJsonLd({
  path,
  title,
  description,
  items,
  crumbs,
  about,
  offset = 0,
  total,
}: {
  path: string
  title: string
  description: string
  items: readonly { name: string; path: string }[]
  crumbs: { name: string; path: string }[]
  about?: Record<string, unknown>
  /** The position of the first item (a later page of the directory). */
  offset?: number
  /** How many there are in all, when `items` is one page of them. */
  total?: number
}): Record<string, unknown> {
  const id = pageId(path)
  const page: Record<string, unknown> = {
    "@type": "CollectionPage",
    "@id": id,
    url: id,
    name: title,
    description,
    isPartOf: { "@id": WEBSITE_ID },
    breadcrumb: { "@id": `${id}#breadcrumb` },
    mainEntity: { "@id": `${id}#list` },
  }
  if (about) page.about = { "@id": about["@id"] }
  return {
    "@context": "https://schema.org",
    "@graph": [
      page,
      {
        "@type": "ItemList",
        "@id": `${id}#list`,
        numberOfItems: total ?? items.length,
        itemListElement: items.map((item, index) => ({
          "@type": "ListItem",
          position: offset + index + 1,
          name: item.name,
          url: pageId(item.path),
        })),
      },
      breadcrumbList(path, crumbs),
      ...(about ? [about] : []),
    ],
  }
}
