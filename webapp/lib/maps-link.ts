/**
 * Links to a place in the visitor's maps app (docs/locations-and-map.md §1d,
 * owner decision 1): Apple Maps on Apple platforms, Google Maps elsewhere.
 * Pure and dependency-free, so pages, molecules and tests share it.
 *
 * Coordinates come from OpenStreetMap; a Google place id, when known, makes
 * the Google link open the exact place rather than a search.
 *
 * `preferredMapsHref` reads the user agent, so call it in the browser only:
 * the server renders the Google link and the client swaps it after
 * hydration.
 */

export type MapsPlace = {
  name: string
  address?: string
  lat: number
  lng: number
  googlePlaceId?: string
}

export type MapsLinks = { apple: string; google: string }

/** Coordinates as maps apps take them: six decimals (~0.1 m). */
function coord(value: number): string {
  return String(Math.round(value * 1e6) / 1e6)
}

function latLng(place: MapsPlace): string {
  return `${coord(place.lat)},${coord(place.lng)}`
}

/** Open the place: Apple `?q=<name>&ll=<lat>,<lng>`, Google search with the place id. */
export function mapsLinks(place: MapsPlace): MapsLinks {
  const name = place.name.trim()
  const apple = `https://maps.apple.com/?q=${encodeURIComponent(name || latLng(place))}&ll=${latLng(place)}`
  const query = name || latLng(place)
  const google =
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` +
    (place.googlePlaceId ? `&query_place_id=${encodeURIComponent(place.googlePlaceId)}` : "")
  return { apple, google }
}

/** Directions to the place: Apple `daddr=`, Google `/maps/dir/`. */
export function directionsLinks(place: MapsPlace): MapsLinks {
  const name = place.name.trim()
  const apple = `https://maps.apple.com/?daddr=${latLng(place)}${name ? `&q=${encodeURIComponent(name)}` : ""}`
  // With a place id Google routes to the place itself; else to the coordinates.
  const destination = place.googlePlaceId ? name || latLng(place) : latLng(place)
  const google =
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` +
    (place.googlePlaceId ? `&destination_place_id=${encodeURIComponent(place.googlePlaceId)}` : "")
  return { apple, google }
}

/** Apple platforms: iPhone, iPad (including iPadOS's desktop user agent) and the Mac. */
export function isApplePlatform(userAgent: string | undefined | null): boolean {
  if (!userAgent) return false
  return /\b(iPhone|iPad|iPod|Macintosh|Mac OS X)\b/.test(userAgent)
}

/** The link for this visitor: Apple Maps on Apple platforms, else Google Maps. */
export function preferredMapsHref(links: MapsLinks, userAgent: string | undefined | null): string {
  return isApplePlatform(userAgent) ? links.apple : links.google
}

/** Directions for this visitor (`directionsLinks`, then `preferredMapsHref`). */
export function directionsHref(place: MapsPlace, userAgent: string | undefined | null): string {
  return preferredMapsHref(directionsLinks(place), userAgent)
}
