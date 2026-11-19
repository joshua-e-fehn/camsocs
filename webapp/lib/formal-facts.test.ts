import { describe, expect, test } from "bun:test"
import { COLLEGE_INFO, type CollegeInfo, type FormalNight } from "./colleges"
import {
  busiestAndQuietest,
  collegesOn,
  hardestToTickOff,
  listNames,
  nightCounts,
  priceRange,
  priceRows,
  regularNightsPerWeek,
  tonightCounts,
} from "./formal-facts"
import { formalCollegePath } from "./formal-paths"
import { WEEK } from "./formal-week"

const base = COLLEGE_INFO[0]

function college(
  shortName: string,
  nights: Partial<FormalNight>[],
  formal: Partial<CollegeInfo["formal"]> = {},
): CollegeInfo {
  return {
    ...base,
    key: `org-${shortName}`,
    slug: shortName.toLowerCase(),
    shortName,
    formal: {
      ...base.formal,
      visitorRoute: "as_guest",
      priceGbp: null,
      ...formal,
      nights: nights.map((night) => ({
        weekday: "mon",
        kind: "formal",
        label: "Formal Hall",
        startTime: null,
        termOnly: true,
        audience: "all_members",
        frequency: "weekly",
        confidence: "found",
        notes: null,
        ...night,
      })),
    },
  }
}

describe("formal facts", () => {
  test("counts every college once per night, graduate formals included", () => {
    const list = [
      college("A", [{ weekday: "sat" }, { weekday: "sat", kind: "grad_formal", audience: "mcr" }]),
      college("B", [{ weekday: "sat" }, { weekday: "sun" }]),
    ]
    const counts = nightCounts(list)
    expect(counts.sat).toBe(2)
    expect(counts.sun).toBe(1)
    expect(counts.mon).toBe(0)
    expect(busiestAndQuietest(counts)).toEqual({ busiest: "sat", quietest: "mon" })
    expect(collegesOn(list, "sun").map((c) => c.shortName)).toEqual(["B"])
  })

  test("the real week: every night counted, Saturday's colleges named", () => {
    const counts = nightCounts(COLLEGE_INFO)
    for (const day of WEEK) expect(counts[day]).toBe(collegesOn(COLLEGE_INFO, day).length)
  })

  test("prices: cheapest guest price first, a member-only price placed by itself", () => {
    const price = (guest: number | null, student: number | null) => ({
      guest,
      student,
      asOf: null,
      sourceUrl: null,
      note: null,
    })
    const rows = priceRows([
      college("Dear", [], { priceGbp: price(30, 20) }),
      college("Cheap", [], { priceGbp: price(15, 10) }),
      college("Member", [], { priceGbp: price(null, 18) }),
      college("None", [], { priceGbp: null }),
    ])
    expect(rows.map((row) => row.college.shortName)).toEqual(["Cheap", "Member", "Dear"])
    expect(rows[1].memberOnly).toBe(true)
    expect(priceRange(rows, "guest")).toEqual({ min: 15, max: 30 })
    expect(priceRange(rows, "student")).toEqual({ min: 10, max: 20 })
  })

  test("hardest to tick off: one regular night a week or fewer, or no visitor route", () => {
    const list = [
      college("Busy", [{ weekday: "mon" }, { weekday: "fri" }]),
      college("Once", [{ weekday: "thu" }]),
      college("Monthly", [{ weekday: "fri", frequency: "first_of_month" }]),
      college("Closed", [{ weekday: "mon" }, { weekday: "tue" }], { visitorRoute: "unknown" }),
      college("Grad", [{ weekday: "mon" }, { weekday: "tue", kind: "grad_formal" }]),
    ]
    expect(regularNightsPerWeek(list[2])).toBe(0.25)
    expect(hardestToTickOff(list).map((c) => c.shortName)).toEqual([
      "Monthly",
      "Grad",
      "Once",
      "Closed",
    ])
  })

  test("names read as a list", () => {
    expect(listNames([])).toBe("")
    expect(listNames(["A"])).toBe("A")
    expect(listNames(["A", "B", "C"])).toBe("A, B and C")
  })

  test("a college's formal page path", () => {
    expect(formalCollegePath("peterhouse")).toBe("/formals/peterhouse")
  })
})

describe("tonightCounts", () => {
  test("splits weekly formals from occasional ones", () => {
    const counts = tonightCounts(COLLEGE_INFO)
    // Murray Edwards' Friday runs on the first Friday of the month only.
    const fri = counts.fri
    expect(fri.weekly + fri.occasional).toBe(nightCounts(COLLEGE_INFO).fri)
    expect(fri.occasional).toBeGreaterThan(0)
  })
})
