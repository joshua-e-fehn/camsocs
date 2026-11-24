"use client"

import { ArrowUpRightIcon, MapIcon } from "lucide-react"
import Link from "next/link"
import { useSyncExternalStore } from "react"
import { linkProps } from "@/lib/crawl-traps"
import { mapsLinks, preferredMapsHref } from "@/lib/maps-link"
import type { ItemLocation } from "@/lib/public-api"

export type PlacedLocation = NonNullable<ItemLocation>

/** What the "Where" row says for one resolved location (docs/locations-and-map.md §3). */
export type PlaceLineModel = {
  /** The line in medium weight; absent when nothing is known ("Location to
   * be confirmed", muted). */
  label?: string
  /** Muted lines under it: the address, or what is still to come. */
  details: string[]
  /** Open in Maps: the place in Apple or Google Maps, else a Google search. */
  maps?: { google: string; apple?: string }
  /** The item's day on /map, when its place has a pin there. */
  onMap: boolean
}

function hasCoordinates(
  venue: PlacedLocation["venue"],
): venue is NonNullable<PlacedLocation["venue"]> & { lat: number; lng: number } {
  return venue?.lat !== undefined && venue.lng !== undefined
}

function googleSearch(text: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${text}, Cambridge`)}`
}

/**
 * The words and links for a resolved location:
 *  - `exact` / `building`: "room, venue" with the venue's address, linked to
 *    the visitor's maps app (a Google search when the venue has no
 *    coordinates yet); `building` says it is inferred;
 *  - `area`: the area as stated ("exact place sent to attendees"), no maps link;
 *  - `online`: the source's words, else "Online";
 *  - `unknown`: the source's words, if any, and "Location to be confirmed".
 * `sourceText` is the source's own words for where (the event's venue text or
 * the talk's venue).
 */
export function placeLineModel(location: PlacedLocation, sourceText?: string): PlaceLineModel {
  const venue = location.venue
  const text = sourceText?.trim() || undefined
  switch (location.precision) {
    case "exact":
    case "building": {
      if (!venue) return { label: text, details: [], onMap: false }
      const label = location.room ? `${location.room}, ${venue.name}` : venue.name
      const details = [
        ...(venue.address ? [venue.address] : []),
        ...(location.precision === "building" ? ["Building inferred from the listing"] : []),
      ]
      const maps = hasCoordinates(venue)
        ? mapsLinks({
            name: venue.name,
            address: venue.address,
            lat: venue.lat,
            lng: venue.lng,
            googlePlaceId: venue.googlePlaceId,
          })
        : { google: googleSearch(label) }
      return { label, details, maps, onMap: hasCoordinates(venue) }
    }
    case "area":
      return {
        label: location.areaLabel ?? venue?.name ?? text,
        details: [],
        onMap: hasCoordinates(venue),
      }
    case "online":
      return { label: text ?? "Online", details: [], onMap: false }
    case "unknown":
      return { label: text, details: text ? ["Location to be confirmed"] : [], onMap: false }
  }
}

const noSubscribe = () => () => {}

/** The visitor's user agent after hydration; null on the server and in the
 * hydrating render, so the server HTML (the Google link) matches. */
function useUserAgent(): string | null {
  return useSyncExternalStore(
    noSubscribe,
    () => navigator.userAgent,
    () => null,
  )
}

const LINK =
  "inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8"

/**
 * The body of an event's or a talk's "Where" row from its resolved location
 * (`locations.forItem`): the place, its address, "Open in Maps" (Apple Maps
 * on Apple platforms, Google Maps elsewhere; the server renders Google and
 * the browser swaps it after hydration) and "See on the map", the item's
 * London day on /map.
 */
export function PlaceLine({
  location,
  sourceText,
  day,
}: {
  location: PlacedLocation
  sourceText?: string
  /** The item's London day, `YYYY-MM-DD`. */
  day: string
}) {
  const model = placeLineModel(location, sourceText)
  const userAgent = useUserAgent()
  const mapsHref = model.maps
    ? model.maps.apple
      ? preferredMapsHref({ apple: model.maps.apple, google: model.maps.google }, userAgent)
      : model.maps.google
    : undefined
  return (
    <>
      {model.label ? (
        <span className="font-medium">{model.label}</span>
      ) : (
        <span className="text-muted-foreground">Location to be confirmed</span>
      )}
      {model.details.map((detail) => (
        <span key={detail} className="text-sm text-muted-foreground">
          {detail}
        </span>
      ))}
      {(mapsHref || model.onMap) && (
        <span className="flex flex-wrap items-center gap-x-4">
          {mapsHref && (
            <a href={mapsHref} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>
              Open in Maps
              <ArrowUpRightIcon aria-hidden className="size-3.5" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {model.onMap && (
            <Link {...linkProps(`/map?d=${day}`)} className={LINK}>
              <MapIcon aria-hidden className="size-3.5" />
              See on the map
            </Link>
          )}
        </span>
      )}
    </>
  )
}
