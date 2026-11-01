import { describe, expect, test } from "bun:test"
import { londonMidnight } from "../../lib/calendar"
import type { Doc } from "../_generated/dataModel"
import type { TermDates } from "./derived"
import {
  type ActivityRow,
  activityCounts,
  activityRows,
  activityWindow,
  countRuns,
  countsAsActivity,
  relatedCards,
  relatedScore,
  runIdOf,
  runKeyOf,
  sortByActivity,
  termSpan,
  weekWindow,
} from "./orgActivity"

// Michaelmas 2026: Full Term Tue 6 Oct – Fri 4 Dec; Week 1 starts Thu 8 Oct.
const MICHAELMAS: TermDates = {
  academicYear: "2026-27",
  term: "michaelmas",
  fullTermStart: "2026-10-06",
  fullTermEnd: "2026-12-04",
}
const LENT: TermDates = {
  academicYear: "2026-27",
  term: "lent",
  fullTermStart: "2027-01-19",
  fullTermEnd: "2027-03-19",
}
const TERMS = [MICHAELMAS, LENT]
const noon = (iso: string) => londonMidnight(iso) + 12 * 3_600_000

describe("terms and weeks", () => {
  test("a term's labelled weeks run from Week 0's Thursday to the end of Full Term", () => {
    expect(termSpan(MICHAELMAS)).toEqual({ start: "2026-10-01", end: "2026-12-04" })
  })

  test("in term the activity window is the term, else the next eight weeks", () => {
    expect(activityWindow(TERMS, noon("2026-10-31"))).toEqual({
      from: londonMidnight("2026-10-01"),
      to: londonMidnight("2026-12-05"),
      inTerm: true,
    })
    expect(activityWindow(TERMS, noon("2026-12-20"))).toEqual({
      from: londonMidnight("2026-12-20"),
      to: londonMidnight("2027-02-14"),
      inTerm: false,
    })
    expect(activityWindow([], noon("2026-10-31")).inTerm).toBe(false)
  })

  test("the week window is the term week (Thursday to Wednesday), else seven days", () => {
    // Sat 31 Oct 2026 is in Week 4 (Thu 29 Oct – Wed 4 Nov).
    expect(weekWindow(TERMS, noon("2026-10-31"))).toEqual({
      from: londonMidnight("2026-10-29"),
      to: londonMidnight("2026-11-05"),
      inTerm: true,
    })
    // A Thursday starts its own week; Week 0 counts.
    expect(weekWindow(TERMS, noon("2026-10-01")).from).toBe(londonMidnight("2026-10-01"))
    expect(weekWindow(TERMS, noon("2026-10-08")).from).toBe(londonMidnight("2026-10-08"))
    expect(weekWindow(TERMS, noon("2026-12-25"))).toEqual({
      from: londonMidnight("2026-12-25"),
      to: londonMidnight("2027-01-01"),
      inTerm: false,
    })
  })
})

describe("activity counts", () => {
  const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
    eventKey: "evt-1",
    orgKey: "org-a",
    role: "organiser",
    visibility: "public",
    startsAt: noon("2026-10-29"),
    ...overrides,
  })

  test("only an organisation's own public events count", () => {
    const removed = new Set(["evt-gone"])
    expect(countsAsActivity(row(), removed)).toBe(true)
    expect(countsAsActivity(row({ hosting: "hosts", role: "co_host" }), removed)).toBe(true)
    expect(countsAsActivity(row({ role: "sponsor" }), removed)).toBe(false)
    expect(countsAsActivity(row({ hosting: "takes_part" }), removed)).toBe(false)
    expect(countsAsActivity(row({ visibility: "cam_only" }), removed)).toBe(false)
    expect(countsAsActivity(row({ visibility: "members_only" }), removed)).toBe(false)
    expect(countsAsActivity(row({ eventKey: "evt-gone" }), removed)).toBe(false)
    expect(countsAsActivity(row({ cancelled: true }), removed)).toBe(false)
    // A row from before the copy: not known to be cancelled.
    expect(countsAsActivity(row({ cancelled: undefined }), removed)).toBe(true)
  })

  test("counts each event once per organisation", () => {
    const counts = activityCounts(
      [
        row(),
        row({ role: "co_host" }),
        row({ eventKey: "evt-2" }),
        row({ orgKey: "org-b" }),
        row({ orgKey: "org-c", hosting: "takes_part" }),
      ],
      new Set(),
    )
    expect(Object.fromEntries(counts)).toEqual({ "org-a": 2, "org-b": 1 })
  })

  test("an event stands for its organisers and co-hosts, never its sponsors", () => {
    const rows = activityRows({
      key: "evt-1",
      organiserKeys: ["org-a", "org-b"],
      coHostKeys: ["org-b", "org-c"],
      sponsorKeys: ["org-d"],
      visibility: "public",
      hosting: undefined,
      title: "Top Girls",
      startsAt: noon("2026-10-29"),
      cancelled: false,
    })
    expect(rows.map((r) => [r.orgKey, r.role])).toEqual([
      ["org-a", "organiser"],
      ["org-b", "organiser"],
      ["org-c", "co_host"],
    ])
    expect(new Set(rows.map((r) => r.runKey))).toEqual(new Set([runKeyOf("Top Girls")]))
  })

  test("a run's title is normalised: case, accents, punctuation and spacing", () => {
    expect(runKeyOf("Top Girls!")).toBe(runKeyOf("  TOP   girls "))
    expect(runKeyOf("Café Scientifique")).toBe(runKeyOf("cafe scientifique"))
    expect(runKeyOf("Top Girls")).not.toBe(runKeyOf("Top Boys"))
    expect(runKeyOf("Top Girls")).toMatch(/^[0-9a-f]{16}$/)
  })

  test("a show's nights in one week are one run; a weekly event counts each week", () => {
    const show = runKeyOf("Top Girls")
    const jazz = runKeyOf("Jazz night")
    const rows = [
      // Tue 27 – Sat 31 Oct 2026, five nights and a matinee: one run.
      ...["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"].map((day, i) =>
        row({ eventKey: `evt-show-${i}`, runKey: show, startsAt: noon(day) }),
      ),
      row({ eventKey: "evt-show-matinee", runKey: show, startsAt: noon("2026-10-31") - 3_600_000 }),
      // The same title the next week is the run's second week.
      row({ eventKey: "evt-show-2", runKey: show, startsAt: noon("2026-11-03") }),
      // A weekly event: once a week, twice.
      row({ eventKey: "evt-jazz-1", runKey: jazz, startsAt: noon("2026-10-29") }),
      row({ eventKey: "evt-jazz-2", runKey: jazz, startsAt: noon("2026-11-05") }),
      // A row from before the copy is its own run.
      row({ eventKey: "evt-old", startsAt: noon("2026-10-29") }),
    ]
    expect(countRuns(rows)).toBe(5)
    expect(Object.fromEntries(activityCounts(rows, new Set()))).toEqual({ "org-a": 5 })
    // A Sunday belongs to the week before, a Monday to its own.
    expect(runIdOf(row({ runKey: show, startsAt: noon("2026-11-01") }))).toBe(
      runIdOf(row({ runKey: show, startsAt: noon("2026-10-27") })),
    )
    expect(runIdOf(row({ runKey: show, startsAt: noon("2026-11-02") }))).not.toBe(
      runIdOf(row({ runKey: show, startsAt: noon("2026-11-01") })),
    )
  })

  test("cancelled nights drop out of a run, and a cancelled run counts nothing", () => {
    const show = runKeyOf("Top Girls")
    const counts = activityCounts(
      [
        row({ eventKey: "evt-1", runKey: show, cancelled: true }),
        row({ eventKey: "evt-2", runKey: show, startsAt: noon("2026-10-30") }),
        row({ orgKey: "org-b", eventKey: "evt-3", runKey: show, cancelled: true }),
      ],
      new Set(),
    )
    expect(Object.fromEntries(counts)).toEqual({ "org-a": 1 })
  })

  test("busiest first, ties in their incoming order", () => {
    const cards = ["a", "b", "c", "d"].map((key) => ({ key }))
    const counts = new Map([
      ["c", 3],
      ["b", 1],
      ["d", 1],
    ])
    expect(sortByActivity(cards, counts).map((c) => c.key)).toEqual(["c", "b", "d", "a"])
  })
})

describe("related listings", () => {
  type Card = Parameters<typeof relatedScore>[0]
  const card = (key: string, overrides: Partial<Doc<"orgCards">> = {}): Card => ({
    key,
    nameSort: key,
    categories: [],
    collegeKeys: [],
    level: "university",
    status: "active",
    isCounterpart: false,
    ...overrides,
  })
  const base = card("chess", {
    categories: ["hobbies_games", "academic"],
    collegeKeys: ["org-selwyn"],
    level: "college",
  })

  test("nothing in common, itself, a counterpart or a defunct group: unrelated", () => {
    expect(relatedScore(base, card("rowing", { categories: ["sport"] }))).toBe(0)
    expect(relatedScore(base, base)).toBe(0)
    expect(
      relatedScore(base, card("x", { categories: ["hobbies_games"], isCounterpart: true })),
    ).toBe(0)
    expect(
      relatedScore(base, card("y", { categories: ["hobbies_games"], status: "archived" })),
    ).toBe(0)
  })

  test("the same college first, then shared categories, then by name", () => {
    const cards = [
      card("b-go", { categories: ["hobbies_games"] }),
      card("a-go", { categories: ["hobbies_games"] }),
      card("selwyn-choir", { categories: ["music"], collegeKeys: ["org-selwyn"] }),
      card("maths", { categories: ["academic"] }),
      card("selwyn-games", {
        categories: ["hobbies_games"],
        collegeKeys: ["org-selwyn"],
        level: "college",
      }),
      card("rowing", { categories: ["sport"] }),
    ]
    expect(relatedCards(base, cards, 4).map((c) => c.key)).toEqual([
      "selwyn-games",
      "selwyn-choir",
      "a-go",
      "b-go",
    ])
  })
})
