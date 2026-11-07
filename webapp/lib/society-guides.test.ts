import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SOCIETY_SOURCES, societyGuideSources } from "./society-guides"

const page = (slug: string) =>
  readFileSync(
    path.join(import.meta.dir, "..", "app", "(site)", "guides", slug, "page.tsx"),
    "utf8",
  )

describe("the society guides", () => {
  for (const slug of ["join-a-society", "start-a-society"] as const) {
    test(`${slug} has no draft notes and cites every source it lists`, () => {
      const source = page(slug)
      expect(source).not.toMatch(/EditorNote|REVIEW_NOTES|\[Joshua|guidesInReview/)
      const listed = societyGuideSources(slug)
      const ids = Object.entries(SOCIETY_SOURCES)
        .filter(([, s]) => listed.includes(s))
        .map(([id]) => id)
      const uncited = ids.filter(
        (id) => !source.includes(`SOCIETY_SOURCES["${id}"]`) && !source.includes(`"${id}"`),
      )
      expect(uncited).toEqual([])
    })
  }

  test("every source is an https page with a read date", () => {
    for (const s of Object.values(SOCIETY_SOURCES)) {
      expect(s.url).toStartWith("https://")
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
