import { describe, expect, test } from "bun:test"
import { COLLEGE_INFO } from "./colleges"
import {
  formalCollegeBySlug,
  formalCollegeDescription,
  formalCollegeTitle,
  formalDays,
  formalSourceUrls,
  nightsSummary,
} from "./formal-college-page"
import { FORMAL_TRACKER_PATH, formalCollegePath } from "./formal-paths"
import { MAX_DESCRIPTION_LENGTH, metaDescription } from "./page-metadata"
import { MAX_TITLE_LENGTH } from "./site"

describe("a college's formal hall page", () => {
  test("every college has a page, none clashing with /formals/tracker", () => {
    expect(COLLEGE_INFO).toHaveLength(31)
    const paths = COLLEGE_INFO.map((college) => formalCollegePath(college.slug))
    expect(new Set(paths).size).toBe(31)
    expect(paths).not.toContain(FORMAL_TRACKER_PATH)
    expect(formalCollegeBySlug("kings-college")?.shortName).toBe("King’s")
    expect(formalCollegeBySlug("tracker")).toBeUndefined()
  })

  test("titles fit 60 characters and descriptions say the nights", () => {
    for (const college of COLLEGE_INFO) {
      const title = formalCollegeTitle(college)
      expect(title.startsWith(`${college.shortName} formal hall: nights, price`)).toBe(true)
      expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      const description = formalCollegeDescription(college)
      // Whole, never cut short by `metaDescription`.
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(metaDescription(description)).toBe(description)
      expect(description).toContain(nightsSummary(college))
    }
  })

  test("nights read from the data", () => {
    const kings = formalCollegeBySlug("kings-college")
    if (!kings) throw new Error("King's")
    expect(nightsSummary(kings)).toBe("Wednesday at 19:30")
    expect(formalDays(kings)).toEqual(["wed"])
    const trinity = formalCollegeBySlug("trinity-college")
    if (!trinity) throw new Error("Trinity")
    expect(nightsSummary(trinity)).toBe(
      "Thursday and Saturday at 20:00, and a graduate formal on Friday",
    )
    const edmunds = formalCollegeBySlug("st-edmunds-college")
    if (!edmunds) throw new Error("St Edmund's")
    expect(nightsSummary(edmunds)).toBe("Tuesday and Friday at 19:30")
    // A night that is not weekly says how often it runs.
    const murray = formalCollegeBySlug("murray-edwards-college")
    if (!murray) throw new Error("Murray Edwards")
    expect(nightsSummary(murray)).toBe("Tuesday and Friday (first Friday of the month) at 19:00")
  })

  test("sources are deduplicated and lead with the college's own page", () => {
    for (const college of COLLEGE_INFO) {
      const urls = formalSourceUrls(college)
      expect(new Set(urls).size).toBe(urls.length)
      const listed = new Set(college.formal.nightsSources.map((source) => source.url))
      if (!listed.has(college.formal.primarySourceUrl)) {
        expect(urls[0]).toBe(college.formal.primarySourceUrl)
      }
    }
  })
})
