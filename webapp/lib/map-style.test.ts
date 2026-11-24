import { describe, expect, test } from "bun:test"
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec"
import { CAMBRIDGE_BOUNDS, CITY_CENTRE, MAP_COLORS, MAP_MAX_BOUNDS, mapStyle } from "./map-style"

describe("the map style", () => {
  test("is a valid MapLibre style", () => {
    expect(validateStyleMin(mapStyle())).toEqual([])
  })

  test("reads only OpenFreeMap (the CSP's one map host) and draws no icons", () => {
    const style = JSON.stringify(mapStyle())
    const hosts = new Set([...style.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1]))
    // The attribution's links are navigations, not fetches.
    hosts.delete("openfreemap.org")
    hosts.delete("www.openmaptiles.org")
    hosts.delete("www.openstreetmap.org")
    expect([...hosts]).toEqual(["tiles.openfreemap.org"])
    expect(mapStyle().sprite).toBeUndefined()
  })

  test("keeps the OpenStreetMap attribution", () => {
    const source = mapStyle().sources.openmaptiles
    expect(source.type === "vector" && source.attribution).toContain("OpenStreetMap")
  })

  test("uses the DESIGN.md palette", () => {
    expect(MAP_COLORS.water).toBe("#d2e4eb")
    expect(MAP_COLORS.park).toBe("#e8f2f6")
    expect(MAP_COLORS.land).toBe("#f4f8fa")
    expect(MAP_COLORS.label).toBe("#545b5e")
  })

  test("opens on the city centre, inside the bounds it may be panned to", () => {
    const [west, south, east, north] = CAMBRIDGE_BOUNDS
    expect(CITY_CENTRE[0]).toBeGreaterThan(west)
    expect(CITY_CENTRE[0]).toBeLessThan(east)
    expect(CITY_CENTRE[1]).toBeGreaterThan(south)
    expect(CITY_CENTRE[1]).toBeLessThan(north)
    expect(MAP_MAX_BOUNDS[0]).toBeLessThan(west)
    expect(MAP_MAX_BOUNDS[3]).toBeGreaterThan(north)
  })
})
