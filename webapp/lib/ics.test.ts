import { describe, expect, test } from "bun:test"
import {
  escapeText,
  eventIcsFile,
  foldLine,
  type IcsTalk,
  parseTalkFeedParams,
  talkDescription,
  talkFeedName,
  talkIcsFile,
  talksCalendar,
  utcStamp,
} from "./ics"

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

const TALK: IcsTalk = {
  key: "talk-e1db06584b598cb47e57",
  title: "Types, proofs; and programs",
  speakers: [{ name: "Ada Lovelace", affiliation: "Analytical Engines Ltd" }],
  series: "Programming, Logic and Semantics",
  departments: [{ shortName: "Computer Science", slug: "computer-science-and-technology" }],
  startsAt: Date.UTC(2026, 10, 3, 14, 0, 0),
  endsAt: Date.UTC(2026, 10, 3, 15, 0, 0),
  allDay: false,
  venue: "FW26, William Gates Building",
  online: false,
  cancelled: false,
  url: "https://talks.cam.ac.uk/talk/index/12345",
}

const octets = (line: string) => new TextEncoder().encode(line).length

/** Undoes folding (RFC 5545 §3.1): CRLF followed by one space. */
const unfold = (text: string) => text.replace(/\r\n /g, "")

describe("escapeText", () => {
  test("escapes backslash, semicolon, comma and line breaks", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf")
  })
})

describe("foldLine", () => {
  test("leaves a line of 75 octets alone", () => {
    const line = "x".repeat(75)
    expect(foldLine(line)).toBe(line)
  })

  test("folds at 75 octets with CRLF and a space", () => {
    const line = `DESCRIPTION:${"y".repeat(200)}`
    const folded = foldLine(line)
    const lines = folded.split("\r\n")
    expect(lines.length).toBeGreaterThan(1)
    for (const [index, part] of lines.entries()) {
      expect(octets(part)).toBeLessThanOrEqual(75)
      if (index > 0) expect(part.startsWith(" ")).toBe(true)
    }
    expect(unfold(folded)).toBe(line)
  })

  test("counts UTF-8 octets and never splits a character", () => {
    const line = `SUMMARY:${"é".repeat(60)}`
    const folded = foldLine(line)
    for (const part of folded.split("\r\n")) expect(octets(part)).toBeLessThanOrEqual(75)
    expect(unfold(folded)).toBe(line)
    expect(folded).not.toContain("�")
  })
})

describe("talksCalendar", () => {
  const calendar = talksCalendar([TALK], { name: "camsocs talks", now: NOW })

  test("is CRLF throughout, ends with CRLF, every line at most 75 octets", () => {
    expect(calendar.endsWith("\r\n")).toBe(true)
    expect(calendar.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/)
    for (const line of calendar.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75)
  })

  test("wraps the events in a VCALENDAR with a UID per talk and UTC times", () => {
    const lines = unfold(calendar).split("\r\n")
    expect(lines[0]).toBe("BEGIN:VCALENDAR")
    expect(lines).toContain("VERSION:2.0")
    expect(lines).toContain("UID:talk-e1db06584b598cb47e57@camsocs.uk")
    expect(lines).toContain(`DTSTAMP:${utcStamp(NOW)}`)
    expect(lines).toContain("DTSTART:20261103T140000Z")
    expect(lines).toContain("DTEND:20261103T150000Z")
    expect(lines).toContain("SUMMARY:Types\\, proofs\\; and programs")
    expect(lines).toContain("LOCATION:FW26\\, William Gates Building")
    expect(lines).toContain("URL:https://talks.cam.ac.uk/talk/index/12345")
    expect(lines).toContain("STATUS:CONFIRMED")
    expect(lines.at(-2)).toBe("END:VCALENDAR")
  })

  test("the description names speaker, series and the source link", () => {
    const description = unfold(calendar)
      .split("\r\n")
      .find((line) => line.startsWith("DESCRIPTION:"))
    expect(description).toBe(
      "DESCRIPTION:Speaker: Ada Lovelace (Analytical Engines Ltd)\\n" +
        "Series: Programming\\, Logic and Semantics\\n" +
        "Department: Computer Science\\n" +
        "Source: https://talks.cam.ac.uk/talk/index/12345",
    )
  })

  test("an all-day talk uses London dates with an exclusive end", () => {
    // 00:00 BST on 1 July is 23:00 UTC on 30 June.
    const allDay = {
      ...TALK,
      allDay: true,
      startsAt: Date.UTC(2026, 5, 30, 23, 0, 0),
      endsAt: Date.UTC(2026, 6, 2, 23, 0, 0),
    }
    const lines = unfold(talksCalendar([allDay], { name: "x", now: NOW })).split("\r\n")
    expect(lines).toContain("DTSTART;VALUE=DATE:20260701")
    expect(lines).toContain("DTEND;VALUE=DATE:20260703")
  })

  test("a cancelled talk says so; an online one with no venue is Online; no end, no DTEND", () => {
    const cancelled = { ...TALK, cancelled: true, venue: null, online: true, endsAt: null }
    const text = unfold(talksCalendar([cancelled], { name: "x", now: NOW }))
    expect(text).toContain("STATUS:CANCELLED")
    expect(text).toContain("SUMMARY:Cancelled: Types")
    expect(text).toContain("LOCATION:Online")
    expect(text).not.toContain("DTEND")
    expect(talkDescription(cancelled)).toStartWith("This talk is cancelled.")
  })

  test("an empty feed is still a valid calendar", () => {
    const text = talksCalendar([], { name: "camsocs talks", now: NOW })
    expect(text).toStartWith("BEGIN:VCALENDAR\r\n")
    expect(text).toEndWith("END:VCALENDAR\r\n")
    expect(text).not.toContain("BEGIN:VEVENT")
  })
})

describe("parseTalkFeedParams", () => {
  test("reads school, dept, kind and q; empty values are absent", () => {
    const parsed = parseTalkFeedParams(
      new URLSearchParams("school=technology&dept=history&kind=seminar&q=%20types%20&online="),
    )
    expect(parsed).toEqual({
      ok: true,
      filters: { school: "technology", department: "history", kind: "seminar", q: "types" },
    })
    expect(parseTalkFeedParams(new URLSearchParams("school="))).toEqual({ ok: true, filters: {} })
  })

  test("refuses unknown values", () => {
    expect(parseTalkFeedParams(new URLSearchParams("school=law")).ok).toBe(false)
    expect(parseTalkFeedParams(new URLSearchParams("kind=party")).ok).toBe(false)
    expect(parseTalkFeedParams(new URLSearchParams("dept=../etc")).ok).toBe(false)
    expect(parseTalkFeedParams(new URLSearchParams("online=maybe")).ok).toBe(false)
  })

  test("reads online as yes / no, like the /talks URL", () => {
    expect(parseTalkFeedParams(new URLSearchParams("online=yes"))).toEqual({
      ok: true,
      filters: { online: true },
    })
    expect(parseTalkFeedParams(new URLSearchParams("online=no"))).toEqual({
      ok: true,
      filters: { online: false },
    })
    expect(talkFeedName({ online: true })).toBe("camsocs talks · Online")
  })
})

describe("talkIcsFile (/talks/<key>/ics)", () => {
  test("one VEVENT with the feed's UID, named after the talk", () => {
    const { body, filename } = talkIcsFile(TALK, NOW)
    const text = unfold(body)
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(text).toContain(`UID:${TALK.key}@camsocs.uk`)
    expect(text).toContain("DTSTART:20261103T140000Z")
    expect(text).toContain("DTEND:20261103T150000Z")
    // A one-off event, not a feed: no calendar name or refresh hints.
    expect(text).not.toContain("X-WR-CALNAME")
    expect(text).not.toContain("REFRESH-INTERVAL")
    expect(text).not.toContain("X-PUBLISHED-TTL")
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true)
    expect(filename).toBe("types-proofs-and-programs.ics")
  })

  test("a title with nothing to keep still gets a file name", () => {
    expect(talkIcsFile({ ...TALK, title: "¿¡…!?" }, NOW).filename).toBe("talk.ics")
    expect(talkIcsFile({ ...TALK, title: "Café Scientifique: über alles" }, NOW).filename).toBe(
      "cafe-scientifique-uber-alles.ics",
    )
  })
})

describe("talkFeedName", () => {
  test("names the filters", () => {
    expect(talkFeedName({})).toBe("camsocs talks")
    expect(talkFeedName({ school: "technology", kind: "seminar" })).toBe(
      "camsocs talks · Technology · Seminars",
    )
    expect(talkFeedName({ department: "history" }, "History")).toBe("camsocs talks · History")
  })
})

describe("eventIcsFile (/events/<key>/ics)", () => {
  const EVENT = {
    key: `evt-${"b".repeat(40)}`,
    title: "🚩 Bumps, Day 1; the start",
    startsAt: Date.UTC(2026, 10, 3, 19, 30, 0),
    endsAt: Date.UTC(2026, 10, 3, 22, 0, 0),
    allDay: false,
    venueText: "Fen Ditton, Cambridge",
    cancelled: false,
    hosting: "hosts",
    organisers: [
      { name: "CU Boat Club", role: "organiser" },
      { name: "A Sponsor", role: "sponsor" },
    ],
  }
  const PAGE = `https://camsocs.uk/events/${EVENT.key}`

  test("one VEVENT with a stable UID, the page as URL, and no feed name", () => {
    const { body, filename } = eventIcsFile(EVENT, PAGE, NOW)
    for (const line of body.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75)
    const lines = unfold(body).split("\r\n")
    expect(lines[0]).toBe("BEGIN:VCALENDAR")
    expect(lines).toContain("PRODID:-//camsocs//Events//EN")
    expect(lines).toContain(`UID:${EVENT.key}@camsocs.uk`)
    expect(lines).toContain("DTSTART:20261103T193000Z")
    expect(lines).toContain("DTEND:20261103T220000Z")
    expect(lines).toContain("SUMMARY:🚩 Bumps\\, Day 1\\; the start")
    expect(lines).toContain("LOCATION:Fen Ditton\\, Cambridge")
    expect(lines).toContain(`URL:${PAGE}`)
    expect(lines).toContain(`DESCRIPTION:Organised by CU Boat Club\\nDetails: ${PAGE}`)
    expect(lines.some((line) => line.startsWith("X-WR-CALNAME"))).toBe(false)
    expect(filename).toBe("bumps-day-1-the-start.ics")
  })

  test("someone else's event names who takes part (D6); cancelled says so", () => {
    const { body } = eventIcsFile(
      { ...EVENT, hosting: "takes_part", cancelled: true, venueText: undefined, endsAt: undefined },
      PAGE,
      NOW,
    )
    const lines = unfold(body).split("\r\n")
    expect(lines).toContain("SUMMARY:Cancelled: 🚩 Bumps\\, Day 1\\; the start")
    expect(lines).toContain("STATUS:CANCELLED")
    expect(lines.some((line) => line.startsWith("LOCATION"))).toBe(false)
    expect(lines.some((line) => line.startsWith("DTEND"))).toBe(false)
    expect(lines.find((line) => line.startsWith("DESCRIPTION"))).toContain(
      "Taking part: CU Boat Club",
    )
  })

  test("a title with nothing to keep is event.ics", () => {
    expect(eventIcsFile({ ...EVENT, title: "🎉🎉" }, PAGE, NOW).filename).toBe("event.ics")
  })

  test("the University's own listing names the programme and its page there (ENG-24)", () => {
    const listing = "https://events.example.ac.uk/whats-on/lantern-lecture"
    const { body } = eventIcsFile(
      { ...EVENT, organisers: [], fromUniversity: true, sourceUrl: listing },
      PAGE,
      NOW,
    )
    const description = unfold(body)
      .split("\r\n")
      .find((line) => line.startsWith("DESCRIPTION"))
    expect(description).toBe(
      `DESCRIPTION:Listed in the University of Cambridge’s public events programme: ${listing}\\nDetails: ${PAGE}`,
    )
    expect(description).not.toContain("Organised by")
  })
})
