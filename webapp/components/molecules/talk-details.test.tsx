import { describe, expect, test } from "bun:test"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { TalkDetails } from "@/components/molecules/talk-details"
import type { ItemLocation } from "@/lib/public-api"
import type { TalkPublic } from "@/lib/talks"

// An invented talk and invented places only.

const STARTS = Date.UTC(2026, 10, 3, 13, 0)

const TALK: TalkPublic = {
  key: "talk-05f9cb992668bbf0c8dc",
  title: "Invented rivers",
  speakers: [],
  series: "Invented Seminar",
  departments: [],
  startsAt: STARTS,
  endsAt: STARTS + 3_600_000,
  allDay: false,
  venue: "Invented Lecture Theatre",
  online: false,
  kind: "seminar",
  cancelled: false,
  url: "https://example.org/talks/1",
  abstract: null,
  specialMessage: null,
  sourceUrl: "https://example.org/feed.ics",
  retrievedAt: STARTS,
  firstSeenAt: STARTS,
  lastSeenAt: STARTS,
} as unknown as TalkPublic

function render(talk: TalkPublic, location?: ItemLocation): string {
  const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
  const html = renderToString(
    <ConvexProvider client={client}>
      <TalkDetails
        talk={talk}
        location={location}
        pageUrl={`https://camsocs.uk/talks/${talk.key}`}
      />
    </ConvexProvider>,
  )
  void client.close()
  return html.replaceAll("<!-- -->", "").replaceAll("&amp;", "&")
}

describe("the talk's Where row (docs/locations-and-map.md §3)", () => {
  test("no resolved place: the venue as listed with a Google search", () => {
    const html = render(TALK)
    expect(html).toContain("Invented Lecture Theatre")
    expect(html).toContain("query=Invented%20Lecture%20Theatre%2C%20Cambridge")
    expect(html).not.toContain("/map?d=")
  })

  test("resolved: the building with its address and the day on /map", () => {
    const html = render(TALK, {
      precision: "exact",
      room: "Lecture Theatre 1",
      venue: {
        key: "ven-invented-building",
        name: "Invented Building",
        aliases: [],
        address: "2 Invented Road, Cambridge CB3 0AA",
        lat: 52.21,
        lng: 0.1,
      },
    })
    expect(html).toContain("Lecture Theatre 1, Invented Building")
    expect(html).toContain("2 Invented Road")
    expect(html).toContain('href="/map?d=2026-11-03"')
  })

  test("online only: the Online row, no Where row", () => {
    const html = render(
      { ...TALK, venue: "Zoom", online: true },
      { precision: "online", venue: null },
    )
    expect(html).toContain("Online")
    expect(html).not.toContain("See on the map")
  })
})
