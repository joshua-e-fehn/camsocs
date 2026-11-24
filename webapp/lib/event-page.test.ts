import { describe, expect, test } from "bun:test"
import { locatedVenue, structuredVenue } from "./event-page"

// Invented places only.

const VENUE = {
  key: "ven-invented-hall",
  name: "Invented Hall",
  aliases: [],
  address: "1 Invented Street, Cambridge CB2 3EQ",
  lat: 52.2041,
  lng: 0.1218,
}
const KEYED = { name: "The keyed venue" }

describe("the JSON-LD Place's venue (docs/locations-and-map.md §3)", () => {
  test("a resolved building with coordinates stands in for the keyed venue", () => {
    expect(structuredVenue(KEYED, { precision: "exact", venue: VENUE })).toEqual({
      name: "Invented Hall",
      address: "1 Invented Street, Cambridge CB2 3EQ",
      collegeKey: undefined,
      lat: 52.2041,
      lng: 0.1218,
    })
    expect(locatedVenue({ precision: "building", venue: VENUE })?.lat).toBe(52.2041)
  })

  test("never an area's anchor, an unplaced venue or no row", () => {
    expect(structuredVenue(KEYED, { precision: "area", areaLabel: "Central", venue: VENUE })).toBe(
      KEYED,
    )
    expect(
      structuredVenue(KEYED, { precision: "exact", venue: { ...VENUE, lat: undefined } }),
    ).toBe(KEYED)
    expect(structuredVenue(undefined, null)).toBeUndefined()
    expect(locatedVenue({ precision: "online", venue: null })).toBeUndefined()
  })
})
