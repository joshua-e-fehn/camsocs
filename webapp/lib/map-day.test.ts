import { describe, expect, test } from "bun:test"
import { dayWindow, londonMidnight } from "./calendar"
import {
  countPhrase,
  farAway,
  itemEnd,
  itemStatus,
  mapPins,
  mapSections,
  pinnable,
  shownItems,
} from "./map-day"
import type { MapItem } from "./public-api"

const HOUR = 60 * 60 * 1000
const DAY = dayWindow("2026-11-24", 1)
const at = (hour: number) => londonMidnight("2026-11-24") + hour * HOUR

function item(over: Partial<MapItem> & Pick<MapItem, "key">): MapItem {
  return {
    kind: "event",
    title: "An invented event",
    startsAt: at(18),
    endsAt: at(20),
    allDay: false,
    href: `/events/${over.key}`,
    cancelled: false,
    precision: "exact",
    venueKey: "ven-a",
    placeLabel: "Venue A",
    ...over,
  }
}

const VENUES = [
  { key: "ven-a", name: "Venue A", aliases: [], lat: 52.2, lng: 0.12 },
  { key: "ven-b", name: "Venue B", aliases: [], lat: 52.21, lng: 0.11 },
  // No coordinates: no pin.
  { key: "ven-c", name: "Venue C", aliases: [] },
]

describe("past and now", () => {
  test("an item ends at endsAt, else an hour after it starts, else (all day) at midnight", () => {
    expect(itemEnd(item({ key: "a" }))).toBe(at(20))
    expect(itemEnd(item({ key: "a", endsAt: null }))).toBe(at(19))
    expect(itemEnd(item({ key: "a", startsAt: at(0), endsAt: null, allDay: true }))).toBe(
      londonMidnight("2026-11-25"),
    )
  })

  test("on today, by its own times", () => {
    const evening = item({ key: "a" })
    expect(itemStatus(evening, at(17), DAY)).toBe("upcoming")
    expect(itemStatus(evening, at(18), DAY)).toBe("now")
    expect(itemStatus(evening, at(19.99), DAY)).toBe("now")
    expect(itemStatus(evening, at(20), DAY)).toBe("past")
  })

  test("every item on a past day is over, and none on a future day is", () => {
    // A three-day event still running: grey on the day behind it.
    const long = item({ key: "a", startsAt: at(-24), endsAt: at(48) })
    expect(itemStatus(long, at(30), DAY)).toBe("past")
    expect(itemStatus(item({ key: "b", startsAt: at(1), endsAt: at(2) }), at(-30), DAY)).toBe(
      "upcoming",
    )
  })
})

describe("pins and sections", () => {
  const items = [
    item({ key: "a", startsAt: at(9), endsAt: at(10) }),
    item({ key: "b", kind: "talk", startsAt: at(12), endsAt: at(13), href: "/talks/b" }),
    item({ key: "c", kind: "talk", venueKey: "ven-b", startsAt: at(14), endsAt: at(15) }),
    item({ key: "d", venueKey: "ven-c" }),
    item({ key: "e", precision: "online", venueKey: null, placeLabel: "Online" }),
    item({ key: "f", precision: "unknown", venueKey: null, placeLabel: "" }),
  ]

  test("one pin per venue with coordinates, numbered by its items, styled by kind", () => {
    const pins = mapPins(items, VENUES, at(12.5), DAY)
    expect(pins.map((pin) => [pin.venueKey, pin.items.length, pin.kind, pin.status])).toEqual([
      ["ven-a", 2, "event", "now"],
      ["ven-b", 1, "talk", "upcoming"],
    ])
    expect(pins[0].label).toBe("Venue A: 1 event, 1 talk, one on now")
    expect(mapPins(items, VENUES, at(16), DAY).every((pin) => pin.status === "past")).toBe(true)
    expect(mapPins(items, VENUES, at(16), DAY)[1].label).toBe("Venue B: 1 talk, ended")
  })

  test("online items and those with no place go in their own sections", () => {
    const { placed, away, online, tbc } = mapSections(items, VENUES)
    expect(placed.map((x) => x.key)).toEqual(["a", "b", "c", "d"])
    expect(away).toEqual([])
    expect(online.map((x) => x.key)).toEqual(["e"])
    expect(tbc.map((x) => x.key)).toEqual(["f"])
  })

  test("the toggles keep one kind", () => {
    expect(shownItems(items, "talks").map((x) => x.key)).toEqual(["b", "c"])
    expect(shownItems(items, "events")).toHaveLength(4)
    expect(shownItems(items, "all")).toHaveLength(6)
    expect(countPhrase(items)).toBe("4 events, 2 talks")
    expect(countPhrase([])).toBe("")
  })
})

describe("away from Cambridge", () => {
  const FAR = [
    ...VENUES,
    // An away golf fixture in Surrey, a tour venue in Bern, and a village hall
    // just south of the city (still pinned).
    { key: "ven-golf", name: "Invented Golf Club", aliases: [], lat: 51.305, lng: -0.585 },
    { key: "ven-bern", name: "Invented Gymnasium", aliases: [], lat: 46.95, lng: 7.44 },
    { key: "ven-shelford", name: "Invented Memorial Hall", aliases: [], lat: 52.149, lng: 0.137 },
  ]
  const items = [
    item({ key: "a", startsAt: at(9) }),
    item({ key: "golf", venueKey: "ven-golf", startsAt: at(10), placeLabel: "Invented Golf Club" }),
    item({ key: "bern", venueKey: "ven-bern", precision: "area", startsAt: at(11) }),
    item({ key: "shelford", venueKey: "ven-shelford", startsAt: at(12) }),
  ]

  test("a far venue gets no pin, so the map never fits to it", () => {
    const pins = mapPins(items, FAR, at(8), DAY)
    expect(pins.map((pin) => pin.venueKey)).toEqual(["ven-a", "ven-shelford"])
  })

  test("its items are listed under Away from Cambridge, in start order", () => {
    const { placed, away } = mapSections(items, FAR)
    expect(placed.map((x) => x.key)).toEqual(["a", "shelford"])
    expect(away.map((x) => x.key)).toEqual(["golf", "bern"])
  })

  test("pinnable and farAway read the venue's coordinates", () => {
    expect(pinnable(FAR[0])).toBe(true)
    expect(pinnable(FAR[2])).toBe(false)
    expect(farAway(FAR[2])).toBe(false)
    expect(farAway(FAR[3])).toBe(true)
    expect(farAway(undefined)).toBe(false)
  })
})
