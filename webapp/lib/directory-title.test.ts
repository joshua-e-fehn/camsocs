import { describe, expect, test } from "bun:test"
import {
  categoryHubTitle,
  collegeHubTitle,
  DIRECTORY_TITLE,
  directoryTitle,
  fitTitle,
  MAX_TITLE,
  titleBase,
  titleText,
} from "./directory-title"
import { CATEGORIES } from "./vocab"

test("the directory's title names Cambridge, a query, a single category or the page", () => {
  expect(directoryTitle({ q: "chess", categories: ["sport"] })).toBe(
    "“chess” — Cambridge societies and clubs",
  )
  expect(directoryTitle({ categories: ["sport"] })).toBe("Sport & Fitness clubs in Cambridge")
  expect(directoryTitle({ categories: ["sport", "music"] })).toBe(DIRECTORY_TITLE)
  expect(directoryTitle({ categories: [], page: 3 })).toBe("Cambridge societies & clubs, page 3")
  expect(DIRECTORY_TITLE).toContain("Cambridge")
  expect(DIRECTORY_TITLE).not.toMatch(/University of Cambridge/)
})

describe("fitTitle (owner decision G2)", () => {
  test("keeps the template while the whole title fits in 60 characters", () => {
    expect(fitTitle("Chess Club, Cambridge")).toBe("Chess Club, Cambridge")
    expect(titleText(fitTitle("Chess Club, Cambridge"))).toBe("Chess Club, Cambridge · CAMsocs")
  })

  test("drops ' · CAMsocs' when it would overflow", () => {
    const long = "Cambridge University Hindu Cultural Society Association"
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE)
    expect(fitTitle(long)).toEqual({ absolute: long })
    expect(titleText(fitTitle(long))).toBe(long)
    expect(titleBase(fitTitle(long))).toBe(long)
    expect(titleBase(fitTitle("Short"))).toBe("Short")
  })
})

test("every hub title names Cambridge and fits in 60 characters", () => {
  for (const category of CATEGORIES) {
    const title = titleText(fitTitle(categoryHubTitle(category)))
    expect(title).toContain("Cambridge")
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE)
  }
  expect(collegeHubTitle("Christ's College")).toBe(
    "Societies and clubs at Christ's College, Cambridge",
  )
  expect(collegeHubTitle("Cambridge Union")).toBe("Societies and clubs at Cambridge Union")
  expect(categoryHubTitle("music")).toBe("Music societies in Cambridge")
})
