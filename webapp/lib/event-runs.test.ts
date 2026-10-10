import { describe, expect, test } from "bun:test"
import { DAY_MS, londonMidnight, viewWindow } from "./calendar"
import {
  eventsByDay,
  groupRuns,
  isLongRun,
  lastDayOf,
  runSummary,
  splitOngoing,
} from "./event-runs"

const at = (day: string, hour = 19) => londonMidnight(day) + hour * 3_600_000
const show = "https://www.camdram.net/shows/top-girls"

const events = [
  {
    key: "a",
    title: "Top Girls",
    startsAt: at("2026-10-27"),
    sourceUrl: show,
    eventType: "performance",
  },
  { key: "b", title: "Freshers' Friday", startsAt: at("2026-10-27", 13) },
  { key: "c", title: "Top Girls", startsAt: at("2026-10-28"), sourceUrl: show },
  { key: "d", title: "Top Girls", startsAt: at("2026-10-31"), sourceUrl: show },
  // Same title, another page: another run (a different production).
  { key: "e", title: "Top Girls", startsAt: at("2026-11-02"), sourceUrl: `${show}-2` },
]

describe("groupRuns", () => {
  test("nights of one show from one page are one run, in first-night order", () => {
    const runs = groupRuns(events)
    expect(runs.map((run) => run.events.map((event) => event.key))).toEqual([
      ["a", "c", "d"],
      ["b"],
      ["e"],
    ])
    expect(runs[0].key).toBe("a")
  })

  test("events without a page never merge", () => {
    const loose = [
      { key: "x", title: "Social", startsAt: at("2026-10-20") },
      { key: "y", title: "Social", startsAt: at("2026-10-27") },
    ]
    expect(groupRuns(loose)).toHaveLength(2)
  })
})

test("runSummary gives the first and last day and the count", () => {
  const [run] = groupRuns(events)
  expect(runSummary(run)).toBe("Tue 27 Oct – Sat 31 Oct · 3 performances")
  const [social] = groupRuns([
    { key: "s1", title: "Social", startsAt: at("2026-10-20"), sourceUrl: "https://x.org/s" },
    { key: "s2", title: "Social", startsAt: at("2026-10-20", 21), sourceUrl: "https://x.org/s" },
  ])
  expect(runSummary(social)).toBe("Tue 20 Oct · 2 dates")
})

// What the calendar showed on 2026-10-10: a film listed May–December, a
// month-long online competition and a weekend one, all begun before the view.
const film = {
  key: "magpie",
  title: "MAGPIE: 16mm short film",
  startsAt: londonMidnight("2026-05-29"),
  endsAt: londonMidnight("2026-12-19"),
}
const battle = {
  key: "battle",
  title: "Africa battleCTF 2026 Qualifier",
  startsAt: at("2026-10-05", 0),
  endsAt: at("2026-11-04", 23),
}
const fortid = {
  key: "fortid",
  title: "FortID CTF 2026",
  startsAt: at("2026-10-09"),
  endsAt: at("2026-10-11"),
}

test("splitOngoing separates events already running at the window's start, soonest to end first", () => {
  const from = londonMidnight("2026-10-10")
  const today = { key: "t", title: "Freshers' social", startsAt: at("2026-10-10") }
  const { ongoing, starting } = splitOngoing([film, today, battle, fortid], from)
  expect(ongoing.map((event) => event.key)).toEqual(["fortid", "battle", "magpie"])
  expect(starting.map((event) => event.key)).toEqual(["t"])
})

test("a long run lasts more than 14 days; lastDayOf is the day it ends on", () => {
  expect(isLongRun(film)).toBe(true)
  expect(isLongRun(battle)).toBe(true)
  expect(isLongRun(fortid)).toBe(false)
  expect(isLongRun({ startsAt: 0, endsAt: 14 * DAY_MS })).toBe(false)
  expect(isLongRun({ startsAt: 0 })).toBe(false)
  // An all-day run ends at midnight after its last day.
  expect(lastDayOf(film)).toBe("2026-12-18")
  expect(lastDayOf(battle)).toBe("2026-11-04")
  expect(lastDayOf({ startsAt: at("2026-10-20") })).toBe("2026-10-20")
})

describe("eventsByDay", () => {
  const october = viewWindow("month", "2026-10-10")
  const bumps = {
    key: "bumps",
    title: "Bumps",
    startsAt: at("2026-10-27", 12),
    endsAt: at("2026-10-30", 18),
  }
  const talk = { key: "talk", title: "Talk", startsAt: at("2026-10-14") }

  test("the grids put a multi-day event on every day it covers, a long run on its first only", () => {
    const days = eventsByDay([battle, bumps, talk], october.days, true)
    const on = (day: string) => (days.get(day) ?? []).map((event) => event.key)
    expect(on("2026-10-05")).toEqual(["battle"])
    for (const day of ["2026-10-06", "2026-10-20", "2026-11-01"]) expect(on(day)).toEqual([])
    expect(on("2026-10-14")).toEqual(["talk"])
    for (const day of ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) {
      expect(on(day)).toEqual(["bumps"])
    }
    expect([...days.keys()]).toEqual([...days.keys()].sort())
  })

  test("the list puts every event on its first day in view", () => {
    const days = eventsByDay([battle, bumps, talk], october.days, false)
    expect([...days.entries()].map(([day, list]) => [day, list.map((e) => e.key)])).toEqual([
      ["2026-10-05", ["battle"]],
      ["2026-10-14", ["talk"]],
      ["2026-10-27", ["bumps"]],
    ])
  })
})
