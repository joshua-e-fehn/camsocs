import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import { groupRuns, runSummary, splitOngoing } from "./event-runs"

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

test("splitOngoing separates events already running at the window's start", () => {
  const from = londonMidnight("2026-10-26")
  const film = { key: "f", title: "Film", startsAt: at("2026-05-29", 0) }
  const { ongoing, starting } = splitOngoing([film, ...events], from)
  expect(ongoing.map((event) => event.key)).toEqual(["f"])
  expect(starting).toHaveLength(events.length)
})
