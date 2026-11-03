import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { EventRow } from "@/components/molecules/event-item"
import type { EventListItem } from "@/lib/public-api"

/** An agenda row links its societies' profiles (SEO audit
 * "events-hub-hosts-unlinked"), above the row's own stretched link. */

const STARTS = Date.UTC(2026, 10, 3, 19, 30)

const event: EventListItem = {
  key: `evt-${"a".repeat(40)}`,
  title: "Invented open mic",
  startsAt: STARTS,
  allDay: false,
  venueText: "The Invented Hall",
  organisers: [
    { key: "org-jazz", slug: "jazz", name: "Jazz Soc", role: "organiser" },
    { key: "org-folk", slug: "folk", name: "Folk Soc", role: "co_host" },
    { key: "org-bank", slug: "bank", name: "A Bank", role: "sponsor" },
  ],
  visibility: "public",
  eventType: "performance",
  cancelled: false,
  status: "confirmed",
  source: "ics",
  hosting: "hosts",
  talksDerived: false,
  fromUniversity: false,
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "")

describe("EventRow", () => {
  test("links each society that runs it, never a sponsor", () => {
    const html = renderToString(<EventRow event={event} href={`/events/${event.key}`} />)
    expect(html).toContain('href="/societies/jazz"')
    expect(html).toContain('href="/societies/folk"')
    expect(html).not.toContain('href="/societies/bank"')
    expect(html).toMatch(/class="relative z-10[^"]*"[^>]*>Jazz Soc/)
    expect(text(html)).toContain("Jazz Soc, Folk Soc")
  })

  test("someone else's event: who takes part, linked (D6)", () => {
    const html = renderToString(
      <EventRow event={{ ...event, hosting: "takes_part" }} href={`/events/${event.key}`} />,
    )
    expect(text(html)).toContain("Jazz Soc and Folk Soc take part")
    expect(html).toContain('href="/societies/folk"')
  })
})
