import { SITEMAP_FILES, sitemapIndexXml, xmlResponse } from "@/lib/sitemap"

/**
 * `GET /sitemap.xml` — the sitemap index (lib/sitemap.ts): the site's pages,
 * the society profiles and the events, each its own file under /sitemaps/.
 * The URL robots.txt names and search consoles already know.
 */

export const dynamic = "force-dynamic"

export function GET(): Response {
  return xmlResponse(sitemapIndexXml(SITEMAP_FILES))
}
