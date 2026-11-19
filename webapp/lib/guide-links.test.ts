import { describe, expect, test } from "bun:test"
import { dynamicPrefetch } from "./crawl-traps"
import { GUIDE_PAGE_LINKS, HOME_GUIDES, matchGuidePages, RELATED_GUIDES } from "./guide-links"
import { GUIDES } from "./guides"
import { PAGE_PATHS } from "./sitemap"

describe("guide links", () => {
  test("every guide has three related guides, none itself, no repeats", () => {
    for (const entry of GUIDES) {
      const related = RELATED_GUIDES[entry.slug]
      expect(related.length).toBe(3)
      expect(related).not.toContain(entry.slug)
      expect(new Set(related).size).toBe(related.length)
    }
  })

  test("every guide is related from at least one other guide", () => {
    const linked = new Set(Object.values(RELATED_GUIDES).flat())
    for (const entry of GUIDES) expect(linked.has(entry.slug)).toBe(true)
  })

  test("the home page lists six different guides", () => {
    expect(HOME_GUIDES.length).toBe(6)
    expect(new Set(HOME_GUIDES.map((entry) => entry.slug)).size).toBe(6)
  })

  test("the palette's rows: every guide, unique, all in pages.xml, none dynamic or under /talks", () => {
    const hrefs = GUIDE_PAGE_LINKS.map((link) => link.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const entry of GUIDES) expect(hrefs).toContain(entry.path)
    for (const href of hrefs) {
      // /categories is listed by the categories sitemap, not pages.xml.
      expect([...PAGE_PATHS, "/categories"]).toContain(href)
      expect(dynamicPrefetch(href)).toBeUndefined()
      expect(href.startsWith("/talks")).toBe(false)
    }
  })

  test("a query matches by title, summary or the extra words", () => {
    expect(matchGuidePages("bumps", 5).map((link) => link.href)).toContain("/guides/rowing")
    expect(matchGuidePages("mcr", 5).map((link) => link.href)).toContain("/colleges")
    expect(matchGuidePages("Formal", 10).map((link) => link.href)).toEqual(
      expect.arrayContaining(["/guides/formal-hall", "/formals", "/formals/tracker"]),
    )
    expect(matchGuidePages("may ball", 5)[0]?.href).toBe("/guides/may-balls")
  })

  test("an empty query matches nothing, and the limit holds", () => {
    expect(matchGuidePages("  ", 5)).toEqual([])
    expect(matchGuidePages("cambridge", 3).length).toBeLessThanOrEqual(3)
  })
})
