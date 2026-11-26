import { preloadedQueryResult } from "convex/nextjs"
import type { Metadata } from "next"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { FinderLink } from "@/components/molecules/finder-link"
import { RelatedGuides } from "@/components/molecules/related-guides"
import { OrgDirectory } from "@/components/organisms/org-directory"
import { api } from "@/convex/_generated/api"
import { CATEGORIES_PATH, collectionJsonLd, directorySeo } from "@/lib/directory-hubs"
import { directoryTitle } from "@/lib/directory-title"
import { guide } from "@/lib/guides"
import { pageMetadata } from "@/lib/page-metadata"
import type { OrgBusy } from "@/lib/public-api"
import { publicPreload, publicQuery } from "@/lib/public-data"
import { jsonLdScript } from "@/lib/structured-data"
import {
  activeDirectoryFilterCount,
  DIRECTORY_PAGE_SIZE,
  type DirectoryState,
  directoryFilters,
  directoryListArgs,
  parseDirectoryParams,
  type SearchParams,
} from "@/lib/url-state"

type Props = { searchParams: Promise<SearchParams> }

const DESCRIPTION =
  "An unofficial A–Z of Cambridge student societies, sports clubs and college groups: filter by category, college and level, with every fact sourced."

/** The unfiltered first page's description, with the live count (ENG-281). */
function listDescription(total: number) {
  return `The full list of ${total.toLocaleString("en-GB")} Cambridge student societies, sports clubs and college groups, A–Z: filter by category, college and level, with every fact sourced.`
}

/** Whether a state is the plain list: no search, no filter, first page. */
function isPlainList(state: DirectoryState) {
  return !state.q && activeDirectoryFilterCount(state) === 0 && state.page <= 1
}

/** The number of listed societies for the plain list's title. Undefined when
 * it cannot be read: the title falls back to the uncounted one. */
async function listTotal(state: DirectoryState): Promise<number | undefined> {
  if (!isPlainList(state)) return undefined
  try {
    return (await publicQuery(api.orgs.facets, directoryFilters(state))).total
  } catch (error) {
    unstable_rethrow(error)
    return undefined
  }
}

/** The slug of the one college a state filters on, for its canonical (the
 * college's own page is its hub). Undefined when it cannot be read. */
async function collegeSlugOf(state: DirectoryState) {
  if (state.collegeKeys.length !== 1) return () => undefined
  try {
    const colleges = await publicQuery(api.orgs.colleges, {})
    return (key: string) => colleges.find((college) => college.key === key)?.slug
  } catch (error) {
    unstable_rethrow(error)
    return () => undefined
  }
}

/**
 * The directory's metadata (SEO audit 2026-11-02, hub-page-titles-weak,
 * directory-pagination-search-canonical, no-category-college-hubs): a title
 * that names Cambridge, each plain page its own canonical with its own title,
 * a single-category or single-college view canonical to its hub, and every
 * search, combination or re-ordering `noindex, follow`.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const state = parseDirectoryParams(await searchParams)
  const seo = directorySeo(state, await collegeSlugOf(state))
  const total = await listTotal(state)
  const title = directoryTitle(state, total)
  const description = total ? listDescription(total) : DESCRIPTION
  return {
    ...pageMetadata({ title, description, path: seo.canonical }),
    ...(seo.index ? {} : { robots: { index: false, follow: true } }),
  }
}

/** The "Busy this week" shelf. Null when it cannot be read — the page must
 * not fail over a shelf. */
async function loadBusy(): Promise<OrgBusy | null> {
  try {
    return await publicQuery(api.orgs.busy, { limit: 8 })
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

/**
 * The directory. The URL is the filter state; this server component preloads
 * the page of cards, the facet counts and the college list for it, so the
 * first paint has data, and the client follows later changes in place.
 *
 * There is no loading.tsx: the H1, the intro, the cards and the JSON-LD are
 * in the first chunk of the server's HTML, not in a hidden streamed `<div>`
 * after the footer (content-in-hidden-suspense).
 */
/** Under the directory (lib/guide-links.ts): joining, starting, the first weeks. */
const SOCIETY_GUIDES = [guide("join-a-society"), guide("start-a-society"), guide("freshers")]

export default async function SocietiesPage({ searchParams }: Props) {
  const state = parseDirectoryParams(await searchParams)
  const [preloadedList, preloadedFacets, preloadedColleges, busy] = await Promise.all([
    publicPreload(api.orgs.list, directoryListArgs(state)),
    publicPreload(api.orgs.facets, directoryFilters(state)),
    publicPreload(api.orgs.colleges, {}),
    loadBusy(),
  ])
  const unfiltered = !state.q && activeDirectoryFilterCount(state) === 0
  const total = preloadedQueryResult(preloadedFacets).total
  const seo = directorySeo(state, () => undefined)
  // An ItemList of the cards on this page, for an indexed plain page only
  // (listing-itemlist); a filtered view points at its hub, which has its own.
  const jsonLd =
    unfiltered && seo.index
      ? collectionJsonLd({
          path: seo.canonical,
          title: directoryTitle(state, isPlainList(state) ? total : undefined),
          description: isPlainList(state) && total > 0 ? listDescription(total) : DESCRIPTION,
          items: preloadedQueryResult(preloadedList).page.map((card) => ({
            name: card.name,
            path: `/societies/${card.slug}`,
          })),
          // A later page is a step below the directory, under its own URL
          // (the #breadcrumb @id is that URL's).
          crumbs: [
            { name: "Societies", path: "/societies" },
            ...(state.page > 1 ? [{ name: `Page ${state.page}`, path: seo.canonical }] : []),
          ],
          offset: (state.page - 1) * DIRECTORY_PAGE_SIZE,
          total,
        })
      : undefined

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD, `<` escaped by jsonLdScript
          dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        />
      )}
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 pt-8 pb-6 sm:px-6 sm:pt-12">
          <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
            The directory{state.page > 1 && unfiltered ? ` · page ${state.page}` : ""}
          </p>
          <h1 className="font-serif text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Cambridge societies & clubs
          </h1>
          <p className="max-w-2xl text-pretty text-muted-foreground">
            {unfiltered && total > 0
              ? `The full list of ${total.toLocaleString("en-GB")} student societies, sports clubs, theatre companies and college groups in Cambridge`
              : "University-wide and college societies, sports clubs, theatre companies and student bodies in Cambridge"}
            {" — what they do, how to join, and where every fact came from. "}
            <Link href={CATEGORIES_PATH} className="text-foreground underline underline-offset-4">
              Browse by category
            </Link>
            .
          </p>
          <FinderLink className="mt-2">
            <strong className="font-semibold">Not sure where to start?</strong> Five questions find
            your 15 best societies.
          </FinderLink>
        </div>
      </header>
      <OrgDirectory
        preloadedList={preloadedList}
        preloadedFacets={preloadedFacets}
        preloadedColleges={preloadedColleges}
        busy={busy}
      />
      <div className="mx-auto w-full max-w-7xl px-4 pt-4 pb-12 sm:px-6">
        <RelatedGuides guides={SOCIETY_GUIDES} title="Guides to societies" columns />
      </div>
    </>
  )
}
