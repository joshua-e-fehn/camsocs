import { describe, expect, test } from "bun:test"
import { clip, eventCard, MAX_HEADLINE, societyCard } from "./og-card"

/** 5 Nov 2026 is GMT: 19:30 UTC is 19:30 in London. Invented event. */
const STARTS = Date.UTC(2026, 10, 5, 19, 30)

const event = {
  title: "Open chess night ♟️",
  startsAt: STARTS,
  allDay: false,
  cancelled: false,
  visibility: "public" as const,
  venueText: "Old Library",
  organisers: [
    { key: "org-chess-club", slug: "chess-club", name: "Chess Club", role: "organiser" as const },
  ],
  talksDerived: false,
  termWeekLabel: "MT26 Wk 4",
}

describe("an event's card", () => {
  test("says when, what, who and where", () => {
    expect(eventCard(event)).toEqual({
      eyebrow: "Thu 5 Nov · 19:30 · MT26 Wk 4",
      headline: "Open chess night",
      detail: "Chess Club · Old Library",
    })
  })

  test("says when it is cancelled", () => {
    expect(eventCard({ ...event, cancelled: true })?.headline).toBe("Cancelled: Open chess night")
  })

  test("is the generic card for anything not public", () => {
    expect(eventCard({ ...event, visibility: "cam_only" })).toBeNull()
    expect(eventCard({ ...event, visibility: "members_only" })).toBeNull()
  })

  test("never draws a talks.cam-derived event (G1, Convex's verdict)", () => {
    expect(eventCard({ ...event, talksDerived: true })).toBeNull()
  })
})

test("a society's card: its kinds, name and short name", () => {
  expect(
    societyCard({
      name: "Cambridge University Chess Club",
      shortName: "CUCC",
      categories: ["hobbies_games"],
    }),
  ).toMatchObject({ headline: "Cambridge University Chess Club", detail: "CUCC" })
  expect(societyCard({ name: "Chess Club", categories: [] }).eyebrow).toBe("Society")
})

test("a long headline is cut at a word", () => {
  const long = "A very long society name ".repeat(6)
  const text = clip(long)
  expect(text.length).toBeLessThanOrEqual(MAX_HEADLINE)
  expect(text.endsWith("…")).toBe(true)
})
