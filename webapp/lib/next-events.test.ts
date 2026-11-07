import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import { nextEvents, nextEventWhen } from "./next-events"

/** "Next from <society>" (lib/next-events.ts). Invented data only. */

const HOUR = 3_600_000
const BASE = Date.parse("2026-11-14T19:00:00Z")
const NOW = BASE - 48 * HOUR

function ev(key: string, offsetHours: number, extra: Record<string, unknown> = {}) {
  return {
    key,
    title: `Invented ${key}`,
    startsAt: BASE + offsetHours * HOUR,
    allDay: false,
    cancelled: false,
    ...extra,
  }
}

describe("nextEvents", () => {
  test("the next three after this one, in start order, never itself or a cancelled one", () => {
    const current = ev("a", 0)
    const listed = [
      ev("e", 96),
      current,
      ev("b", 24),
      ev("x", 30, { cancelled: true }),
      ev("c", 48),
      ev("d", 72),
      ev("earlier", -2),
    ]
    expect(nextEvents(current, listed, NOW).map((n) => n.key)).toEqual(["b", "c", "d"])
  })

  test("a show's nights count once, and the run this event belongs to is skipped", () => {
    const show = { sourceUrl: "https://example.org/show", title: "Invented Show" }
    const current = ev("night1", 0, show)
    const listed = [
      current,
      ev("night2", 24, show),
      ev("night3", 48, show),
      ev("quiz", 30),
      ev("other1", 50, { sourceUrl: "https://example.org/other", title: "Invented Other" }),
      ev("other2", 74, { sourceUrl: "https://example.org/other", title: "Invented Other" }),
    ]
    expect(nextEvents(current, listed, NOW).map((n) => n.key)).toEqual(["quiz", "other1"])
  })

  test("same start time: only those ordered after it, so two events never only link each other", () => {
    const current = ev("m", 0)
    const listed = [ev("a", 0), current, ev("z", 0)]
    expect(nextEvents(current, listed, NOW).map((n) => n.key)).toEqual(["z"])
  })

  test("an ended event points at what has not started yet", () => {
    const current = ev("old", -100)
    const listed = [current, ev("past", -50), ev("soon", 10), ev("later", 20)]
    expect(nextEvents(current, listed, BASE).map((n) => n.key)).toEqual(["soon", "later"])
  })

  test("labels: day and London time, or the day alone for an all-day event", () => {
    expect(nextEventWhen({ startsAt: BASE, allDay: false })).toBe("Sat 14 Nov, 19:00")
    expect(nextEventWhen({ startsAt: londonMidnight("2026-11-20"), allDay: true })).toBe(
      "Fri 20 Nov",
    )
    const current = ev("a", 0)
    expect(nextEvents(current, [current, ev("b", 1)], NOW)[0]).toEqual({
      key: "b",
      title: "Invented b",
      when: "Sat 14 Nov, 20:00",
    })
  })
})
