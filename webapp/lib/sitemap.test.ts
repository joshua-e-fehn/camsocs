import { describe, expect, test } from "bun:test"
import {
  isSitemapFile,
  PAGE_PATHS,
  readAllPages,
  SITEMAP_FILES,
  sitemapIndexXml,
  sitemapXml,
} from "./sitemap"

/** The sitemap files' XML and the page walk behind them. */

describe("sitemapXml", () => {
  test("one <url> per entry, absolute and escaped, with lastmod when known", () => {
    const xml = sitemapXml([
      { path: "/" },
      { path: "/societies/chess", lastModified: Date.UTC(2026, 10, 2, 9) },
      { path: "/events?org=a&b" },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset')).toBe(true)
    expect(xml).toContain("<url><loc>https://camsocs.uk</loc></url>")
    expect(xml).toContain(
      "<url><loc>https://camsocs.uk/societies/chess</loc><lastmod>2026-11-02T09:00:00.000Z</lastmod></url>",
    )
    expect(xml).toContain("<loc>https://camsocs.uk/events?org=a&amp;b</loc>")
    expect(xml).not.toContain("changefreq")
  })

  test("the index lists the three files under /sitemaps/", () => {
    const xml = sitemapIndexXml(SITEMAP_FILES)
    expect(xml).toContain("<sitemapindex")
    for (const file of ["pages.xml", "societies.xml", "events.xml"]) {
      expect(xml).toContain(`<sitemap><loc>https://camsocs.uk/sitemaps/${file}</loc></sitemap>`)
    }
    expect(isSitemapFile("events.xml")).toBe(true)
    expect(isSitemapFile("talks.xml")).toBe(false)
  })

  test("the pages file never lists a talk or a talks.cam-derived event (G1)", () => {
    for (const path of PAGE_PATHS) expect(path).not.toMatch(/^\/talks\/(?!departments$)/)
  })
})

describe("readAllPages", () => {
  test("walks every page in order", async () => {
    const pages: Record<string, { page: number[]; isDone: boolean; continueCursor: string }> = {
      start: { page: [1, 2], isDone: false, continueCursor: "b" },
      b: { page: [3], isDone: true, continueCursor: "" },
    }
    const cursors: (string | null)[] = []
    const rows = await readAllPages(async (cursor) => {
      cursors.push(cursor)
      return pages[cursor ?? "start"]
    })
    expect(rows).toEqual([1, 2, 3])
    expect(cursors).toEqual([null, "b"])
  })

  test("a failed page fails the whole walk: never a partial sitemap", async () => {
    let calls = 0
    const walk = readAllPages(async () => {
      calls++
      if (calls === 2) throw new Error("Convex unreachable")
      return { page: [calls], isDone: false, continueCursor: String(calls) }
    })
    await expect(walk).rejects.toThrow("Convex unreachable")
  })
})
