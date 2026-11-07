import { describe, expect, test } from "bun:test"
import { GUIDES, guideJsonLd } from "./guides"
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "./page-metadata"
import { PAGE_PATHS } from "./sitemap"

describe("the guides", () => {
  test("titles and descriptions fit a search result", () => {
    for (const entry of GUIDES) {
      expect(entry.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      expect(entry.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    }
  })

  test("every guide is in the sitemap", () => {
    for (const entry of GUIDES) expect(PAGE_PATHS as readonly string[]).toContain(entry.path)
  })

  test("the JSON-LD is an Article citing its sources, published by CAMsocs' publisher", () => {
    const [entry] = GUIDES
    const source = {
      publisher: "A",
      title: "B",
      url: "https://example.org/",
      retrieved: "2026-11-07",
    }
    const graph = guideJsonLd(entry, [source, source])["@graph"] as Record<string, unknown>[]
    expect(graph[0]["@type"]).toBe("Article")
    expect(graph[0].citation).toEqual(["https://example.org/"])
    expect(graph[1]["@type"]).toBe("BreadcrumbList")
  })
})
