import { describe, expect, test } from "bun:test"
import { londonMidnight } from "./calendar"
import {
  dayCounts,
  EVENT_TYPE_TONE,
  eventCalendarDetails,
  eventGoogleCalendarUrl,
  eventJsonLd,
  eventMetaDescription,
  eventOutlookCalendarUrl,
  eventTimes,
  matchesEventQuery,
  nextDayWithEvents,
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
  test("meta description: type, who, when, where", () => {
    expect(eventMetaDescription(EVENT)).toBe(
      "Performance by Cambridge University Jazz Society · Tue 3 Nov, 19:30–22:00 · The Union Chamber",
    )
    expect(
      eventMetaDescription({ ...EVENT, hosting: "takes_part", venueText: undefined }, "Hall"),
    ).toBe(
      "Performance with Cambridge University Jazz Society taking part · Tue 3 Nov, 19:30–22:00 · Hall",
    )
  })

  test("JSON-LD names organisers only when they run it", () => {
    const hosted = eventJsonLd(EVENT, "https://camsocs.uk/events/x")
    expect(hosted).toMatchObject({
      "@type": "Event",
      name: "Jazz at the Union",
      startDate: "2026-11-03T19:30:00.000Z",
      endDate: "2026-11-03T22:00:00.000Z",
      eventStatus: "https://schema.org/EventScheduled",
      organizer: [{ "@type": "Organization", name: "Cambridge University Jazz Society" }],
      location: { "@type": "Place", name: "The Union Chamber" },
    })
    const external = eventJsonLd({ ...EVENT, hosting: "takes_part", cancelled: true }, "x")
    expect(external.organizer).toBeUndefined()
    expect(external.eventStatus).toBe("https://schema.org/EventCancelled")
  })

  describe("the University's own listing (ENG-24)", () => {
    const listing = "https://events.example.ac.uk/whats-on/lantern-lecture"
    const UNIVERSITY = {
      ...EVENT,
      title: "Lantern lecture",
      eventType: "talk" as const,
      organisers: [],
      fromUniversity: true,
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

    test("meta description and calendar entries say where it is listed", () => {
      expect(eventMetaDescription(UNIVERSITY)).toBe(
        "Talk listed by the University of Cambridge · Tue 3 Nov, 19:30–22:00 · The Union Chamber",
      )
      expect(eventCalendarDetails(UNIVERSITY, "https://camsocs.uk/events/x")).toBe(
        `Listed in the University of Cambridge’s public events programme: ${listing}\nDetails: https://camsocs.uk/events/x`,
      )
    })
  })
})
