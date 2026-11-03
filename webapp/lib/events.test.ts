import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import {
  dayCounts,
  EVENT_TYPE_TONE,
  type EventVenue,
  eventCalendarDetails,
  eventEnd,
  eventEndedLongAgo,
  eventGoogleCalendarUrl,
  eventHasEnded,
  eventHasStructuredData,
  eventJsonLd,
  eventMetaDescription,
  eventOutlookCalendarUrl,
  eventPageTitle,
  eventStructuredData,
  eventsListStructuredData,
  eventTimes,
  isEventIdentityUrl,
  matchesEventQuery,
  mergeByStart,
  nextDayWithEvents,
  orgEventsTitle,
  placeIsInCambridge,
  splitEmoji,
  spokenTitle,
  stripPages,
  stripRangeLabel,
  termWeekGutter,
  weekRowGutter,
} from "./events"
import type { TermDatesRow } from "./term-week"
import { EVENT_TYPES } from "./vocab"

/** Michaelmas 2026: Full Term Tue 6 Oct – Fri 4 Dec; Week 1 starts Thu 8 Oct. */
const TERMS: TermDatesRow[] = [
  {
    academicYear: "2026-27",
    term: "michaelmas",
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
  },
  { academicYear: "2026-27", term: "lent", fullTermStart: "2027-01-19", fullTermEnd: "2027-03-19" },
]

const at = (iso: string) => Date.parse(iso)

const EVENT = {
  key: `evt-${"a".repeat(40)}`,
  title: "Jazz at the Union",
  startsAt: at("2026-11-03T19:30:00Z"),
  endsAt: at("2026-11-03T22:00:00Z"),
  allDay: false,
  venueText: "The Union Chamber",
  cancelled: false,
  hosting: "hosts",
  eventType: "performance" as const,
  organisers: [
    { name: "Cambridge University Jazz Society", role: "organiser" },
    { name: "Some Sponsor", role: "sponsor" },
  ],
}

describe("search", () => {
  test("every word must match the title, an organiser or the venue", () => {
    expect(matchesEventQuery(EVENT, "jazz")).toBe(true)
    expect(matchesEventQuery(EVENT, "jazz society")).toBe(true)
    expect(matchesEventQuery(EVENT, "union chamber")).toBe(true)
    expect(matchesEventQuery(EVENT, "jazz punting")).toBe(false)
  })

  test("is case- and accent-blind; an empty query matches everything", () => {
    expect(matchesEventQuery({ ...EVENT, title: "Café Scientifique" }, "CAFE")).toBe(true)
    expect(matchesEventQuery(EVENT, "")).toBe(true)
    expect(matchesEventQuery(EVENT, "   ")).toBe(true)
    expect(matchesEventQuery(EVENT, undefined)).toBe(true)
  })
})

describe("emoji in titles", () => {
  test("splits pictographs (with modifiers, joins and flags) from the text", () => {
    expect(splitEmoji("🚩 HAM-DEFCON")).toEqual([
      { text: "🚩", emoji: true },
      { text: " HAM-DEFCON", emoji: false },
    ])
    expect(splitEmoji("Coders 👩🏽‍💻 night 🇬🇧").filter((part) => part.emoji)).toEqual([
      { text: "👩🏽‍💻", emoji: true },
      { text: "🇬🇧", emoji: true },
    ])
    expect(splitEmoji("Plain title")).toEqual([{ text: "Plain title", emoji: false }])
  })

  test("digits and # stay text", () => {
    expect(splitEmoji("Week #4: 10 years")).toEqual([{ text: "Week #4: 10 years", emoji: false }])
  })

  test("the spoken title drops emoji, unless there is nothing else", () => {
    expect(spokenTitle("🚩 HAM-DEFCON 🚩")).toBe("HAM-DEFCON")
    expect(spokenTitle("Bop ❤️ night")).toBe("Bop night")
    expect(spokenTitle("🎉")).toBe("🎉")
  })
})

describe("agenda rows", () => {
  test("the time column: start over end, all day, or until the last day", () => {
    expect(eventTimes(EVENT)).toEqual({ start: "19:30", end: "22:00" })
    expect(eventTimes({ ...EVENT, endsAt: undefined })).toEqual({ start: "19:30" })
    expect(eventTimes({ ...EVENT, allDay: true, endsAt: undefined })).toEqual({ start: "All day" })
    expect(
      eventTimes({
        startsAt: at("2026-11-06T18:00:00Z"),
        endsAt: at("2026-11-08T12:00:00Z"),
        allDay: false,
      }),
    ).toEqual({ start: "18:00", end: "until Sun 8 Nov" })
    expect(
      eventTimes({
        startsAt: londonMidnight("2026-11-06"),
        endsAt: londonMidnight("2026-11-09"),
        allDay: true,
      }),
    ).toEqual({ start: "All day", end: "until Sun 8 Nov" })
  })

  test("day counts for the strip, 0 for a quiet day", () => {
    const byDay = new Map([
      ["2026-11-01", [1, 2]],
      ["2026-11-03", [3]],
    ])
    expect(dayCounts(["2026-11-01", "2026-11-02", "2026-11-03"], byDay)).toEqual([
      { date: "2026-11-01", count: 2 },
      { date: "2026-11-02", count: 0 },
      { date: "2026-11-03", count: 1 },
    ])
  })

  test("strip pages of seven days; the next busy day", () => {
    const days = Array.from({ length: 15 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`)
    const pages = stripPages(days)
    expect(pages.map((page) => page.length)).toEqual([7, 7, 1])
    expect(pages[1][0]).toBe("2026-11-08")
    expect(nextDayWithEvents("2026-11-02", ["2026-11-05", "2026-11-01", "2026-11-03"])).toBe(
      "2026-11-03",
    )
    expect(nextDayWithEvents("2026-11-06", ["2026-11-05"])).toBeUndefined()
  })

  test("month gutter: the term week of the row's Thursday", () => {
    expect(termWeekGutter("2026-11-05", TERMS)).toBe("M5")
    expect(termWeekGutter("2026-12-20", TERMS)).toBeUndefined()
    expect(termWeekGutter("2027-01-21", TERMS)).toBe("L1")
    // Mon 2 – Sun 8 Nov: Thursday 5 Nov is Week 5.
    const week = ["02", "03", "04", "05", "06", "07", "08"].map((d) => `2026-11-${d}`)
    expect(weekRowGutter(week, TERMS)).toBe("M5")
  })

  test("the strip's label spans the term weeks of its days", () => {
    const days = ["01", "02", "03", "04", "05", "06", "07"].map((d) => `2026-11-${d}`)
    expect(stripRangeLabel(days, TERMS)).toBe("Mich · Wk 4–5")
    expect(stripRangeLabel(days.slice(4), TERMS)).toBe("Mich · Wk 5")
    expect(stripRangeLabel(["2026-12-24", "2026-12-25"], TERMS)).toBe("Vacation")
  })

  test("every event type has a colour family", () => {
    for (const type of EVENT_TYPES) expect(EVENT_TYPE_TONE[type]).toBeDefined()
    expect(EVENT_TYPE_TONE.talk).toBe("indigo")
  })
})

describe("calendar links", () => {
  const page = "https://camsocs.uk/events/evt-a"

  test("details name who runs it, or who takes part (D6); never a sponsor", () => {
    expect(eventCalendarDetails(EVENT, page)).toBe(
      `Organised by Cambridge University Jazz Society\nDetails: ${page}`,
    )
    expect(eventCalendarDetails({ ...EVENT, hosting: "takes_part", cancelled: true }, page)).toBe(
      `This event is cancelled.\nTaking part: Cambridge University Jazz Society\nDetails: ${page}`,
    )
  })

  test("Google: UTC times, the venue, London time zone", () => {
    const url = new URL(eventGoogleCalendarUrl(EVENT, page))
    expect(url.hostname).toBe("calendar.google.com")
    expect(url.searchParams.get("dates")).toBe("20261103T193000Z/20261103T220000Z")
    expect(url.searchParams.get("location")).toBe("The Union Chamber")
    expect(url.searchParams.get("ctz")).toBe("Europe/London")
    expect(url.searchParams.get("text")).toBe("Jazz at the Union")
  })

  test("Google: an all-day event over days has an exclusive end date", () => {
    const url = new URL(
      eventGoogleCalendarUrl(
        {
          ...EVENT,
          allDay: true,
          startsAt: londonMidnight("2026-11-06"),
          endsAt: londonMidnight("2026-11-09"),
        },
        page,
      ),
    )
    expect(url.searchParams.get("dates")).toBe("20261106/20261109")
  })

  test("Outlook: an hour when there is no end; the host can be Microsoft 365", () => {
    const url = new URL(
      eventOutlookCalendarUrl({ ...EVENT, endsAt: undefined }, page, "outlook.office.com"),
    )
    expect(url.hostname).toBe("outlook.office.com")
    expect(url.searchParams.get("startdt")).toBe("2026-11-03T19:30:00.000Z")
    expect(url.searchParams.get("enddt")).toBe("2026-11-03T20:30:00.000Z")
  })
})

describe("the event's page", () => {
  const PAGE = {
    ...EVENT,
    talksDerived: false,
    source: "ics",
    status: "confirmed",
    visibility: "public",
    organisers: [
      {
        key: "org-jazz",
        slug: "jazz",
        name: "Cambridge University Jazz Society",
        role: "organiser",
      },
      { key: "org-sponsor", slug: "sponsor", name: "Some Sponsor", role: "sponsor" },
    ],
  }

  test("meta description: type, who, when with the year, where, then the description", () => {
    expect(eventMetaDescription(PAGE)).toBe(
      "Performance by Cambridge University Jazz Society · Tue 3 Nov 2026, 19:30–22:00 · The Union Chamber",
    )
    expect(
      eventMetaDescription({ ...PAGE, hosting: "takes_part", venueText: undefined }, "Hall"),
    ).toBe(
      "Performance with Cambridge University Jazz Society taking part · Tue 3 Nov 2026, 19:30–22:00 · Hall",
    )
    const described = eventMetaDescription({
      ...PAGE,
      organisers: [{ name: "Jazz Society", role: "organiser" }],
      description: "An evening of **standards** with the big band. ".repeat(6),
    })
    expect(
      described.startsWith(
        "Performance by Jazz Society · Tue 3 Nov 2026, 19:30–22:00 · The Union Chamber. An evening of standards",
      ),
    ).toBe(true)
    expect(described.length).toBeLessThanOrEqual(160)
    expect(described.endsWith("…")).toBe(true)
    // A venue text that names no place gives way to the venue's name.
    expect(eventMetaDescription({ ...PAGE, venueText: "Home Game" }, "Fenner's")).toContain(
      "· Fenner's",
    )
  })

  test("title: the event, who runs it and the day, within 60 characters", () => {
    // The brand suffix goes first, then the host.
    expect(eventPageTitle({ ...PAGE, title: "Big band" })).toEqual({
      title: "Big band – Cambridge University Jazz Society, Tue 3 Nov",
      absolute: true,
    })
    expect(eventPageTitle({ ...PAGE, title: "Big band night" })).toEqual({
      title: "Big band night, Tue 3 Nov",
      absolute: false,
    })
    expect(
      eventPageTitle({
        ...PAGE,
        title: "Open mic",
        organisers: [{ name: "Jazz Soc", role: "organiser" }],
      }),
    ).toEqual({ title: "Open mic – Jazz Soc, Tue 3 Nov", absolute: false })
    // The host is not repeated when the title names it; emoji are dropped.
    expect(
      eventPageTitle({
        ...PAGE,
        title: "🎷 Jazz Soc social",
        organisers: [{ name: "Jazz Soc", role: "organiser" }],
      }),
    ).toEqual({ title: "Jazz Soc social, Tue 3 Nov", absolute: false })
    // Someone else's event: no host in the title (D6).
    expect(eventPageTitle({ ...PAGE, title: "HackCam", hosting: "takes_part" }).title).toBe(
      "HackCam, Tue 3 Nov",
    )
    expect(
      eventPageTitle({
        ...PAGE,
        title: "Open mic",
        cancelled: true,
        organisers: [{ name: "Jazz Soc", role: "organiser" }],
      }).title,
    ).toBe("Cancelled: Open mic – Jazz Soc, Tue 3 Nov")
    const long = eventPageTitle({ ...PAGE, title: "A very long title ".repeat(6).trim() })
    expect(long.absolute).toBe(true)
    expect(long.title.length).toBeLessThanOrEqual(60)
    expect(long.title.endsWith("…, Tue 3 Nov")).toBe(true)
  })

  test("structured data only for a public, confirmed event with a read start time", () => {
    expect(eventHasStructuredData(PAGE)).toBe(true)
    expect(eventHasStructuredData({ ...PAGE, visibility: "cam_only" })).toBe(false)
    expect(eventHasStructuredData({ ...PAGE, status: "tbc" })).toBe(false)
    expect(eventHasStructuredData({ ...PAGE, title: "Bandi Chhor Formal ( DATE TBC)" })).toBe(false)
    expect(eventHasStructuredData({ ...PAGE, title: "Garden party (date TBA)" })).toBe(false)
    expect(eventHasStructuredData({ ...PAGE, meta: { startsAt: { status: "inferred" } } })).toBe(
      false,
    )
    expect(eventHasStructuredData({ ...PAGE, meta: { startsAt: { status: "found" } } })).toBe(true)
    // Convex's verdict decides (lib/talks-boundary.ts), never a re-run here.
    expect(eventHasStructuredData({ ...PAGE, talksDerived: true })).toBe(false)
  })

  test("JSON-LD: one graph of WebPage, Event and BreadcrumbList", () => {
    const graph = eventStructuredData(PAGE)
    const nodes = graph?.["@graph"] as Record<string, unknown>[]
    expect(graph?.["@context"]).toBe("https://schema.org")
    expect(nodes.map((node) => node["@type"])).toEqual(["WebPage", "Event", "BreadcrumbList"])
    expect(nodes[0]).toMatchObject({
      "@id": `https://camsocs.uk/events/${EVENT.key}`,
      isPartOf: { "@id": "https://camsocs.uk/#website" },
      mainEntity: { "@id": `https://camsocs.uk/events/${EVENT.key}#event` },
    })
    expect(nodes[1]).not.toHaveProperty("isPartOf")
    expect(nodes[2]).toMatchObject({
      itemListElement: [
        // The visible trail (eventTrail; no day crumb, a robots.txt trap),
        // then the event itself.
        { position: 1, name: "Events", item: "https://camsocs.uk/events" },
        { position: 2, name: "Jazz at the Union", item: `https://camsocs.uk/events/${EVENT.key}` },
      ],
    })
    expect(eventStructuredData({ ...PAGE, status: "tbc" })).toBeNull()
  })

  test("JSON-LD names organisers only when they run them, linked to their profile", () => {
    const hosted = eventJsonLd(PAGE, "https://camsocs.uk/events/x")
    expect(hosted).toMatchObject({
      "@type": "Event",
      "@id": `https://camsocs.uk/events/${EVENT.key}#event`,
      name: "Jazz at the Union",
      startDate: "2026-11-03T19:30:00.000Z",
      endDate: "2026-11-03T22:00:00.000Z",
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      organizer: [
        {
          "@type": "Organization",
          "@id": "https://camsocs.uk/societies/jazz#organization",
          name: "Cambridge University Jazz Society",
        },
      ],
      location: { "@type": "Place", name: "The Union Chamber" },
    })
    // The society's node (its profile) holds the url, its own website.
    expect((hosted.organizer as Record<string, unknown>[])[0]).not.toHaveProperty("url")
    const external = eventJsonLd({ ...PAGE, hosting: "takes_part", cancelled: true }, "x")
    expect(external.organizer).toBeUndefined()
    expect(external.eventStatus).toBe("https://schema.org/EventCancelled")
  })

  describe("the University's own listing (ENG-24)", () => {
    const listing = "https://events.example.ac.uk/whats-on/lantern-lecture"
    const UNIVERSITY = {
      ...PAGE,
      title: "Lantern lecture",
      eventType: "talk" as const,
      organisers: [],
      fromUniversity: true,
      source: "uni_events_api",
      sourceUrl: listing,
    }

    test("JSON-LD names the University as organiser and its page as sameAs", () => {
      const ld = eventJsonLd(UNIVERSITY, "https://camsocs.uk/events/x")
      expect(ld.organizer).toEqual([
        { "@type": "Organization", name: "University of Cambridge", url: "https://www.cam.ac.uk" },
      ])
      expect(ld.sameAs).toBe(listing)
    })

    test("the search box finds it by the University's name", () => {
      expect(matchesEventQuery(UNIVERSITY, "university lantern")).toBe(true)
      expect(matchesEventQuery({ ...UNIVERSITY, fromUniversity: false }, "university")).toBe(false)
    })

    test("the title names the University as host, dropped first when too long", () => {
      expect(eventPageTitle(UNIVERSITY)).toEqual({
        title: "Lantern lecture – University of Cambridge, Tue 3 Nov",
        absolute: true,
      })
      expect(eventPageTitle({ ...UNIVERSITY, title: "Lanterns, ink and the long winter" })).toEqual(
        {
          title: "Lanterns, ink and the long winter, Tue 3 Nov",
          absolute: false,
        },
      )
    })

    test("meta description and calendar entries say where it is listed", () => {
      expect(eventMetaDescription(UNIVERSITY)).toBe(
        "Talk listed by the University of Cambridge · Tue 3 Nov 2026, 19:30–22:00 · The Union Chamber",
      )
      expect(eventCalendarDetails(UNIVERSITY, "https://camsocs.uk/events/x")).toBe(
        `Listed in the University of Cambridge’s public events programme: ${listing}\nDetails: https://camsocs.uk/events/x`,
      )
    })
  })

  test("JSON-LD carries the description, image, offers and speakers the page shows", () => {
    const page = "https://camsocs.uk/events/x"
    const full = eventJsonLd(
      {
        ...PAGE,
        eventType: "talk",
        description: "A *talk* on [jazz](https://example.org).",
        imageUrl: "https://files.example.org/poster.png",
        price: { free: true, text: "members" },
        speakers: [{ name: "Dr Ada Byron", affiliation: "Analytical Engines" }],
        bookingUrl: "https://example.org/book",
      },
      page,
    )
    expect(full).toMatchObject({
      description: "A talk on jazz.",
      image: ["https://files.example.org/poster.png"],
      offers: { "@type": "Offer", price: 0, priceCurrency: "GBP", url: "https://example.org/book" },
      performer: [
        {
          "@type": "Person",
          name: "Dr Ada Byron",
          affiliation: { "@type": "Organization", name: "Analytical Engines" },
        },
      ],
    })
    expect(
      eventJsonLd({ ...PAGE, price: { free: false, minPence: 500, maxPence: 1200 } }, page).offers,
    ).toEqual({
      "@type": "AggregateOffer",
      url: page,
      priceCurrency: "GBP",
      lowPrice: 5,
      highPrice: 12,
    })
    expect(eventJsonLd({ ...PAGE, price: { free: false, text: "a fiver" } }, page).offers).toBe(
      undefined,
    )
    // Speakers are performers only for a talk or a workshop (D1).
    expect(eventJsonLd({ ...PAGE, speakers: [{ name: "X" }] }, page).performer).toBeUndefined()
  })

  test("JSON-LD location: the keyed venue with its address and coordinates; no junk", () => {
    const page = "https://camsocs.uk/events/x"
    expect(
      eventJsonLd({ ...PAGE, venueText: undefined }, page, {
        name: "ADC Theatre",
        address: "Park Street",
        lat: 52.2091,
        lng: 0.1206,
      }).location,
    ).toEqual({
      "@type": "Place",
      name: "ADC Theatre",
      address: {
        "@type": "PostalAddress",
        streetAddress: "Park Street",
        addressLocality: "Cambridge",
        addressRegion: "Cambridgeshire",
        addressCountry: "GB",
      },
      geo: { "@type": "GeoCoordinates", latitude: 52.2091, longitude: 0.1206 },
    })
    for (const venueText of ["Home Game", "away", "TBC", "To be announced"]) {
      expect(eventJsonLd({ ...PAGE, venueText }, page).location).toBeUndefined()
    }
    const online = eventJsonLd({ ...PAGE, venueText: "Online (Zoom)" }, page)
    expect(online.eventAttendanceMode).toBe("https://schema.org/OnlineEventAttendanceMode")
    // Our page is not where anyone attends: a VirtualLocation only where one joins.
    expect(online.location).toBeUndefined()
    expect(
      eventJsonLd({ ...PAGE, venueText: "Zoom", bookingUrl: "https://example.org/join" }, page)
        .location,
    ).toEqual({ "@type": "VirtualLocation", url: "https://example.org/join" })
  })

  test("JSON-LD location: the town only when it is known to be Cambridge", () => {
    const page = "https://camsocs.uk/events/x"
    const address = (venueText: string | undefined, venue?: EventVenue) =>
      (eventJsonLd({ ...PAGE, venueText }, page, venue).location as Record<string, unknown>)
        ?.address
    const cambridge = {
      "@type": "PostalAddress",
      addressLocality: "Cambridge",
      addressRegion: "Cambridgeshire",
      addressCountry: "GB",
    }
    // Free text: only when it names Cambridge; an away fixture is not asserted.
    expect(address("Fenner's, Cambridge")).toEqual(cambridge)
    expect(address("Iffley Road, Oxford")).toBeUndefined()
    expect(address("The Union Chamber")).toBeUndefined()
    // A keyed venue: a college's, inside the city, or an address naming it.
    expect(address(undefined, { name: "Invented Hall", collegeKey: "col-x" })).toEqual(cambridge)
    expect(address(undefined, { name: "Invented Hall", lat: 52.2, lng: 0.12 })).toMatchObject(
      cambridge,
    )
    expect(address(undefined, { name: "Invented Hall", address: "1 Road, Cambridge" })).toEqual({
      ...cambridge,
      streetAddress: "1 Road, Cambridge",
    })
    expect(
      address(undefined, { name: "Iffley Road", address: "Iffley Road", lat: 51.74, lng: -1.24 }),
    ).toEqual({ "@type": "PostalAddress", streetAddress: "Iffley Road" })
    expect(placeIsInCambridge({ name: "Lord's", lat: 51.53, lng: -0.17 })).toBe(false)
  })

  test("sameAs: only a page about this one event", () => {
    const page = "x"
    const sameAs = (overrides: Partial<typeof PAGE> & Record<string, unknown>) =>
      eventJsonLd({ ...PAGE, ...overrides }, page).sameAs
    expect(sameAs({ source: "camdram", sourceUrl: "https://www.camdram.net/shows/lola" })).toBe(
      "https://www.camdram.net/shows/lola",
    )
    expect(sameAs({ externalUrl: "https://ctf.example.org/2026" })).toBe(
      "https://ctf.example.org/2026",
    )
    // A society's feed, website or term card lists many events.
    expect(sameAs({ source: "ics", sourceUrl: "https://example.org/events" })).toBeUndefined()
    for (const url of [
      "https://calendar.google.com/calendar/ical/x/public/basic.ics",
      "https://example.org/termcard.png",
      "https://example.org/card.pdf",
      "https://talks.cam.ac.uk/talk/index/1",
      "https://example.org/",
      "mailto:x@example.org",
    ]) {
      expect(isEventIdentityUrl(url)).toBe(false)
      expect(sameAs({ externalUrl: url })).toBeUndefined()
    }
  })

  test("an event ends at its end, else with its day; noindex 30 days on", () => {
    const end = EVENT.endsAt
    expect(eventEnd(EVENT)).toBe(end)
    expect(eventEnd({ ...EVENT, endsAt: undefined })).toBe(londonMidnight("2026-11-04"))
    expect(eventHasEnded(EVENT, end - 1)).toBe(false)
    expect(eventHasEnded(EVENT, end)).toBe(true)
    expect(eventEndedLongAgo(EVENT, end + 30 * 86_400_000)).toBe(false)
    expect(eventEndedLongAgo(EVENT, end + 30 * 86_400_000 + 1)).toBe(true)
  })
})

describe("mergeByStart", () => {
  test("one list by start time, each key once", () => {
    const a = [
      { key: "a", startsAt: 1 },
      { key: "c", startsAt: 3 },
    ]
    const b = [
      { key: "b", startsAt: 2 },
      { key: "c", startsAt: 3 },
    ]
    expect(mergeByStart(a, b).map((event) => event.key)).toEqual(["a", "b", "c"])
    expect(mergeByStart(a, [])).toEqual(a)
  })
})

describe("the calendar page", () => {
  test("one society's calendar title fits in 60 characters with Cambridge in it", () => {
    expect(orgEventsTitle("Chess Club")).toEqual({
      title: "Chess Club events in Cambridge",
      absolute: false,
    })
    expect(orgEventsTitle("Cambridge Union")).toEqual({
      title: "Cambridge Union events",
      absolute: false,
    })
    expect(
      orgEventsTitle("Society for Very Long Society Names Indeed").title.length,
    ).toBeLessThanOrEqual(60)
    const long = orgEventsTitle("The Extremely Long and Detailed Name of an Invented Society Here")
    expect(long.absolute).toBe(true)
    expect(long.title.length).toBeLessThanOrEqual(60)
    expect(long.title.endsWith("… events")).toBe(true)
  })

  test("a CollectionPage of URL-only items: public, not cancelled, not talks.cam-derived", () => {
    const item = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      talksDerived: false,
      visibility: "public",
      cancelled: false,
      ...extra,
    })
    const data = eventsListStructuredData({
      path: "/events?org=jazz",
      name: "Jazz events",
      events: [
        item("evt-a"),
        item("evt-b", { visibility: "cam_only" }),
        item("evt-c", { cancelled: true }),
        item("evt-d", { talksDerived: true }),
        item("evt-e"),
      ],
    })
    expect(data).toMatchObject({
      "@type": "CollectionPage",
      "@id": "https://camsocs.uk/events?org=jazz",
      isPartOf: { "@id": "https://camsocs.uk/#website" },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 2,
        itemListElement: [
          { "@type": "ListItem", position: 1, url: "https://camsocs.uk/events/evt-a" },
          { "@type": "ListItem", position: 2, url: "https://camsocs.uk/events/evt-e" },
        ],
      },
    })
  })
})
