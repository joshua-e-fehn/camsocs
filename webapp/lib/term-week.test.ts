import { describe, expect, test } from "bun:test"
import { termWeekLabel } from "@/convex/lib/derived"
import { addDays, londonMidnight } from "./calendar"
import {
  startsIn,
  type TermDatesRow,
  termClock,
  termClockLabel,
  termClockParts,
  termWeekOf,
  weekOfTerm,
} from "./term-week"

// pipeline/src/camsocs_pipeline/seeds/term_dates.py (2026-27).
const TERMS: TermDatesRow[] = [
  // Out of order on purpose: the clock sorts.
  { academicYear: "2026-27", term: "lent", fullTermStart: "2027-01-19", fullTermEnd: "2027-03-19" },
  {
    academicYear: "2026-27",
    term: "michaelmas",
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
  },
  {
    academicYear: "2026-27",
    term: "easter",
    fullTermStart: "2027-04-27",
    fullTermEnd: "2027-06-18",
  },
]

/** Noon in London on `iso`. */
const noon = (iso: string) => londonMidnight(iso) + 12 * 3_600_000

describe("termClock", () => {
  test("Saturday 31 October 2026 is Michaelmas week 4", () => {
    const clock = termClock(noon("2026-10-31"), TERMS)
    expect(clock).toMatchObject({ kind: "term", term: "michaelmas", week: 4 })
    expect(termClockLabel(clock)).toBe("MICH · WK 4 · SAT 31 OCT")
  })

  test("weeks turn over on Thursday; Week 0 is the week before Full Term", () => {
    expect(termWeekOf("2026-10-07", TERMS[1])).toBe(0) // Wed after the Tuesday start
    expect(termWeekOf("2026-10-08", TERMS[1])).toBe(1)
    expect(termWeekOf("2026-10-01", TERMS[1])).toBe(0) // Thursday before
    expect(termWeekOf("2026-09-30", TERMS[1])).toBeUndefined()
    expect(termWeekOf("2026-12-03", TERMS[1])).toBe(9)
    expect(termWeekOf("2026-12-05", TERMS[1])).toBeUndefined()
  })

  test("the days around a clock change keep their London date", () => {
    // 25 Oct 2026, 00:30 London (BST → GMT that night) is still the 25th.
    const clock = termClock(Date.UTC(2026, 9, 24, 23, 30), TERMS)
    expect(clock).toMatchObject({ kind: "term", date: "2026-10-25", week: 3 })
  })

  test("the vacation counts down to the next Full Term", () => {
    const clock = termClock(noon("2026-12-12"), TERMS)
    expect(clock).toMatchObject({
      kind: "vacation",
      next: { term: "lent", fullTermStart: "2027-01-19", inDays: 38 },
    })
    expect(termClockLabel(clock)).toBe("VACATION · LENT STARTS IN 5 WEEKS")
  })

  test("Week 0 of the next term is already term time", () => {
    expect(termClock(noon("2027-01-15"), TERMS)).toMatchObject({ term: "lent", week: 0 })
  })

  test("without later dates the vacation just names the day", () => {
    const clock = termClock(noon("2027-07-01"), TERMS)
    expect(clock).toEqual({ kind: "vacation", date: "2027-07-01", next: undefined })
    expect(termClockParts(clock)).toEqual(["Vacation", "Thu 1 Jul"])
    expect(termClock(noon("2026-10-31"), [])).toMatchObject({ kind: "vacation" })
  })

  test("agrees with the stamp events carry (convex/lib/derived.ts) every day of the year", () => {
    let day = "2026-09-01"
    while (day < "2027-07-31") {
      const clock = termClock(noon(day), TERMS)
      const stamp = termWeekLabel(noon(day), TERMS)
      if (clock.kind === "term") {
        expect(stamp).toEndWith(`Wk ${clock.week}`)
      } else {
        expect(stamp).toBeUndefined()
      }
      day = addDays(day, 1)
    }
  })
})

describe("wording", () => {
  test("startsIn", () => {
    expect(startsIn(1)).toBe("tomorrow")
    expect(startsIn(6)).toBe("in 6 days")
    expect(startsIn(13)).toBe("in 13 days")
    expect(startsIn(63)).toBe("in 9 weeks")
  })

  test("weekOfTerm", () => {
    expect(weekOfTerm(4)).toBe("Week 4 of 8")
    expect(weekOfTerm(0)).toBe("Week 0")
    expect(weekOfTerm(9)).toBe("Week 9")
  })
})
