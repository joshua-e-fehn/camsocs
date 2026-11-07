import { describe, expect, test } from "bun:test"
import { addDays } from "./calendar"
import {
  academicYearLabel,
  byAcademicYear,
  formatDayLong,
  formatDayWithYear,
  fullTermDays,
  leadingYear,
  nextTerm,
  termAnswer,
  termDatesDescription,
  termDatesTitle,
  termSeasons,
  termTitle,
  termWeeks,
  upcomingTerms,
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

const EASTER: TermDatesRow = {
  academicYear: "2026-27",
  term: "easter",
  fullTermStart: "2027-04-27",
  fullTermEnd: "2027-06-18",
}
const ROWS = [NEXT_MICHAELMAS, EASTER, LENT, MICHAELMAS]
/** Noon in London on `iso` (GMT and BST both keep the London day). */
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`)

describe("search-facing words", () => {
  test("formatDayLong spells the day out", () => {
    expect(formatDayLong("2027-01-19")).toBe("Tuesday 19 January 2027")
  })

  test("nextTerm and upcomingTerms read the stored dates in order", () => {
    expect(nextTerm(ROWS, "2026-11-07")).toEqual(LENT)
    expect(nextTerm(ROWS, "2027-01-19")).toEqual(EASTER)
    expect(nextTerm(ROWS, "2027-10-05")).toBeUndefined()
    expect(upcomingTerms(ROWS, "2026-11-07")).toEqual([MICHAELMAS, LENT, EASTER, NEXT_MICHAELMAS])
    expect(upcomingTerms(ROWS, "2026-12-05")).toEqual([LENT, EASTER, NEXT_MICHAELMAS])
  })

  test("the leading year is the current or next term's", () => {
    expect(leadingYear(ROWS, at("2026-11-07"))).toBe("2026-27")
    expect(leadingYear(ROWS, at("2027-07-01"))).toBe("2027-28")
  })

  test("the title names the year and when the next Full Term starts, within 60 characters", () => {
    expect(termDatesTitle(ROWS, at("2026-11-07"))).toBe(
      "Cambridge term dates 2026–27: Lent 2027 starts 19 Jan",
    )
    expect(termDatesTitle(ROWS, at("2027-02-01"))).toBe(
      "Cambridge term dates 2026–27: Easter 2027 starts 27 Apr",
    )
    // In Easter Term the next term is next year's, and so is the title.
    expect(termDatesTitle(ROWS, at("2027-05-10"))).toBe(
      "Cambridge term dates 2027–28: Michaelmas 2027 starts 5 Oct",
    )
    expect(termDatesTitle(ROWS, at("2027-11-01"))).toBe("Cambridge term dates 2027–28")
    for (const day of ["2026-11-07", "2027-02-01", "2027-05-10", "2027-08-01"])
      expect(termDatesTitle(ROWS, at(day)).length).toBeLessThanOrEqual(60)
  })

  test("the description lists the next three Full Terms and fits a search result", () => {
    const description = termDatesDescription(ROWS, at("2026-11-07"))
    expect(description).toStartWith(
      "Full Term: Michaelmas 2026 6 Oct–4 Dec, Lent 2027 19 Jan–19 Mar, Easter 2027 27 Apr–18 Jun.",
    )
    expect(description.length).toBeLessThanOrEqual(155)
    expect(termDatesDescription(ROWS, at("2027-07-01"))).toStartWith(
      "Full Term: Michaelmas 2027 5 Oct–3 Dec.",
    )
    expect(termDatesDescription([], at("2026-11-07"))).toStartWith("Cambridge Full Term dates")
  })

  test("termAnswer answers 'when is … term' from the dates and the week rule", () => {
    expect(termAnswer(LENT)).toEqual({
      id: "lent-2027",
      question: "When is Lent Term 2027?",
      answer:
        "Full Term runs from Tuesday 19 January to Friday 19 March 2027. Week 1 starts on Thursday 21 January.",
    })
    expect(termAnswer(MICHAELMAS).answer).toBe(
      "Full Term runs from Tuesday 6 October to Friday 4 December 2026. Week 1 starts on Thursday 8 October.",
    )
  })

  test("termSeasons names each term's months", () => {
    expect(termSeasons([EASTER, MICHAELMAS, LENT])).toBe(
      "Michaelmas (October to December), Lent (January to March) and Easter (April to June)",
    )
  })
})
