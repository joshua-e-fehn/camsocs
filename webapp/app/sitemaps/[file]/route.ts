import { fetchQuery } from "convex/nextjs"
import type { NextRequest } from "next/server"
import { api } from "@/convex/_generated/api"
import {
  isSitemapFile,
  PAGE_PATHS,
  readAllPages,
  type SitemapEntry,
  sitemapXml,
  unavailable,
  xmlResponse,
} from "@/lib/sitemap"
import { loadSocietySitemap } from "@/lib/sitemap-societies"

/**
 * `GET /sitemaps/<file>` — one file of the sitemap index (lib/sitemap.ts):
 *  - `pages.xml`: the site's own pages;
 *  - `societies.xml`: the category hubs, every listing the directory shows
 *    but thin ones (owner decision G3) and each college's hub page, with
 *    when it last changed (lib/sitemap-societies.ts, `orgs.sitemap`);
 *  - `events.xml`: every public event from today on, never a talks.cam-
 *    derived one (G1), with when it last changed (`sitemap.events`).
 * Rendered per request (a build has no data) and cached at the edge; a
 * backend failure is a 503, never a partial file.
 */

export const dynamic = "force-dynamic"

const PAGE = 200

async function entries(file: string): Promise<SitemapEntry[]> {
  switch (file) {
    case "pages.xml":
      return PAGE_PATHS.map((path) => ({ path }))
    case "societies.xml":
      return loadSocietySitemap((args) => fetchQuery(api.orgs.sitemap, args))
    default: {
      const rows = await readAllPages((cursor) =>
        fetchQuery(api.sitemap.events, { paginationOpts: { numItems: PAGE, cursor } }),
      )
      return rows.map((row) => ({ path: `/events/${row.key}`, lastModified: row.updatedAt }))
    }
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params
  if (!isSitemapFile(file)) return new Response("Not a sitemap.", { status: 404 })
  try {
    return xmlResponse(sitemapXml(await entries(file)))
  } catch (error) {
    console.error(`sitemap ${file} failed`, error)
    return unavailable()
  }
}
