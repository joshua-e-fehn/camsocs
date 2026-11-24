import { describe, expect, test } from "bun:test"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { EventDetails } from "@/components/molecules/event-details"
import type { EventPublic, ItemLocation } from "@/lib/public-api"

// An invented event and invented places only.

const NOW = Date.UTC(2026, 10, 1, 12)

const EVENT = {
  key: `evt-${"e".repeat(40)}`,
  title: "Invented quiz night",
  startsAt: Date.UTC(2026, 10, 2, 19, 30),
  endsAt: Date.UTC(2026, 10, 2, 21),
  allDay: false,
  venueText: "The Invented Hall",
  organisers: [],
  speakers: [],
  visibility: "public",
  eventType: "social",
  cancelled: false,
  status: "confirmed",
  source: "ics",
  sourceUrl: "https://example.org/calendar",
  hosting: "hosts",
  talksDerived: false,
  lastSeenAt: NOW,
  confidence: 0.9,
  meta: {},
} as unknown as EventPublic

const VENUE = {
  key: "ven-invented-hall",
  name: "Invented Hall",
  aliases: [],
  address: "1 Invented Street, Cambridge CB2 3EQ",
  lat: 52.2041,
  lng: 0.1218,
}

function render(event: EventPublic, location?: ItemLocation): string {
  const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
  const html = renderToString(
    <ConvexProvider client={client}>
      <EventDetails
        event={event}
        location={location}
        pageUrl={`https://camsocs.uk/events/${event.key}`}
      />
    </ConvexProvider>,
  )
  void client.close()
  return html.replaceAll("<!-- -->", "").replaceAll("&amp;", "&")
}

describe("the event's Where row (docs/locations-and-map.md §3)", () => {
  test("no resolved place: the source's words and a Google search, no map link", () => {
    const html = render(EVENT)
    expect(html).toContain("The Invented Hall")
    expect(html).toContain("query=The%20Invented%20Hall%2C%20Cambridge")
    expect(html).not.toContain("/map?d=")
    expect(render(EVENT, null)).toContain("query=The%20Invented%20Hall%2C%20Cambridge")
  })

  test("resolved: room and building, the address, maps and the London day on /map", () => {
    const html = render(EVENT, { precision: "exact", room: "Upper Room", venue: VENUE })
    expect(html).toContain("Upper Room, Invented Hall")
    expect(html).toContain("1 Invented Street, Cambridge CB2 3EQ")
    expect(html).toContain("https://www.google.com/maps/search/?api=1&query=Invented%20Hall")
    expect(html).toContain('href="/map?d=2026-11-02"')
  })

  test("an area, and an unknown place", () => {
    const area = render(EVENT, {
      precision: "area",
      areaLabel: "Central Cambridge (exact place sent to attendees)",
      venue: VENUE,
    })
    expect(area).toContain("Central Cambridge (exact place sent to attendees)")
    expect(area).not.toContain("Open in Maps")
    const unknown = render(
      { ...EVENT, venueText: undefined },
      { precision: "unknown", venue: null },
    )
    expect(unknown).toContain("Location to be confirmed")
  })
})
