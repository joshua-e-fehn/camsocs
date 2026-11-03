import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { CATEGORIES_PATH, categoryHubPaths } from "./directory-hubs"
import { readAllPages, type SitemapEntry } from "./sitemap"

/**
 * The societies file of the sitemap index (`/sitemaps/societies.xml`,
 * lib/sitemap.ts; SEO audit 2026-11-02):
 *  - the category hubs and their index (no-category-college-hubs, G13);
 *  - every directory listing worth indexing (thin-empty-profiles, G3: a
 *    profile with no description, no public event and no website is
 *    `noindex` and left out) with when it last changed
 *    (sitemap-dynamic-no-lastmod);
 *  - each college's own page, which is its hub, unless it lists nobody
 *    (college-counterpart-pages).
 * `orgs.sitemap` judges thinness on the same guarded projection the profile
 * renders (`isThinListing`), so the file never lists a URL the page marks
 * noindex. Nothing under /talks, and no talks.cam URL (G1): these are
 * CAMsocs paths.
 */

export type SocietySitemapPage = FunctionReturnType<typeof api.orgs.sitemap>
type SitemapRow = SocietySitemapPage["page"][number]

/** Rows per `orgs.sitemap` call (its maximum). */
const PAGE = 100
/** Far above the directory's size (~1,500 groups); a stop, not a target. */
const MAX_PAGES = 50

/** The hub pages: always listed (they exist whatever the data). */
export function hubSitemapEntries(): SitemapEntry[] {
  return [{ path: CATEGORIES_PATH }, ...categoryHubPaths().map((path) => ({ path }))]
}

/** Entries for `orgs.sitemap` rows: the indexable ones only. */
export function societyEntries(rows: readonly SitemapRow[]): SitemapEntry[] {
  return rows
    .filter((row) => row.indexable)
    .map((row) => ({ path: `/societies/${row.slug}`, lastModified: row.updatedAt }))
}

/**
 * Every society entry: the hubs, then each indexable listing and college
 * page, read page by page with `read` (`fetchQuery(api.orgs.sitemap, args)`
 * in app/sitemaps/[file]; injected so this stays testable without a
 * backend). A failed read throws, so the route answers 503 rather than a
 * partial file a crawler would take as the whole directory.
 */
export async function loadSocietySitemap(
  read: (args: { cursor?: string; numItems: number }) => Promise<SocietySitemapPage>,
): Promise<SitemapEntry[]> {
  const rows = await readAllPages(
    (cursor) => read({ cursor: cursor ?? undefined, numItems: PAGE }),
    MAX_PAGES,
  )
  return [...hubSitemapEntries(), ...societyEntries(rows)]
}
