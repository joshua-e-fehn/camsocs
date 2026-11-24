import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { type PlacedLocation, PlaceLine, placeLineModel } from "@/components/molecules/place-line"

// Invented places only.

const VENUE = {
  key: "ven-invented-hall",
  name: "Invented Hall",
  aliases: [],
  address: "1 Invented Street, Cambridge CB2 3EQ",
  lat: 52.2041,
  lng: 0.1218,
  googlePlaceId: "ChIJinventedPlace01",
}

const EXACT: PlacedLocation = { precision: "exact", room: "Seminar Room 1", venue: VENUE }

function html(node: React.ReactNode): string {
  return renderToString(node).replaceAll("<!-- -->", "").replaceAll("&amp;", "&")
}

describe("placeLineModel", () => {
  test("exact: room and venue, the address, maps links and the map", () => {
    const model = placeLineModel(EXACT, "Room 1, the hall")
    expect(model.label).toBe("Seminar Room 1, Invented Hall")
    expect(model.details).toEqual(["1 Invented Street, Cambridge CB2 3EQ"])
    expect(model.maps?.apple).toContain("maps.apple.com")
    expect(model.maps?.google).toContain("query_place_id=ChIJinventedPlace01")
    expect(model.onMap).toBe(true)
  })

  test("a venue name from OpenStreetMap is printed without its university suffix", () => {
    const model = placeLineModel({
      ...EXACT,
      venue: { ...VENUE, name: "Invented Hall (University of Cambridge)" },
    })
    expect(model.label).toBe("Seminar Room 1, Invented Hall")
  })

  test("building: says it is inferred", () => {
    const model = placeLineModel({ precision: "building", venue: VENUE })
    expect(model.label).toBe("Invented Hall")
    expect(model.details).toContain("Building inferred from the listing")
  })

  test("a venue with no coordinates yet: a Google search, not on the map", () => {
    const model = placeLineModel({
      precision: "exact",
      venue: { ...VENUE, lat: undefined, lng: undefined },
    })
    expect(model.maps?.apple).toBeUndefined()
    expect(model.maps?.google).toContain("query=Invented%20Hall%2C%20Cambridge")
    expect(model.onMap).toBe(false)
  })

  test("area: the stated area, no maps link, on the map at its anchor", () => {
    const model = placeLineModel({
      precision: "area",
      areaLabel: "Central Cambridge (exact place sent to attendees)",
      venue: VENUE,
    })
    expect(model.label).toBe("Central Cambridge (exact place sent to attendees)")
    expect(model.maps).toBeUndefined()
    expect(model.onMap).toBe(true)
  })

  test("a venue far from Cambridge: maps links, but no See on the map (it has no pin)", () => {
    const far = {
      ...VENUE,
      name: "Invented Golf Club",
      address: "Pond Road, Woking",
      lat: 51.305,
      lng: -0.585,
    }
    const exact = placeLineModel({ precision: "exact", venue: far })
    expect(exact.maps?.google).toContain("query_place_id=ChIJinventedPlace01")
    expect(exact.onMap).toBe(false)
    const town = placeLineModel({ precision: "area", areaLabel: "Invented Town", venue: far })
    expect(town.label).toBe("Invented Town")
    expect(town.maps?.apple).toContain("maps.apple.com")
    expect(town.onMap).toBe(false)
  })

  test("online and unknown", () => {
    expect(placeLineModel({ precision: "online", venue: null }).label).toBe("Online")
    expect(placeLineModel({ precision: "online", venue: null }, "Zoom").label).toBe("Zoom")
    expect(placeLineModel({ precision: "unknown", venue: null })).toEqual({
      label: undefined,
      details: [],
      onMap: false,
    })
    expect(placeLineModel({ precision: "unknown", venue: null }, "The usual pub").details).toEqual([
      "Location to be confirmed",
    ])
  })
})

describe("PlaceLine", () => {
  test("the server renders the Google link and the day on /map", () => {
    const out = html(<PlaceLine location={EXACT} day="2026-11-24" />)
    expect(out).toContain("Seminar Room 1, Invented Hall")
    expect(out).toContain("1 Invented Street")
    expect(out).toContain('href="https://www.google.com/maps/search/?api=1')
    expect(out).not.toContain("maps.apple.com")
    expect(out).toContain('href="/map?d=2026-11-24"')
    expect(out).toContain("See on the map")
  })

  test("unknown with nothing to say: Location to be confirmed, no links", () => {
    const out = html(
      <PlaceLine location={{ precision: "unknown", venue: null }} day="2026-11-24" />,
    )
    expect(out).toContain("Location to be confirmed")
    expect(out).not.toContain("Open in Maps")
    expect(out).not.toContain("/map?d=")
  })
})
