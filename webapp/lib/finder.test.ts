import { describe, expect, test } from "bun:test"
import {
  EVENT_QUESTIONS,
  eventWindowDays,
  type FinderEvent,
  type FinderTalk,
  rankEvents,
  rankSocieties,
  rankTalks,
  SOCIETY_QUESTIONS,
  type SocietyFacts,
  scoreSociety,
  TALK_QUESTIONS,
  talkSchools,
  timeOfDay,
} from "./finder"

const card = (over: Partial<SocietyFacts> & { key: string }): SocietyFacts => ({
  name: over.key,
  categories: ["music"],
  activityTypes: [],
  audiences: [],
  collegeKeys: [],
  status: "active",
  level: "university",
  ...over,
})

describe("the quizzes", () => {
  test("have at most five questions with unique option ids, and ask nothing sensitive", () => {
    for (const quiz of [SOCIETY_QUESTIONS, EVENT_QUESTIONS, TALK_QUESTIONS]) {
      expect(quiz.length).toBeLessThanOrEqual(5)
      for (const q of quiz) {
        const ids = q.options.map((o) => o.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
    }
    const who = SOCIETY_QUESTIONS.find((q) => q.id === "who")
    expect(who?.options.map((o) => o.id)).toEqual([
      "undergraduates",
      "postgraduates",
      "international",
    ])
  })
})

describe("scoreSociety", () => {
  test("needs one of the chosen interests, and says why it matches", () => {
    expect(
      scoreSociety(card({ key: "a", categories: ["sport"] }), { interests: ["music"] }),
    ).toBeNull()
    const s = scoreSociety(card({ key: "b", beginnerFriendly: true }), {
      interests: ["music"],
      level: ["beginner"],
    })
    expect(s?.reasons).toEqual(["Music", "beginners welcome"])
  })

  test("never offers another college's own club; puts the student's college first", () => {
    const own = card({ key: "own", level: "college", collegeKeys: ["org-x"] })
    expect(scoreSociety(own, { interests: ["music"] }, "org-y")).toBeNull()
    expect(scoreSociety(own, { interests: ["music"] })).toBeNull()
    const mine = scoreSociety(own, { interests: ["music"], where: ["college"] }, "org-x")
    expect(mine?.reasons).toContain("at your college")
    expect(scoreSociety(own, { interests: ["music"], where: ["university"] }, "org-x")).toBeNull()
  })

  test("a beginner sees beginner-friendly clubs above ones that say they are not", () => {
    const ranked = rankSocieties(
      [
        card({ key: "pro", beginnerFriendly: false }),
        card({ key: "open", audiences: ["beginners"] }),
      ],
      { interests: ["music"], level: ["beginner"] },
    )
    expect(ranked.map((r) => r.item.key)).toEqual(["open", "pro"])
  })

  test("keeps the top fifteen", () => {
    const many = Array.from({ length: 40 }, (_, i) => card({ key: `s${i}` }))
    expect(rankSocieties(many, { interests: ["music"] })).toHaveLength(15)
  })
})

const NOW = Date.parse("2026-11-09T09:00:00Z")
const ev = (over: Partial<FinderEvent> & { key: string }): FinderEvent => ({
  title: over.key,
  startsAt: NOW + 3_600_000,
  allDay: false,
  eventType: "social",
  cancelled: false,
  talksDerived: false,
  hosting: "hosts",
  organisers: [{ key: `org-${over.key}`, name: over.key, slug: over.key }],
  ...over,
})

describe("rankEvents", () => {
  test("drops cancelled, past and talks-derived events, one row per show, two per organiser", () => {
    const shared = [{ key: "org-adc", name: "ADC", slug: "adc" }]
    const ranked = rankEvents(
      [
        ev({ key: "gone", startsAt: NOW - 7_200_000 }),
        ev({ key: "off", cancelled: true }),
        ev({ key: "talks", talksDerived: true }),
        ev({ key: "n1", title: "Show", organisers: shared }),
        ev({ key: "n2", title: "Show", organisers: shared, startsAt: NOW + 86_400_000 }),
        ev({ key: "x", title: "Other", organisers: shared }),
        ev({ key: "y", title: "Third", organisers: shared }),
      ],
      {},
      NOW,
    )
    expect(ranked.map((r) => r.item.key)).toEqual(["n1", "x"])
  })

  test("prefers the time of day asked for", () => {
    const evening = Date.parse("2026-11-09T19:00:00Z")
    const ranked = rankEvents(
      [ev({ key: "am" }), ev({ key: "pm", startsAt: evening })],
      { time: ["evening"] },
      NOW,
      1,
    )
    expect(ranked[0].item.key).toBe("pm")
    expect(timeOfDay({ startsAt: evening, allDay: false })).toBe("evening")
  })

  test("the window follows the 'when' answer", () => {
    expect(eventWindowDays({ when: ["soon"] })).toBe(2)
    expect(eventWindowDays({ when: ["week"] })).toBe(7)
    expect(eventWindowDays({})).toBe(14)
  })
})

describe("rankTalks", () => {
  const talk = (over: Partial<FinderTalk> & { key: string }): FinderTalk => ({
    title: over.key,
    startsAt: Date.parse("2026-11-10T13:00:00Z"),
    allDay: false,
    online: false,
    kind: "seminar",
    cancelled: false,
    series: null,
    ...over,
  })
  test("honours online and kind, and keeps two per series", () => {
    const ranked = rankTalks(
      [
        talk({ key: "a", series: "S" }),
        talk({ key: "b", series: "S" }),
        talk({ key: "c", series: "S" }),
        talk({ key: "web", online: true }),
        talk({ key: "lec", kind: "lecture" }),
      ],
      { online: ["person"], kind: ["seminar"] },
      NOW,
    )
    expect(ranked.map((r) => r.item.key).sort()).toEqual(["a", "b", "lec"])
    expect(ranked.find((r) => r.item.key === "a")?.reasons).toContain("seminar")
  })

  test("every school when none is picked", () => {
    expect(talkSchools({ areas: ["technology"] })).toEqual(["technology"])
    expect(talkSchools({}).length).toBe(7)
  })
})
