import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { NAV } from "@/components/organisms/public-header"
import { COLUMNS } from "@/components/organisms/site-footer"
import { ROUTE_INDEXING, routeOfPageFile } from "./route-indexing"
import { PAGE_PATHS } from "./sitemap"

/**
 * The indexing guard (lib/route-indexing.ts): every page route of the public
 * site has a sitemap (or a stated reason for none), every single page in
 * pages.xml is linked from the header, the footer or a named page, and
 * pages.xml lists exactly those pages. A new page.tsx fails here until it
 * has an entry.
 */

const SITE_DIR = join(import.meta.dir, "..", "app", "(site)")

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pageFiles(path)
    return entry.name === "page.tsx" ? [relative(SITE_DIR, path)] : []
  })
}

const ROUTES = pageFiles(SITE_DIR).map(routeOfPageFile).sort()

describe("route indexing", () => {
  test("routeOfPageFile drops route groups", () => {
    expect(routeOfPageFile("page.tsx")).toBe("/")
    expect(routeOfPageFile("talks/(agenda)/page.tsx")).toBe("/talks")
    expect(routeOfPageFile("societies/[slug]/page.tsx")).toBe("/societies/[slug]")
  })

  test("every page route says how it is indexed, and every entry is a real route", () => {
    expect(ROUTES.length).toBeGreaterThan(10)
    const missing = ROUTES.filter((route) => !(route in ROUTE_INDEXING))
    // A new page: add it to lib/route-indexing.ts (and PAGE_PATHS if it is one URL).
    expect(missing).toEqual([])
    expect(Object.keys(ROUTE_INDEXING).filter((route) => !ROUTES.includes(route))).toEqual([])
  })

  test("pages.xml lists exactly the single pages marked for it", () => {
    const marked = Object.entries(ROUTE_INDEXING)
      .filter(([, how]) => "sitemap" in how && how.sitemap === "pages.xml")
      .map(([route]) => route)
      .sort()
    expect(([...PAGE_PATHS] as string[]).sort()).toEqual(marked)
    for (const route of marked) expect(route).not.toContain("[")
  })

  test("every single page is linked from the header, the footer or a page that is", () => {
    const footer = new Set<string>(
      COLUMNS.flatMap((column) => column.links.map((link) => link.href)),
    )
    const header = new Set<string>(["/", ...NAV.map((item) => item.href)])
    const linked = (route: string, seen: string[] = []): boolean => {
      const how = ROUTE_INDEXING[route]
      if (!how || !("linkedFrom" in how) || seen.includes(route)) return false
      if (how.linkedFrom === "footer") return footer.has(route)
      if (how.linkedFrom === "header") return header.has(route)
      return linked(how.linkedFrom.slice("page:".length), [...seen, route])
    }
    const unlinked = PAGE_PATHS.filter((path) => !linked(path))
    expect(unlinked).toEqual([])
  })
})
