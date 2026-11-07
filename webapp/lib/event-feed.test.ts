import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import { eventFeedXml, type FeedEvent, feedSummary } from "./event-feed"
import { SITE_URL } from "./site"

/** The newly-listed Atom feed (lib/event-feed.ts). Invented data only. */

const LISTED = Date.parse("2026-11-07T04:51:00Z")
const EVENT: FeedEvent = {
  key: "evt-0123456789abcdef0123456789abcdef01234567",
  title: "Invented <Jazz> & Swing night",
  startsAt: Date.parse("2026-11-14T20:00:00Z"),
  allDay: false,
  listedAt: LISTED,
  host: "Invented Jazz Society",
  fromUniversity: false,
}

describe("feedSummary", () => {
  test("when (London time, with the year), then who", () => {
    expect(feedSummary(EVENT)).toBe("Sat 14 Nov 2026, 20:00 · Invented Jazz Society")
    // British Summer Time: 18:00 UTC is 19:00 in London.
    expect(feedSummary({ ...EVENT, startsAt: Date.parse("2026-06-01T18:00:00Z") })).toBe(
      "Mon 1 Jun 2026, 19:00 · Invented Jazz Society",
    )
  })

  test("an all-day event has no time; no host leaves the who out", () => {
    const allDay = {
      ...EVENT,
      allDay: true,
      startsAt: londonMidnight("2026-11-20"),
      host: undefined,
    }
    expect(feedSummary(allDay)).toBe("Fri 20 Nov 2026")
  })

  test("the University's own listings name the University", () => {
    expect(feedSummary({ ...EVENT, host: undefined, fromUniversity: true })).toMatch(
      /^Sat 14 Nov 2026, 20:00 · .*Cambridge/,
    )
  })
})

describe("eventFeedXml", () => {
  test("an Atom feed: self link, one entry per event, canonical URLs, honest dates", () => {
    const older = {
      ...EVENT,
      key: "evt-1123456789abcdef0123456789abcdef01234567",
      listedAt: LISTED - 86_400_000,
    }
    const xml = eventFeedXml([EVENT, older], LISTED + 999_999)
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">',
      ),
    ).toBe(true)
    expect(xml).toContain(
      `<link rel="self" type="application/atom+xml" href="${SITE_URL}/events.atom"/>`,
    )
    expect(xml.match(/<entry>/g)).toHaveLength(2)
    expect(xml).toContain(`<id>${SITE_URL}/events/${EVENT.key}</id>`)
    expect(xml).toContain(
      `<link rel="alternate" type="text/html" href="${SITE_URL}/events/${EVENT.key}"/>`,
    )
    // Dated by the newest entry, never by the request.
    expect(xml).toContain("<updated>2026-11-07T04:51:00.000Z</updated>\n<author>")
    expect(xml).toContain("<published>2026-11-06T04:51:00.000Z</published>")
    expect(xml).not.toContain(new Date(LISTED + 999_999).toISOString())
    expect(xml).toContain("<author><name>")
  })

  test("escapes markup and drops characters XML cannot carry", () => {
    const xml = eventFeedXml([{ ...EVENT, title: 'Invented \u0007<b>bold</b> & "quoted"' }], LISTED)
    expect(xml).toContain(
      "<title>Invented &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;</title>",
    )
    expect(xml).not.toContain("\u0007")
  })

  test("an empty feed is valid and dated by now", () => {
    const xml = eventFeedXml([], LISTED)
    expect(xml).not.toContain("<entry>")
    expect(xml).toContain(`<updated>${new Date(LISTED).toISOString()}</updated>`)
    expect(xml.trimEnd().endsWith("</feed>")).toBe(true)
  })
})
