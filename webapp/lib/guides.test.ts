import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PUBLIC_PATHS } from "./auth-routes"
import {
  GUIDES,
  GUIDES_DESCRIPTION,
  GUIDES_PATH,
  GUIDES_TITLE,
  guideJsonLd,
  REVIEW_NOTES,
  SOURCES,
} from "./guides"
import { llmsTxt } from "./llms-txt"
import { MAX_DESCRIPTION_LENGTH, pageMetadata } from "./page-metadata"
import { DISCLAIMER, MAX_TITLE_LENGTH, TITLE_SUFFIX } from "./site"
import { PAGE_PATHS } from "./sitemap"
import { PUBLISHER_ID, WEBSITE_ID } from "./structured-data"

/** The guides (lib/guides.ts) and their pages under app/(site)/guides. */

const WEBAPP = path.join(import.meta.dir, "..")
const pageFile = (slug: string) =>
  readFileSync(path.join(WEBAPP, "app", "(site)", "guides", slug, "page.tsx"), "utf8")

/** The ids a page's source names with `<Tag id="…" />` (or `id={…}` left out). */
function ids(source: string, tag: string): string[] {
  return [...source.matchAll(new RegExp(`<${tag} id="([^"]+)"`, "g"))].map((match) => match[1])
}

describe("review gate", () => {
  // The guides were drafted from public sources for Joshua to review. This
  // test fails until every note is resolved: fix the text, delete the
  // `<EditorNote id>` from the page and the entry from REVIEW_NOTES.
  test("no review note is open (resolve every [Joshua: …] before merging)", () => {
    expect(REVIEW_NOTES.map((note) => `${note.guide}: ${note.id}`)).toEqual([])
  })

  for (const entry of GUIDES) {
    test(`${entry.slug}: its page and REVIEW_NOTES name the same notes`, () => {
      const onPage = ids(pageFile(entry.slug), "EditorNote").sort()
      const listed = REVIEW_NOTES.filter((note) => note.guide === entry.slug)
        .map((note) => note.id)
        .sort()
      expect(onPage).toEqual(listed)
    })
  }

  test("note ids are unique", () => {
    const all = REVIEW_NOTES.map((note) => note.id)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("sources", () => {
  for (const entry of GUIDES) {
    test(`${entry.slug}: every source it cites is in its source list, and every listed one is cited`, () => {
      const source = pageFile(entry.slug)
      const cited = new Set(ids(source, "Cite"))
      // The deadline table cites through its rows' `source`.
      for (const match of source.matchAll(/source: "([^"]+)"/g)) cited.add(match[1])
      expect([...cited].sort()).toEqual([...new Set(entry.sources)].sort())
    })
  }

  test("every source is an https URL, read on a real date", () => {
    for (const [id, source] of Object.entries(SOURCES)) {
      expect([id, source.url.startsWith("https://")]).toEqual([id, true])
      expect([id, /^\d{4}-\d{2}-\d{2}$/.test(source.retrieved)]).toEqual([id, true])
    }
  })

  test("never links the St John's JCR domain (it now redirects to an unrelated site)", () => {
    for (const source of Object.values(SOURCES)) expect(source.url).not.toContain("sjc-jcr.com")
    for (const entry of GUIDES) expect(pageFile(entry.slug)).not.toContain("sjc-jcr.com")
  })

  test("never cites talks.cam (its content never reaches a model)", () => {
    for (const source of Object.values(SOURCES)) expect(source.url).not.toContain("talks.cam")
  })
})

describe("SEO", () => {
  const pages = [
    { title: GUIDES_TITLE, description: GUIDES_DESCRIPTION, path: GUIDES_PATH },
    ...GUIDES,
  ]
  for (const page of pages) {
    test(`${page.path}: the whole <title> fits in ${MAX_TITLE_LENGTH} characters`, () => {
      expect((page.title + TITLE_SUFFIX).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      expect(pageMetadata(page).title).toBe(page.title)
    })
    test(`${page.path}: the description is not cut short`, () => {
      expect(page.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    })
    test(`${page.path}: is in the sitemap and public`, () => {
      expect(PAGE_PATHS as readonly string[]).toContain(page.path)
      expect(PUBLIC_PATHS as readonly string[]).toContain(GUIDES_PATH)
    })
    test(`${page.path}: is in llms.txt`, () => {
      expect(llmsTxt()).toContain(page.path)
    })
  }

  for (const entry of GUIDES) {
    test(`${entry.slug}: an Article by CAMsocs' publisher, with breadcrumbs`, () => {
      const graph = guideJsonLd(entry)["@graph"] as Record<string, unknown>[]
      const article = graph.find((node) => node["@type"] === "Article")
      expect(article).toMatchObject({
        headline: entry.title,
        author: { "@id": PUBLISHER_ID },
        publisher: { "@id": PUBLISHER_ID },
        isPartOf: { "@id": WEBSITE_ID },
        inLanguage: "en-GB",
      })
      expect(String(article?.description)).toContain(DISCLAIMER)
      const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList")
      expect(crumbs?.itemListElement).toHaveLength(2)
      // Neither HowTo nor FAQPage (retired / restricted rich results).
      expect(JSON.stringify(graph)).not.toMatch(/"HowTo"|"FAQPage"/)
      // No affiliation is ever implied (AGENTS.md).
      expect(JSON.stringify(graph)).not.toMatch(/parentOrganization|memberOf|affiliation/)
    })
  }
})

describe("unofficial", () => {
  for (const entry of GUIDES) {
    test(`${entry.slug}: never speaks as the University or the SU`, () => {
      const source = pageFile(entry.slug)
      expect(source).not.toMatch(/\b(?:our|we at) (?:University|SU|college)\b/i)
      expect(source).not.toMatch(/official guide/i)
    })
  }
})
