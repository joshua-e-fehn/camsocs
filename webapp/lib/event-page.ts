import type { Metadata } from "next"
import { unstable_rethrow } from "next/navigation"
import { cache } from "react"
import { api } from "@/convex/_generated/api"
import {
  type EventVenue,
  eventEndedLongAgo,
  eventMetaDescription,
  eventPageTitle,
  spokenTitle,
} from "./events"
import { pageMetadata } from "./page-metadata"
import type { EventPublic } from "./public-api"
import { publicQuery } from "./public-data"
import { eventIcsPath, eventPath } from "./talks-boundary"
import { fetchTermDates } from "./term-dates"
import type { TermDatesRow } from "./term-week"
import { isEventKey } from "./url-state"

/**
 * The server side of an event's page, shared by `/events/<key>` and — for a
 * talks.cam-derived event (owner decision G1, lib/talks-boundary.ts) —
 * `/talks/events/<key>`: the reads, memoised per request so the metadata and
 * the page share them, and the metadata.
 */

/** One read per render, anonymous, so the page is the same for everyone and
 * cached (docs/webapp.md "Caching"): a Cambridge-only event is null here, and
 * a signed-in reader who may see it gets it in the browser
 * (organisms/restricted-event.tsx). Undefined for a malformed key. */
export const loadEvent = cache(async (key: string) => {
  if (!isEventKey(key)) return undefined
  return await publicQuery(api.events.get, { key })
})

/** The venue an event's key names, for its name (where the source gave only
 * the key), address and coordinates (its JSON-LD Place). Decoration: a
 * failed read leaves it out. */
export const loadVenue = cache(async (venueKey: string | undefined) => {
  if (!venueKey) return undefined
  try {
    return (await publicQuery(api.venues.get, { key: venueKey })) ?? undefined
  } catch (error) {
    unstable_rethrow(error)
    return undefined
  }
})

/** Term dates for the week tag. Decoration: without them the page renders. */
export async function loadTerms(): Promise<TermDatesRow[]> {
  try {
    return await fetchTermDates()
  } catch (error) {
    unstable_rethrow(error)
    return []
  }
}

/** The name the page shows for where it is: the source's words first (they
 * may name the room), else the venue its key names. */
export function venueNameOf(event: EventPublic, venue: EventVenue | undefined) {
  return event.venueText ? undefined : venue?.name
}

/**
 * An event's metadata: the title with its host and day (`eventPageTitle`,
 * at most 60 characters), the description with the venue and year, the
 * canonical URL on its side of the talks boundary, its `.ics` advertised as a
 * calendar alternate (public events), and robots:
 *  - a Cambridge-only event is for signed-in readers, not search;
 *  - one that ended over 30 days ago is noindex, follow (owner decision G4).
 */
export function eventMetadata(event: EventPublic, venue: EventVenue | undefined, now: number) {
  const { title, absolute } = eventPageTitle(event)
  const path = eventPath(event)
  const base = pageMetadata({
    title,
    description: eventMetaDescription(event, venueNameOf(event, venue)),
    path,
  })
  const metadata: Metadata = {
    ...base,
    ...(absolute ? { title: { absolute: title } } : {}),
    alternates: {
      ...base.alternates,
      ...(event.visibility === "public"
        ? {
            types: {
              "text/calendar": [{ url: eventIcsPath(event), title: spokenTitle(event.title) }],
            },
          }
        : {}),
    },
  }
  if (event.visibility === "cam_only")
    return { ...metadata, robots: { index: false, follow: false } }
  if (eventEndedLongAgo(event, now)) return { ...metadata, robots: { index: false, follow: true } }
  return metadata
}

/** The metadata of a page whose event this viewer may not see. */
export const UNAVAILABLE_METADATA: Metadata = {
  title: "Event not available",
  robots: { index: false, follow: false },
}
