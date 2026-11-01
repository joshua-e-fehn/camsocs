import { describe, expect, test } from "bun:test"
import { availablePresets, currentTermEnd, presetRange } from "./date-presets"
import type { TermDatesRow } from "./term-week"
import {
  densityLevel,
  relativeDay,
  shiftWeek,
  stripAnchor,
  stripTermLabel,
  termWeekTag,
  weekDays,
  weekdayLetter,
  withCounts,
} from "./week-strip"

/** Michaelmas 2026: Full Term Tue 6 Oct – Fri 4 Dec; Week 1 starts Thu 8 Oct. */
const TERMS: TermDatesRow[] = [
  {
    academicYear: "2026-27",
    term: "michaelmas",
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
  },
  { academicYear: "2026-27", term: "lent", fullTermStart: "2027-01-19", fullTermEnd: "2027-03-19" },
]

describe("week strip", () => {
  test("a week runs Monday to Sunday around any day", () => {
    expect(weekDays("2026-11-04")).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ])
    expect(weekDays("2026-11-08")[0]).toBe("2026-11-02")
    expect(weekDays("2026-11-02")[0]).toBe("2026-11-02")
  })

  test("pages by whole weeks, across a month end", () => {
    expect(shiftWeek("2026-11-04", 1)).toBe("2026-11-09")
    expect(shiftWeek("2026-11-04", -1)).toBe("2026-10-26")
    expect(shiftWeek("2026-11-26", 1)).toBe("2026-11-30")
  })

  test("fills counts in, zero where a day has none", () => {
    expect(
      withCounts(
        ["2026-11-02", "2026-11-03"],
        [
          { day: "2026-11-03", count: 5 },
          { day: "2026-11-09", count: 9 },
        ],
      ),
    ).toEqual([
      { date: "2026-11-02", count: 0 },
      { date: "2026-11-03", count: 5 },
    ])
    expect(withCounts(["2026-11-02"], undefined)).toEqual([{ date: "2026-11-02", count: 0 }])
  })

  test("density is relative to the busiest day shown", () => {
    expect(densityLevel(0, 18)).toBe(0)
    expect(densityLevel(3, 18)).toBe(1)
    expect(densityLevel(9, 18)).toBe(2)
    expect(densityLevel(18, 18)).toBe(3)
    expect(densityLevel(2, 0)).toBe(0)
  })

  test("labels days and weeks the Cambridge way", () => {
    expect(weekdayLetter("2026-11-02")).toBe("M")
    expect(weekdayLetter("2026-11-08")).toBe("S")
    expect(relativeDay("2026-11-03", "2026-11-03")).toBe("Today")
    expect(relativeDay("2026-11-04", "2026-11-03")).toBe("Tomorrow")
    expect(relativeDay("2026-11-05", "2026-11-03")).toBeUndefined()
    // Week 4 runs Thu 29 Oct – Wed 4 Nov; Week 5 from Thu 5 Nov.
    expect(termWeekTag("2026-11-04", TERMS)).toBe("Mich · Wk 4")
    expect(termWeekTag("2026-11-05", TERMS)).toBe("Mich · Wk 5")
    expect(termWeekTag("2026-12-20", TERMS)).toBeUndefined()
    // A Monday-first strip is named by its Thursday.
    expect(stripTermLabel(weekDays("2026-11-02"), TERMS)).toBe("Mich · Wk 5")
    expect(stripTermLabel(weekDays("2026-12-21"), TERMS)).toBe("Vacation")
  })
})

describe("strip anchor", () => {
  test("a weekday opens on its own week", () => {
    expect(stripAnchor("2026-11-04", "2026-12-01", "2026-11-04")).toBe("2026-11-02")
    expect(stripAnchor("2026-11-06", "2026-12-03", "2026-11-06")).toBe("2026-11-02")
  })

  test("a weekend view that runs on opens on the coming week", () => {
    // Sunday 1 Nov: the four-week agenda, Sun 1 – Sat 28 Nov.
    expect(stripAnchor("2026-11-01", "2026-11-28", "2026-11-01")).toBe("2026-11-02")
    expect(stripAnchor("2026-10-31", "2026-11-27", "2026-10-31")).toBe("2026-11-02")
  })

  test("a range ending this Sunday, or a chosen day, keeps its week", () => {
    // Today, Weekend, This week on a Sunday or Saturday.
    expect(stripAnchor("2026-11-01", "2026-11-01", "2026-11-01")).toBe("2026-10-26")
    expect(stripAnchor("2026-10-31", "2026-11-01", "2026-10-31")).toBe("2026-10-26")
    // Saturday, choosing Sunday.
    expect(stripAnchor("2026-11-01", "2026-11-28", "2026-10-31")).toBe("2026-10-26")
  })
})

describe("date presets", () => {
  const TUESDAY = "2026-11-03"

  test("today and tomorrow are single days", () => {
    expect(presetRange("today", TUESDAY)).toEqual({ first: TUESDAY, last: TUESDAY })
    expect(presetRange("tomorrow", TUESDAY)).toEqual({ first: "2026-11-04", last: "2026-11-04" })
  })

  test("this week runs to Sunday", () => {
    expect(presetRange("week", TUESDAY)).toEqual({ first: TUESDAY, last: "2026-11-08" })
    expect(presetRange("week", "2026-11-08")).toEqual({ first: "2026-11-08", last: "2026-11-08" })
  })

  test("the weekend is the coming Saturday and Sunday, or what is left of it", () => {
    expect(presetRange("weekend", TUESDAY)).toEqual({ first: "2026-11-07", last: "2026-11-08" })
    expect(presetRange("weekend", "2026-11-07")).toEqual({
      first: "2026-11-07",
      last: "2026-11-08",
    })
    expect(presetRange("weekend", "2026-11-08")).toEqual({
      first: "2026-11-08",
      last: "2026-11-08",
    })
  })

  test("rest of term runs to the end of Full Term, and not in the vacation", () => {
    expect(currentTermEnd(TUESDAY, TERMS)).toBe("2026-12-04")
    expect(presetRange("term", TUESDAY, "2026-12-04")).toEqual({
      first: TUESDAY,
      last: "2026-12-04",
    })
    expect(currentTermEnd("2026-12-20", TERMS)).toBeUndefined()
    expect(presetRange("term", "2026-12-20", undefined)).toBeUndefined()
    expect(availablePresets("2026-12-20", undefined)).not.toContain("term")
    expect(availablePresets(TUESDAY, "2026-12-04")).toEqual([
      "today",
      "tomorrow",
      "week",
      "weekend",
      "term",
    ])
  })

  test("at the weekend, chips that cover the same days collapse", () => {
    // Saturday: This week is the weekend.
    expect(availablePresets("2026-11-07", "2026-12-04")).toEqual([
      "today",
      "tomorrow",
      "weekend",
      "term",
    ])
    // Sunday: This week and Weekend are both just today.
    expect(availablePresets("2026-11-08", "2026-12-04")).toEqual(["today", "tomorrow", "term"])
    // A link's own preset stays, so its chip shows as on.
    expect(availablePresets("2026-11-08", "2026-12-04", "week")).toEqual([
      "today",
      "tomorrow",
      "week",
      "term",
    ])
  })
})
