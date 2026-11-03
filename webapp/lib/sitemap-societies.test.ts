import { describe, expect, test } from "bun:test"
import {
  hubSitemapEntries,
  loadSocietySitemap,
  type SocietySitemapPage,
  societyEntries,
} from "./sitemap-societies"
import { CATEGORIES } from "./vocab"

const row = (slug: string, overrides: Partial<SocietySitemapPage["page"][number]> = {}) => ({
  slug,
  kind: "listing" as const,
  updatedAt: Date.UTC(2026, 10, 1),
  indexable: true,
  ...overrides,
})

describe("society sitemap entries", () => {
  test("the category index and one hub per category", () => {
    const paths = hubSitemapEntries().map((entry) => entry.path)
    expect(paths[0]).toBe("/categories")
    expect(paths).toHaveLength(CATEGORIES.length + 1)
    expect(paths).toContain("/categories/science-tech")
  })

  test("indexable listings and college hubs with lastModified; thin ones left out (G3)", () => {
    const entries = societyEntries([
      row("chess"),
      row("empty", { indexable: false }),
      row("example-college", { kind: "college" }),
    ])
    expect(entries).toEqual([
      { path: "/societies/chess", lastModified: Date.UTC(2026, 10, 1) },
      { path: "/societies/example-college", lastModified: Date.UTC(2026, 10, 1) },
    ])
  })

  test("never a /talks URL or a talks.cam link (G1)", () => {
    const all = [...hubSitemapEntries(), ...societyEntries([row("chess")])]
    for (const entry of all) {
      expect(entry.path).not.toContain("/talks")
      expect(entry.path).not.toContain("talks.cam")
    }
  })
})

describe("loadSocietySitemap", () => {
  test("reads page by page until done", async () => {
    const calls: (string | undefined)[] = []
    const entries = await loadSocietySitemap(async ({ cursor }) => {
      calls.push(cursor)
      return cursor === undefined
        ? { page: [row("a")], isDone: false, continueCursor: "1" }
        : { page: [row("b")], isDone: true, continueCursor: "2" }
    })
    expect(calls).toEqual([undefined, "1"])
    expect(entries.filter((entry) => entry.path.startsWith("/societies/"))).toHaveLength(2)
  })

  test("a failing backend throws (the route answers 503, never a partial file)", async () => {
    let first = true
    const read = async () => {
      if (!first) throw new Error("down")
      first = false
      return { page: [row("a")], isDone: false, continueCursor: "1" }
    }
    await expect(loadSocietySitemap(read)).rejects.toThrow("down")
  })
})
