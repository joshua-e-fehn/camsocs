import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import {
  AGENDA_DAYS,
  activeTalkFilterCount,
  matchesWindow,
  parseTalksParams,
  serializeTalksState,
  type TalksState,
  talksCountArgs,
  talksDayCountArgs,
  talksFeedQuery,
  talksListArgs,
  talksSearchArgs,
  talksWindow,
} from "./talks-url-state"

const KEY = "talk-05f9cb992668bbf0c8dc"
const TODAY = "2026-11-03" // a Tuesday in Michaelmas
const TERM_END = "2026-12-04"

const fromQuery = (query: string) =>
  parseTalksParams(Object.fromEntries(new URLSearchParams(query)))

describe("parse / serialize", () => {
  const states: TalksState[] = [
    {},
    { q: "ageing brains" },
    { school: "technology" },
    { dept: "computer-science-and-technology", school: "technology" },
    { dept: "other-series" },
    { kind: "lecture", online: true },
    { online: false },
    { preset: "weekend" },
    { from: "2026-11-12" },
    { talk: KEY },
    {
      q: "rivers",
      school: "physical_sciences",
      dept: "earth-sciences",
      kind: "seminar",
      online: true,
      preset: "term",
      talk: KEY,
    },
  ]
  for (const state of states) {
    test(`round-trips ${JSON.stringify(state)}`, () => {
      expect(fromQuery(serializeTalksState(state))).toEqual(state)
    })
  }

  test("serialising is canonical: fixed order, defaults omitted", () => {
    expect(serializeTalksState({})).toBe("")
    expect(
      serializeTalksState({ talk: KEY, kind: "lecture", q: "ice", school: "technology" }),
    ).toBe(`?q=ice&school=technology&kind=lecture&talk=${KEY}`)
    expect(serializeTalksState({ online: false })).toBe("?online=no")
  })

  test("a preset wins over a start day", () => {
    expect(serializeTalksState({ preset: "week", from: "2026-11-12" })).toBe("?preset=week")
    expect(fromQuery("preset=week&from=2026-11-12")).toEqual({ preset: "week" })
  })

  test("parsing is forgiving: junk is dropped, never an error", () => {
    expect(
      fromQuery(
        "school=engineering&dept=Not%20A%20Slug&kind=party&online=maybe&preset=fortnight&from=2026-02-30&talk=evt-1",
      ),
    ).toEqual({})
    expect(fromQuery("q=%20%20")).toEqual({})
    expect(fromQuery(`q=${"x".repeat(300)}`).q).toHaveLength(200)
  })

  test("the feed query keeps the filters and drops dates and the open talk", () => {
    expect(
      talksFeedQuery({ dept: "law", kind: "lecture", online: true, preset: "week", talk: KEY }),
    ).toBe("?dept=law&kind=lecture&online=yes")
    expect(talksFeedQuery({ from: "2026-11-12" })).toBe("")
  })

  test("counts filters, not the query, dates or talk", () => {
    expect(activeTalkFilterCount({ q: "x", preset: "week", talk: KEY })).toBe(0)
    expect(activeTalkFilterCount({ school: "technology", dept: "cst", online: false })).toBe(3)
  })
})

describe("the window", () => {
  test("defaults to four weeks from today", () => {
    const window = talksWindow({}, TODAY, TERM_END)
    expect(window.first).toBe(TODAY)
    expect(window.last).toBe("2026-11-30")
    expect(window.from).toBe(londonMidnight(TODAY))
    expect(window.to).toBe(londonMidnight("2026-12-01"))
    expect(window.preset).toBeUndefined()
    expect((window.to - window.from) / 86_400_000).toBe(AGENDA_DAYS)
  })

  test("starts on the chosen day", () => {
    expect(talksWindow({ from: "2026-11-12" }, TODAY).first).toBe("2026-11-12")
  })

  test("follows a preset", () => {
    expect(talksWindow({ preset: "weekend" }, TODAY)).toMatchObject({
      first: "2026-11-07",
      last: "2026-11-08",
      preset: "weekend",
    })
    expect(talksWindow({ preset: "term" }, TODAY, TERM_END).last).toBe(TERM_END)
  })

  test("rest of term in the vacation falls back to the default window", () => {
    const window = talksWindow({ preset: "term" }, "2026-12-20", undefined)
    expect(window.preset).toBeUndefined()
    expect(window.first).toBe("2026-12-20")
  })
})

describe("Convex arguments", () => {
  const state: TalksState = { school: "technology", dept: "engineering", kind: "lecture", q: "x" }
  const window = talksWindow({}, TODAY)

  test("list arguments carry no undefined members", () => {
    expect(talksListArgs({}, window)).toEqual({ from: window.from, to: window.to })
    expect(talksListArgs(state, window)).toEqual({
      from: window.from,
      to: window.to,
      school: "technology",
      department: "engineering",
      kind: "lecture",
    })
  })

  test("search starts at the window and is capped", () => {
    expect(talksSearchArgs(state, window)).toEqual({
      q: "x",
      school: "technology",
      department: "engineering",
      from: window.from,
      limit: 50,
    })
  })

  test("search hits are held to the window, kind and format", () => {
    const hit = { startsAt: window.from + 3_600_000, kind: "lecture" as const, online: true }
    expect(matchesWindow(hit, { kind: "lecture" }, window)).toBe(true)
    expect(matchesWindow(hit, { kind: "seminar" }, window)).toBe(false)
    expect(matchesWindow(hit, { online: false }, window)).toBe(false)
    expect(matchesWindow({ ...hit, startsAt: window.to }, {}, window)).toBe(false)
  })

  test("day counts cover seven days from a Monday", () => {
    const args = talksDayCountArgs({ online: true }, "2026-11-02")
    expect(args).toEqual({
      from: londonMidnight("2026-11-02"),
      to: londonMidnight("2026-11-09"),
      online: true,
    })
  })

  test("the total is counted over at most 62 days", () => {
    expect(talksCountArgs({}, window).capped).toBe(false)
    const long = talksWindow({ preset: "term" }, "2026-10-01", "2026-12-04")
    const { args, capped } = talksCountArgs({}, long)
    expect(capped).toBe(true)
    expect(args.to).toBe(londonMidnight("2026-12-02"))
  })
})
