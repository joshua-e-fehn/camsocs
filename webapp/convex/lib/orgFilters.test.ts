import { describe, expect, test } from "bun:test"
import type { Doc } from "../_generated/dataModel"
import { facetCounts, matches, selections } from "./orgFilters"

type Card = Parameters<typeof matches>[0]

function card(overrides: Partial<Doc<"orgCards">> = {}): Card {
  return {
    categories: [],
    level: "university",
    orgType: "society",
    collegeKeys: [],
    activityTypes: [],
    audiences: [],
    status: "active",
    isCounterpart: false,
    ...overrides,
  }
}

const music = card({ categories: ["music"] })
const theatre = card({ categories: ["theatre_film_dance"], activityTypes: ["performances"] })
const rowing = card({
  categories: ["sport"],
  orgType: "college_boat_club",
  level: "college",
  collegeKeys: ["org-jesus-college"],
  beginnerFriendly: true,
  sport: { blueStatus: "none", genderCategories: ["men", "women"] },
})
const archived = card({ categories: ["music"], status: "archived" })
const college = card({ orgType: "college", isCounterpart: true })

describe("matches", () => {
  test("OR within a facet, AND across facets", () => {
    const either = selections({ categories: ["music", "theatre_film_dance"] })
    expect([music, theatre, rowing].map((c) => matches(c, either))).toEqual([true, true, false])
    const both = selections({ categories: ["theatre_film_dance"], activityTypes: ["talks"] })
    expect(matches(theatre, both)).toBe(false)
  })

  test("archived is hidden unless asked for; counterparts are never listed", () => {
    expect(matches(archived, selections({}))).toBe(false)
    expect(matches(archived, selections({ statuses: ["archived"] }))).toBe(true)
    expect(matches(college, selections({}))).toBe(false)
  })

  test("sport filters", () => {
    expect(matches(rowing, selections({ sport: { beginnerFriendly: true } }))).toBe(true)
    expect(matches(music, selections({ sport: { beginnerFriendly: true } }))).toBe(false)
    expect(matches(rowing, selections({ sport: { gender: ["women"] } }))).toBe(true)
    expect(matches(rowing, selections({ sport: { blueStatus: ["full"] } }))).toBe(false)
    expect(matches(rowing, selections({ collegeKeys: ["org-jesus-college"] }))).toBe(true)
  })

  test("an empty selection does not filter", () => {
    expect(matches(music, selections({ categories: [], levels: [] }))).toBe(true)
  })
})

describe("facetCounts", () => {
  test("counts are disjunctive: a facet ignores its own selection", () => {
    const counts = facetCounts([music, theatre, rowing, archived, college], {
      categories: ["music"],
    })
    expect(counts.total).toBe(1)
    // Category counts ignore the category selection (archived and the
    // counterpart are still excluded by their own rules).
    expect(counts.categories).toEqual({ music: 1, theatre_film_dance: 1, sport: 1 })
    // Other facets are counted within the music selection.
    expect(counts.levels).toEqual({ university: 1 })
    expect(counts.statuses).toEqual({ active: 1, archived: 1 })
  })
})
