import { describe, expect, test } from "bun:test"
import { addDays } from "./calendar"
import {
  academicYearLabel,
  byAcademicYear,
  formatDayWithYear,
  fullTermDays,
  termTitle,
  termWeeks,
} from "./term-calendar"
import { type TermDatesRow, termWeekOf } from "./term-week"

// pipeline/src/camsocs_pipeline/seeds/term_dates.py (2026-27).
const MICHAELMAS: TermDatesRow = {
  academicYear: "2026-27",
  term: "michaelmas",
  fullTermStart: "2026-10-06",
  fullTermEnd: "2026-12-04",
}
const LENT: TermDatesRow = {
  academicYear: "2026-27",
  term: "lent",
  fullTermStart: "2027-01-19",
  fullTermEnd: "2027-03-19",
}
const NEXT_MICHAELMAS: TermDatesRow = {
  academicYear: "2027-28",
  term: "michaelmas",
  fullTermStart: "2027-10-05",
  fullTermEnd: "2027-12-03",
}

describe("termWeeks", () => {
  const weeks = termWeeks(MICHAELMAS)

  test("Michaelmas 2026 runs from Week 0 to its short Week 9", () => {
    expect(weeks[0]).toEqual({ week: 0, from: "2026-10-01", to: "2026-10-07" })
    expect(weeks[1]).toEqual({ week: 1, from: "2026-10-08", to: "2026-10-14" })
    expect(weeks.at(-1)).toEqual({ week: 9, from: "2026-12-03", to: "2026-12-04" })
    expect(weeks).toHaveLength(10)
  })

  test("Lent 2027 also ends in a short Week 9; the page's prose depends on it", () => {
    expect(termWeeks(LENT).at(-1)).toEqual({ week: 9, from: "2027-03-18", to: "2027-03-19" })
  })

  test("agrees with the term clock on every day it lists", () => {
    for (const { week, from, to } of weeks) {
      for (let day = from; day <= to; day = addDays(day, 1)) {
        expect(termWeekOf(day, MICHAELMAS)).toBe(week)
      }
    }
  })
})

test("Full Term's length counts both ends", () => {
  expect(fullTermDays(MICHAELMAS)).toBe(60)
})

test("rows group by academic year, terms in calendar order", () => {
  expect(byAcademicYear([NEXT_MICHAELMAS, LENT, MICHAELMAS])).toEqual([
    { academicYear: "2026-27", terms: [MICHAELMAS, LENT] },
    { academicYear: "2027-28", terms: [NEXT_MICHAELMAS] },
  ])
})

test("labels", () => {
  expect(academicYearLabel("2026-27")).toBe("2026–27")
  expect(termTitle(LENT)).toBe("Lent 2027")
  expect(formatDayWithYear("2026-10-06")).toBe("Tue 6 Oct 2026")
})
