import { describe, expect, test } from "bun:test"
import { dedupeRuns, rowingRaces, type SportEvent, varsityFixtures } from "./sport-calendar"

const DAY = 86_400_000
const T0 = Date.parse("2026-12-03T00:00:00Z")
const org = (slug: string) => ({ key: `org-${slug}`, name: slug, slug })
const ev = (over: Partial<SportEvent> & { title: string }): SportEvent => ({
  key: `evt-${over.title}`,
  startsAt: T0,
  allDay: true,
  organisers: [org("jesus-college-boat-club")],
  ...over,
})

describe("rowing races", () => {
  test("keeps one listing per race and day, the host's first", () => {
    const races = rowingRaces([
      ev({
        title: "Fairbairn Cup (novices)",
        hosting: "takes_part",
        source: "cucbc",
        organisers: [org("clare-hall-boat-club")],
      }),
      ev({ title: "Fairbairn Cup - Novices (Jesus)", hosting: "hosts", source: "cucbc" }),
      ev({
        title: "Fairbairn Cup - Seniors (Jesus)",
        hosting: "hosts",
        source: "cucbc",
        startsAt: T0 + DAY,
      }),
    ])
    expect(races.map((r) => r.title)).toEqual([
      "Fairbairn Cup - Novices (Jesus)",
      "Fairbairn Cup - Seniors (Jesus)",
    ])
  })

  test("leaves out non-rowing events, other clubs' heads and cancelled races", () => {
    const races = rowingRaces([
      ev({ title: "Boat club social", source: "cucbc" }),
      ev({ title: "A head of department talk", organisers: [org("economics-society")] }),
      ev({ title: "Lent Bumps", cancelled: true, source: "cucbc" }),
      ev({
        title: "Lent Bumps Getting-On Race",
        source: "website",
        organisers: [org("clare-hall-boat-club")],
      }),
      ev({ title: "Trial Eights", organisers: [org("boat-club-rowing")], startsAt: T0 + DAY }),
      ev({ title: "Newnham Head", source: "cucbc", startsAt: T0 + 2 * DAY }),
    ])
    expect(races.map((r) => r.title)).toEqual(["Trial Eights", "Newnham Head"])
  })
})

describe("varsity fixtures", () => {
  test("picks Varsity matches from any club, never talks.cam-derived ones", () => {
    const fixtures = varsityFixtures([
      ev({ title: "Varsity Match", organisers: [org("rugby-fives-club")] }),
      ev({ title: "Varsity Match talk", talksDerived: true, startsAt: T0 + DAY }),
      ev({ title: "Training", startsAt: T0 + DAY }),
    ])
    expect(fixtures.map((f) => f.title)).toEqual(["Varsity Match"])
  })
})

test("dedupeRuns keeps different races on the same day", () => {
  expect(
    dedupeRuns([ev({ title: "Clare Novice Regatta" }), ev({ title: "Emmanuel Sprint Regatta" })]),
  ).toHaveLength(2)
})
