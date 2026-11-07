import { SITE_URL } from "./site"

/**
 * The sitemaps (SEO audit "sitemap-dynamic-no-lastmod",
 * "events-orphaned-no-sitemap"): `/sitemap.xml` is an index of three files
 * under `/sitemaps/`, each written here as the Sitemaps XML protocol — the
 * site's own pages, the society profiles and the events' pages — with a
 * `lastmod` wherever the data has an honest one. (Google ignores
 * `changefreq` and `priority`, so they are left out.)
 *
 * Route handlers rather than `app/sitemap.ts`: they set the edge cache
 * (`SITEMAP_CACHE`) and answer a backend failure with a 503, so a crawler
 * keeps its last good copy instead of a partial list.
 */

export type SitemapEntry = { path: string; lastModified?: number }

/** The site's own pages, each canonical and indexable; the societies and
 * events files hold the rest. The talks pillar's two hubs are URLs only
 * (classic search may index them; robots.txt keeps AI agents out); a talk's
 * page and a talks.cam-derived event's are never listed (owner decision G1).
 * The category hubs go with the societies file (lib/sitemap-societies.ts). */
export const PAGE_PATHS = [
  "/",
  "/societies",
  "/events",
  "/talks",
  "/talks/departments",
  "/term-dates",
  "/guides",
  "/guides/join-a-society",
  "/guides/start-a-society",
  "/about",
  "/privacy",
  "/terms",
  "/request",
] as const

/** The child files, in the index's order. */
export const SITEMAP_FILES = ["pages.xml", "societies.xml", "events.xml"] as const
export type SitemapFile = (typeof SITEMAP_FILES)[number]

export function isSitemapFile(name: string): name is SitemapFile {
  return (SITEMAP_FILES as readonly string[]).includes(name)
}

/** An hour at the edge, then a day of the stale copy while it refreshes:
 * the directory changes with each harvest, and a sitemap read costs Convex
 * a page walk. */
export const SITEMAP_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400"

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function absolute(path: string): string {
  return `${SITE_URL}${path === "/" ? "" : path}`
}

/** A `<urlset>`, one `<url>` per entry. */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lastmod =
      entry.lastModified === undefined
        ? ""
        : `<lastmod>${new Date(entry.lastModified).toISOString()}</lastmod>`
    return `<url><loc>${escapeXml(absolute(entry.path))}</loc>${lastmod}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`
}

/** The `<sitemapindex>` of the child files. */
export function sitemapIndexXml(files: readonly string[]): string {
  const items = files.map(
    (file) => `<sitemap><loc>${escapeXml(absolute(`/sitemaps/${file}`))}</loc></sitemap>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("\n")}\n</sitemapindex>\n`
}

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string }

/** Every row of a paginated query, page by page; a failed page throws (the
 * caller answers 503, never a partial list). `maxPages` is a stop, not a
 * target. */
export async function readAllPages<T>(
  read: (cursor: string | null) => Promise<Page<T>>,
  maxPages = 100,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const result: Page<T> = await read(cursor)
    rows.push(...result.page)
    if (result.isDone) return rows
    cursor = result.continueCursor
  }
  return rows
}

export function xmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": SITEMAP_CACHE },
  })
}

/** A backend failure: crawlers retry later and keep their last good copy. */
export function unavailable(): Response {
  return new Response("The sitemap could not be read just now. Try again later.", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "600",
    },
  })
}
