import { describe, expect, test } from "bun:test"
import { EVERYONE, robotsGroupAllows } from "./crawl-traps"
import { mapDate, mapDayHref, mapHref, mapIndexing, parseMapParams } from "./map-url-state"

const TODAY = "2026-11-24"

describe("the map's URL", () => {
  test("reads a day and a kind, and ignores anything malformed", () => {
    expect(parseMapParams({})).toEqual({ date: undefined, show: "all" })
    expect(parseMapParams({ d: "2026-11-27", show: "talks" })).toEqual({
      date: "2026-11-27",
      show: "talks",
    })
    expect(parseMapParams({ d: "2026-02-30", show: "people" })).toEqual({
      date: undefined,
      show: "all",
    })
    expect(parseMapParams({ d: ["2026-11-25", "2026-11-26"] }).date).toBe("2026-11-25")
  })

  test("shows today unless the URL names a day within a year", () => {
    expect(mapDate({ show: "all" }, TODAY)).toBe(TODAY)
    expect(mapDate({ date: "2026-12-01", show: "all" }, TODAY)).toBe("2026-12-01")
    expect(mapDate({ date: "2027-11-24", show: "all" }, TODAY)).toBe("2027-11-24")
    expect(mapDate({ date: "2028-01-01", show: "all" }, TODAY)).toBe(TODAY)
    expect(mapDate({ date: "1999-01-01", show: "all" }, TODAY)).toBe(TODAY)
  })

  test("writes the plain map as /map and leaves today and both kinds out", () => {
    expect(mapHref({ show: "all" }, TODAY)).toBe("/map")
    expect(mapHref({ date: TODAY, show: "all" }, TODAY)).toBe("/map")
    expect(mapHref({ date: "2026-11-25", show: "events" }, TODAY)).toBe(
      "/map?d=2026-11-25&show=events",
    )
    expect(mapDayHref("2026-11-25")).toBe("/map?d=2026-11-25")
  })

  test("round-trips", () => {
    const state = { date: "2026-11-30", show: "talks" } as const
    const href = mapHref(state, TODAY)
    const params = Object.fromEntries(new URL(href, "https://camsocs.uk").searchParams)
    expect(parseMapParams(params)).toEqual(state)
  })

  test("only the bare /map is indexable, and robots.txt keeps crawlers off the rest", () => {
    expect(mapIndexing({})).toEqual({ canonical: "/map", index: true })
    expect(mapIndexing({ d: "2026-11-25" })).toEqual({ canonical: "/map", index: false })
    expect(mapIndexing({ utm_source: "x" }).index).toBe(false)
    expect(robotsGroupAllows(EVERYONE, "/map")).toBe(true)
    expect(robotsGroupAllows(EVERYONE, "/map?d=2026-11-25")).toBe(false)
  })
})
