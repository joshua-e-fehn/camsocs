import { describe, expect, test } from "bun:test"
import {
  addMonths,
  formatEventTime,
  formatEventWhen,
  formatRange,
  isIsoDate,
  londonIsoDate,
  londonMidnight,
  londonTime,
  shiftAnchor,
  startOfWeek,
  viewWindow,
} from "./calendar"

const HOUR = 3_600_000

describe("London days", () => {
  test("midnight is GMT in winter and BST in summer", () => {
    expect(londonMidnight("2026-12-01")).toBe(Date.UTC(2026, 11, 1))
    expect(londonMidnight("2026-10-08")).toBe(Date.UTC(2026, 9, 8) - HOUR)
  })

  test("the days the clocks change start before the change", () => {
    // 29 Mar 2026: clocks go forward at 01:00 UTC, so midnight is still GMT.
    expect(londonMidnight("2026-03-29")).toBe(Date.UTC(2026, 2, 29))
    expect(londonMidnight("2026-03-30")).toBe(Date.UTC(2026, 2, 30) - HOUR)
    // 25 Oct 2026: clocks go back at 01:00 UTC, so midnight is still BST.
    expect(londonMidnight("2026-10-25")).toBe(Date.UTC(2026, 9, 25) - HOUR)
    expect(londonMidnight("2026-10-26")).toBe(Date.UTC(2026, 9, 26))
  })

  test("an instant's London date and time", () => {
    expect(londonIsoDate(Date.UTC(2026, 9, 7, 23, 30))).toBe("2026-10-08")
    expect(londonTime(Date.UTC(2026, 9, 7, 18, 30))).toBe("19:30")
    expect(londonTime(Date.UTC(2026, 10, 7, 18, 30))).toBe("18:30")
  })

  test("isIsoDate accepts real dates only", () => {
    expect(isIsoDate("2026-10-08")).toBe(true)
    expect(isIsoDate("2026-02-30")).toBe(false)
    expect(isIsoDate("2026-10-8")).toBe(false)
    expect(isIsoDate("tomorrow")).toBe(false)
  })
})

describe("views", () => {
  test("weeks start on Monday", () => {
    expect(startOfWeek("2026-10-08")).toBe("2026-10-05")
    expect(startOfWeek("2026-10-05")).toBe("2026-10-05")
    expect(startOfWeek("2026-10-11")).toBe("2026-10-05")
  })

  test("the week view covers Monday to Sunday in London time", () => {
    const window = viewWindow("week", "2026-10-21")
    expect(window.days).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ])
    expect(window.from).toBe(Date.UTC(2026, 9, 19) - HOUR)
    // The week ends at Monday 26 Oct 00:00 GMT: the clocks went back on Sunday.
    expect(window.to).toBe(Date.UTC(2026, 9, 26))
  })

  test("the month view covers whole weeks around the month", () => {
    const window = viewWindow("month", "2026-10-15")
    expect(window.days[0]).toBe("2026-09-28")
    expect(window.days[window.days.length - 1]).toBe("2026-11-01")
    expect(window.days.length % 7).toBe(0)
    // February 2027 starts on a Monday and needs exactly four weeks.
    expect(viewWindow("month", "2027-02-10").days.length).toBe(28)
  })

  test("the list view runs four weeks from its anchor", () => {
    const window = viewWindow("list", "2026-10-08")
    expect(window.days.length).toBe(28)
    expect(window.days[0]).toBe("2026-10-08")
  })

  test("paging moves by the view's span", () => {
    expect(shiftAnchor("week", "2026-10-08", 1)).toBe("2026-10-12")
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01")
    expect(shiftAnchor("month", "2026-01-15", -1)).toBe("2025-12-01")
    expect(shiftAnchor("list", "2026-10-08", -1)).toBe("2026-09-10")
    expect(addMonths("2026-12-05", 1)).toBe("2027-01-01")
  })
})

describe("display", () => {
  test("event times in London", () => {
    const startsAt = Date.UTC(2026, 9, 8, 18, 30)
    expect(formatEventWhen({ startsAt, allDay: false })).toBe("Thu 8 Oct, 19:30")
    expect(formatEventWhen({ startsAt, endsAt: startsAt + 2 * HOUR, allDay: false })).toBe(
      "Thu 8 Oct, 19:30–21:30",
    )
    expect(formatEventWhen({ startsAt, endsAt: startsAt + 2 * 24 * HOUR, allDay: false })).toBe(
      "Thu 8 Oct, 19:30 – Sat 10 Oct, 19:30",
    )
    const day = londonMidnight("2026-10-10")
    expect(formatEventWhen({ startsAt: day, endsAt: day + 24 * HOUR, allDay: true })).toBe(
      "Sat 10 Oct (all day)",
    )
  })

  test("the time part alone", () => {
    const startsAt = Date.UTC(2026, 9, 8, 18, 30)
    expect(formatEventTime({ startsAt, endsAt: startsAt + HOUR, allDay: false })).toBe(
      "19:30–20:30",
    )
    expect(formatEventTime({ startsAt, allDay: true })).toBe("All day")
  })

  test("range labels", () => {
    expect(formatRange("week", viewWindow("week", "2026-10-08"), "2026-10-08")).toBe(
      "5 – 11 Oct 2026",
    )
    expect(formatRange("week", viewWindow("week", "2026-10-29"), "2026-10-29")).toBe(
      "26 Oct – 1 Nov 2026",
    )
    expect(formatRange("month", viewWindow("month", "2026-10-08"), "2026-10-08")).toBe(
      "October 2026",
    )
  })
})
