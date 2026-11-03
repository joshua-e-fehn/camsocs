import { describe, expect, test } from "bun:test"
import {
  dayHeading,
  documentTitle,
  feedSentence,
  googleCalendarUrl,
  groupTalksByDay,
  jsonLdScript,
  outlookCalendarUrl,
  physicalVenue,
  speakerLine,
  TALKS_TITLE,
  type TalkPublic,
  talkJsonLd,
  talkStructuredData,
  talksPageTitle,
  talkTimes,
  talkTiming,
  talkWhen,
} from "./talks"

const STARTS = Date.UTC(2026, 10, 3, 13, 0) // Tue 3 Nov, 13:00 GMT
const PAGE = "https://camsocs.uk/talks/talk-05f9cb992668bbf0c8dc"

const talk: TalkPublic = {
  key: "talk-05f9cb992668bbf0c8dc",
  title: "Rivers, <ice> & time",
  speakers: [{ name: "Ada Example", affiliation: "Analytical Engines Ltd" }],
  series: "Earth Sciences Seminar",
  departments: [
    {
      key: "dept-earth-sciences",
      slug: "earth-sciences",
      shortName: "Earth Sciences",
      school: "physical_sciences",
    },
  ],
  startsAt: STARTS,
  endsAt: STARTS + 3_600_000,
  allDay: false,
  venue: "Tilley Lecture Theatre",
  online: true,
  kind: "seminar",
  cancelled: false,
  url: "https://example.org/talks/1",
  abstract: "A long abstract.",
  specialMessage: null,
  sourceUrl: "https://example.org/feed.ics",
  retrievedAt: STARTS - 86_400_000,
  firstSeenAt: STARTS - 86_400_000,
  lastSeenAt: STARTS - 86_400_000,
}

describe("rows", () => {
  test("times in London, with the end on the same day", () => {
    expect(talkTimes(talk)).toEqual({ start: "13:00", end: "14:00" })
    expect(talkTimes({ ...talk, endsAt: null })).toEqual({ start: "13:00" })
    expect(talkTimes({ ...talk, allDay: true })).toEqual({ start: "All day" })
    // BST: 12:00 UTC on 20 Oct is 13:00 in London.
    expect(talkTimes({ ...talk, startsAt: Date.UTC(2026, 9, 20, 12), endsAt: null }).start).toBe(
      "13:00",
    )
    expect(talkWhen(talk)).toBe("Tue 3 Nov, 13:00–14:00")
  })

  test("speaker lines", () => {
    expect(speakerLine([])).toBe("")
    expect(speakerLine(talk.speakers)).toBe("Ada Example · Analytical Engines Ltd")
    expect(speakerLine([{ name: "A" }, { name: "B" }])).toBe("A and B")
    expect(speakerLine([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }])).toBe(
      "A, B and 2 others",
    )
  })

  test("groups by London day in start order", () => {
    const late = { startsAt: Date.UTC(2026, 10, 3, 23, 30) }
    const early = { startsAt: Date.UTC(2026, 10, 3, 9, 0) }
    const next = { startsAt: Date.UTC(2026, 10, 4, 0, 30) }
    expect(groupTalksByDay([next, late, early])).toEqual([
      { day: "2026-11-03", talks: [early, late] },
      { day: "2026-11-04", talks: [next] },
    ])
    expect(dayHeading("2026-11-03", "2026-11-03")).toEqual({ relative: "Today", date: "Tue 3 Nov" })
    expect(dayHeading("2026-11-05", "2026-11-03")).toEqual({
      relative: undefined,
      date: "Thu 5 Nov",
    })
  })

  test("timing: now, soon, past, or nothing", () => {
    expect(talkTiming(talk, undefined)).toBeUndefined()
    expect(talkTiming(talk, STARTS - 2 * 3_600_000)).toBeUndefined()
    expect(talkTiming(talk, STARTS - 10 * 60_000)).toEqual({ kind: "soon", minutes: 10 })
    expect(talkTiming(talk, STARTS + 60_000)).toEqual({ kind: "now" })
    expect(talkTiming(talk, STARTS + 2 * 3_600_000)).toEqual({ kind: "past" })
  })
})

describe("calendar links", () => {
  test("Google: UTC dates, London zone, details with both links", () => {
    const url = new URL(googleCalendarUrl(talk, PAGE))
    expect(url.host).toBe("calendar.google.com")
    expect(url.searchParams.get("dates")).toBe("20261103T130000Z/20261103T140000Z")
    expect(url.searchParams.get("ctz")).toBe("Europe/London")
    expect(url.searchParams.get("location")).toBe("Tilley Lecture Theatre")
    expect(url.searchParams.get("details")).toContain(PAGE)
    expect(url.searchParams.get("details")).toContain(talk.url)
  })

  test("Google: an all-day talk gets dates, an open end one hour", () => {
    const allDay = new URL(googleCalendarUrl({ ...talk, allDay: true }, PAGE))
    expect(allDay.searchParams.get("dates")).toBe("20261103/20261104")
    const open = new URL(googleCalendarUrl({ ...talk, endsAt: null }, PAGE))
    expect(open.searchParams.get("dates")).toBe("20261103T130000Z/20261103T140000Z")
  })

  test("Outlook: personal and Microsoft 365 hosts, ISO times", () => {
    const live = new URL(outlookCalendarUrl(talk, PAGE))
    expect(live.host).toBe("outlook.live.com")
    expect(live.searchParams.get("startdt")).toBe("2026-11-03T13:00:00.000Z")
    expect(live.searchParams.get("subject")).toBe(talk.title)
    expect(
      new URL(outlookCalendarUrl({ ...talk, cancelled: true }, PAGE, "outlook.office.com")).host,
    ).toBe("outlook.office.com")
    expect(
      new URL(outlookCalendarUrl({ ...talk, cancelled: true }, PAGE)).searchParams.get("subject"),
    ).toBe(`Cancelled: ${talk.title}`)
  })
})

describe("JSON-LD", () => {
  test("a schema.org Event: hybrid, scheduled, with performers", () => {
    const data = talkJsonLd(talk, PAGE)
    expect(data["@type"]).toBe("Event")
    expect(data.startDate).toBe("2026-11-03T13:00:00.000Z")
    expect(data.eventStatus).toBe("https://schema.org/EventScheduled")
    expect(data.eventAttendanceMode).toBe("https://schema.org/MixedEventAttendanceMode")
    expect(Array.isArray(data.location)).toBe(true)
    expect(data.performer).toEqual([
      {
        "@type": "Person",
        name: "Ada Example",
        affiliation: { "@type": "Organization", name: "Analytical Engines Ltd" },
      },
    ])
    expect(JSON.stringify(data)).not.toContain("A long abstract")
  })

  test("online: the virtual location is the source listing; the department in full", () => {
    const data = talkJsonLd(
      {
        ...talk,
        departments: [{ ...talk.departments[0], name: "Department of Earth Sciences" }],
      },
      PAGE,
    )
    expect(data.location).toContainEqual({ "@type": "VirtualLocation", url: talk.url })
    expect(data.sameAs).toBe(talk.url)
    expect(data.organizer).toEqual({
      "@type": "Organization",
      name: "Department of Earth Sciences",
    })
    expect(data["@id"]).toBe(`${PAGE}#event`)
    // A row without the full name keeps the short one.
    expect(talkJsonLd(talk, PAGE).organizer).toEqual({
      "@type": "Organization",
      name: "Earth Sciences",
    })
  })

  test("the page's graph: WebPage in the site, the Event, and Talks › department › talk", () => {
    const graph = talkStructuredData(talk)["@graph"] as Record<string, unknown>[]
    expect(graph.map((node) => node["@type"])).toEqual(["WebPage", "Event", "BreadcrumbList"])
    expect(graph[0]).toMatchObject({
      "@id": PAGE,
      isPartOf: { "@id": "https://camsocs.uk/#website" },
      mainEntity: { "@id": `${PAGE}#event` },
    })
    expect(graph[1]).not.toHaveProperty("isPartOf")
    expect(graph[2]).toMatchObject({
      itemListElement: [
        { position: 1, name: "Talks", item: "https://camsocs.uk/talks" },
        {
          position: 2,
          name: "Earth Sciences",
          item: "https://camsocs.uk/talks?dept=earth-sciences",
        },
        { position: 3, name: "Rivers, <ice> & time", item: PAGE },
      ],
    })
  })

  test("cancelled and in person; the script text cannot close the tag", () => {
    const data = talkJsonLd({ ...talk, cancelled: true, online: false }, PAGE)
    expect(data.eventStatus).toBe("https://schema.org/EventCancelled")
    expect(data.eventAttendanceMode).toBe("https://schema.org/OfflineEventAttendanceMode")
    expect(jsonLdScript(data)).not.toContain("<")
  })
})

describe("the Subscribe sentence", () => {
  const text = (parts: { text: string }[]) => parts.map((part) => part.text).join("")
  test("reads the filters", () => {
    expect(text(feedSentence({}))).toBe("All talks across every department")
    expect(text(feedSentence({}, "Computer Science"))).toBe("All talks in Computer Science")
    expect(text(feedSentence({ school: "technology", kind: "lecture" }))).toBe(
      "All lectures across the School of Technology",
    )
    expect(text(feedSentence({ online: true, q: "ice" }))).toBe(
      "All talks across every department, online or hybrid only, matching “ice”",
    )
  })
})

describe("physicalVenue", () => {
  test("a meeting service is not a place", () => {
    expect(physicalVenue("Online (Zoom)")).toBeNull()
    expect(physicalVenue("Zoom link sent on registration")).toBeNull()
    expect(physicalVenue("Microsoft Teams")).toBeNull()
    expect(physicalVenue(null)).toBeNull()
  })

  test("a room stays a place, also beside a meeting service", () => {
    expect(physicalVenue("FW26, William Gates Building")).toBe("FW26, William Gates Building")
    expect(physicalVenue("Online and LT1, Sidgwick Site")).toBe("Online and LT1, Sidgwick Site")
    expect(physicalVenue("Zoomorphic Gallery, Fitzwilliam Museum")).toBe(
      "Zoomorphic Gallery, Fitzwilliam Museum",
    )
  })
})

describe("the agenda's title", () => {
  test("names Cambridge and the department or School, within 60 characters", () => {
    expect(talksPageTitle({})).toEqual({ title: TALKS_TITLE, absolute: false })
    expect(talksPageTitle({}, "Computer Science")).toEqual({
      title: "Computer Science talks & seminars in Cambridge",
      absolute: false,
    })
    expect(talksPageTitle({ school: "technology" }).title).toBe(
      "Technology talks & seminars in Cambridge",
    )
    expect(talksPageTitle({ kind: "lecture" }).title).toBe("Lectures in Cambridge")
    expect(talksPageTitle({ kind: "lecture" }, "History").title).toBe("Lectures · History talks")
    const long = talksPageTitle({}, "Department of Invented and Unusually Long Studies Today")
    expect(documentTitle(long).length).toBeLessThanOrEqual(60)
    expect(documentTitle({ title: "X", absolute: false })).toBe("X · CAMsocs")
    expect(documentTitle({ title: "X", absolute: true })).toBe("X")
  })
})
