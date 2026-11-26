import { describe, expect, test } from "bun:test"
import { editionsOf, editionYearOf, leadEdition, seriesTitle } from "./event-series"
import type { EventListItem } from "./public-api"

const at = (iso: string) => Date.parse(`${iso}T19:00:00Z`)
const event = (key: string, title: string, iso: string) =>
  ({ key, title, startsAt: at(iso), allDay: false }) as EventListItem

describe("series pages (ENG-282)", () => {
  const editions = editionsOf([
    event("a", "Greek Play 2026", "2026-10-15"),
    event("b", "Greek Play 2026", "2026-10-14"),
    event("c", "Greek Play 2029", "2029-10-14"),
    event("d", "Steele Bodger", "2027-11-24"),
  ])

  test("editions are named by the title's year, else the start's, newest first", () => {
    expect(editionYearOf(event("x", "Fairbairn Cup", "2026-12-03"))).toBe(2026)
    expect(editions.map((e) => e.year)).toEqual([2029, 2027, 2026])
    expect(editions[2].events.map((e) => e.key)).toEqual(["b", "a"])
  })

  test("a page leads with the next edition, else the latest held", () => {
    expect(leadEdition(editions, at("2026-11-01"))?.edition.year).toBe(2027)
    expect(leadEdition(editions, at("2026-10-01"))?.edition.year).toBe(2026)
    expect(leadEdition(editions, at("2031-01-01"))).toEqual({
      edition: editions[0],
      upcoming: false,
    })
    expect(leadEdition([], 0)).toBeUndefined()
  })

  test("titles name the year", () => {
    expect(seriesTitle("The Cambridge Greek Play", 2026)).toBe(
      "The Cambridge Greek Play 2026: dates & every year",
    )
  })
})
