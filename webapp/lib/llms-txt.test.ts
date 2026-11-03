import { expect, test } from "bun:test"
import { llmsTxt } from "./llms-txt"
import { DISCLAIMER, SITE_URL } from "./site"

const text = llmsTxt()

test("follows llmstxt.org: a title, a summary, then sections of links", () => {
  expect(text.startsWith("# CAMsocs\n\n> ")).toBe(true)
  expect(text).toContain("\n## Pages\n")
  expect(text).toContain(`- [Societies and clubs](${SITE_URL}/societies): `)
  expect(text).toContain(`- [Events](${SITE_URL}/events): `)
  expect(text).toContain(`- [About CAMsocs](${SITE_URL}/about): `)
})

test("says CAMsocs is unofficial", () => {
  expect(text).toContain(DISCLAIMER)
})

test("never points an agent at the talks pillar or talks.cam (G1)", () => {
  expect(text).not.toMatch(/\/talks/i)
  expect(text).not.toMatch(/talks\.cam/i)
  expect(text).not.toMatch(/\btalks?\b/i)
})

test("links every category hub (G13)", () => {
  expect(text).toContain("\n## Societies by category\n")
  expect(text).toContain(`(${SITE_URL}/categories)`)
  expect(text).toContain(`(${SITE_URL}/categories/science-tech)`)
})
