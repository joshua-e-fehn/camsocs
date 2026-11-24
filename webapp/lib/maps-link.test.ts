import { describe, expect, test } from "bun:test"
import {
  directionsHref,
  directionsLinks,
  isApplePlatform,
  mapsLinks,
  preferredMapsHref,
} from "./maps-link"

const INI = { name: "Isaac Newton Institute", lat: 52.2101234567, lng: 0.0912 }
const PLACE_ID = "ChIJxyz123abcDEF_-456"

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131 Mobile"
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131"

describe("mapsLinks", () => {
  test("Apple opens the name at the coordinates, rounded to six decimals", () => {
    expect(mapsLinks(INI).apple).toBe(
      "https://maps.apple.com/?q=Isaac%20Newton%20Institute&ll=52.210123,0.0912",
    )
  })

  test("Google searches the name, and opens the exact place with a place id", () => {
    expect(mapsLinks(INI).google).toBe(
      "https://www.google.com/maps/search/?api=1&query=Isaac%20Newton%20Institute",
    )
    expect(mapsLinks({ ...INI, googlePlaceId: PLACE_ID }).google).toBe(
      `https://www.google.com/maps/search/?api=1&query=Isaac%20Newton%20Institute&query_place_id=${PLACE_ID}`,
    )
  })

  test("a blank name falls back to the coordinates", () => {
    const links = mapsLinks({ ...INI, name: "  " })
    expect(links.apple).toBe("https://maps.apple.com/?q=52.210123%2C0.0912&ll=52.210123,0.0912")
    expect(links.google).toBe("https://www.google.com/maps/search/?api=1&query=52.210123%2C0.0912")
  })

  test("names are URL-encoded", () => {
    const links = mapsLinks({ ...INI, name: "St John's College & Chapel" })
    expect(links.apple).toContain("q=St%20John's%20College%20%26%20Chapel&")
    expect(links.google).toContain("query=St%20John's%20College%20%26%20Chapel")
  })
})

describe("directionsLinks", () => {
  test("Apple uses daddr; Google routes to the coordinates", () => {
    expect(directionsLinks(INI)).toEqual({
      apple: "https://maps.apple.com/?daddr=52.210123,0.0912&q=Isaac%20Newton%20Institute",
      google: "https://www.google.com/maps/dir/?api=1&destination=52.210123%2C0.0912",
    })
  })

  test("Google routes to the place itself with a place id", () => {
    expect(directionsLinks({ ...INI, googlePlaceId: PLACE_ID }).google).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=Isaac%20Newton%20Institute&destination_place_id=${PLACE_ID}`,
    )
  })
})

describe("preferredMapsHref", () => {
  const links = mapsLinks(INI)

  test("Apple Maps on iPhone, iPad and the Mac", () => {
    expect(isApplePlatform(IPHONE)).toBe(true)
    expect(isApplePlatform(MAC)).toBe(true)
    expect(isApplePlatform(IPAD_DESKTOP)).toBe(true)
    expect(preferredMapsHref(links, IPHONE)).toBe(links.apple)
  })

  test("Google Maps everywhere else, and when the user agent is unknown", () => {
    expect(preferredMapsHref(links, ANDROID)).toBe(links.google)
    expect(preferredMapsHref(links, WINDOWS)).toBe(links.google)
    expect(preferredMapsHref(links, undefined)).toBe(links.google)
    expect(preferredMapsHref(links, "")).toBe(links.google)
  })

  test("directionsHref picks the platform's directions link", () => {
    expect(directionsHref(INI, MAC)).toBe(directionsLinks(INI).apple)
    expect(directionsHref(INI, ANDROID)).toBe(directionsLinks(INI).google)
  })
})
