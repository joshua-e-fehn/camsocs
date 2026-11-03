import { describe, expect, test } from "bun:test"
import emailTypes from "../../lib/email-types.fixtures.json"
import {
  ACTIVE_WINDOW_MS,
  academicYearOf,
  classifyEmail,
  DAY_MS,
  deriveOrgStatus,
  isUniversityListing,
  londonIsoDate,
  londonOffsetMs,
  nextHandoverDate,
  orgSearchText,
  sweepGroupOf,
  type TermDates,
  termWeekLabel,
} from "./derived"

/** The 2026-27 Full Term dates (source-research §19). */
const TERMS: TermDates[] = [
  {
    academicYear: "2026-27",
    term: "michaelmas",
    fullTermStart: "2026-10-06",
    fullTermEnd: "2026-12-04",
  },
  { academicYear: "2026-27", term: "lent", fullTermStart: "2027-01-19", fullTermEnd: "2027-03-19" },
  {
    academicYear: "2026-27",
    term: "easter",
    fullTermStart: "2027-04-27",
    fullTermEnd: "2027-06-18",
  },
]

/** An instant at a London wall-clock time (BST-aware via londonOffsetMs). */
function london(iso: string): number {
  const naive = Date.parse(`${iso}Z`)
  return naive - londonOffsetMs(naive)
}

describe("Europe/London calendar", () => {
  test("BST runs from the last Sunday of March to the last Sunday of October, 01:00 UTC", () => {
    expect(londonOffsetMs(Date.UTC(2026, 2, 29, 0, 59))).toBe(0)
    expect(londonOffsetMs(Date.UTC(2026, 2, 29, 1, 0))).toBe(3_600_000)
    expect(londonOffsetMs(Date.UTC(2026, 9, 25, 0, 59))).toBe(3_600_000)
    expect(londonOffsetMs(Date.UTC(2026, 9, 25, 1, 0))).toBe(0)
  })

  test("a late-evening UTC instant in summer is the next London day", () => {
    expect(londonIsoDate(Date.UTC(2026, 6, 1, 23, 30))).toBe("2026-07-02")
    expect(londonIsoDate(Date.UTC(2026, 11, 1, 23, 30))).toBe("2026-12-01")
  })

  test("academic years turn over on 1 July", () => {
    expect(academicYearOf(london("2026-06-30T23:59:00"))).toBe("2025-26")
    expect(academicYearOf(london("2026-07-01T00:00:00"))).toBe("2026-27")
    expect(academicYearOf(london("2027-01-15T12:00:00"))).toBe("2026-27")
    expect(academicYearOf(london("2099-09-01T12:00:00"))).toBe("2099-00")
  })

  test("named contacts go stale on the next 30 June", () => {
    expect(nextHandoverDate(london("2026-10-07T12:00:00"))).toBe("2027-06-30")
    expect(nextHandoverDate(london("2027-06-30T12:00:00"))).toBe("2027-06-30")
    expect(nextHandoverDate(london("2027-07-01T12:00:00"))).toBe("2028-06-30")
  })
})

describe("termWeekLabel", () => {
  test("Week 1 starts on the first Thursday of Full Term; Week 0 is the week before", () => {
    expect(termWeekLabel(london("2026-10-07T19:00:00"), TERMS)).toBe("MT26 Wk 0")
    expect(termWeekLabel(london("2026-10-08T09:00:00"), TERMS)).toBe("MT26 Wk 1")
    expect(termWeekLabel(london("2026-10-14T23:30:00"), TERMS)).toBe("MT26 Wk 1")
    expect(termWeekLabel(london("2026-10-15T00:30:00"), TERMS)).toBe("MT26 Wk 2")
    expect(termWeekLabel(london("2026-12-04T12:00:00"), TERMS)).toBe("MT26 Wk 9")
  })

  test("the last week stops with Full Term (Fri 4 Dec), not on its Wednesday", () => {
    expect(termWeekLabel(london("2026-12-04T23:30:00"), TERMS)).toBe("MT26 Wk 9")
    expect(termWeekLabel(london("2026-12-05T12:00:00"), TERMS)).toBeUndefined()
    expect(termWeekLabel(london("2026-12-09T12:00:00"), TERMS)).toBeUndefined()
  })

  test("Lent and Easter use the calendar year of their start", () => {
    expect(termWeekLabel(london("2027-01-21T12:00:00"), TERMS)).toBe("LT27 Wk 1")
    expect(termWeekLabel(london("2027-05-01T12:00:00"), TERMS)).toBe("ET27 Wk 1")
  })

  test("vacations get no label", () => {
    expect(termWeekLabel(london("2026-09-20T12:00:00"), TERMS)).toBeUndefined()
    expect(termWeekLabel(london("2026-12-25T12:00:00"), TERMS)).toBeUndefined()
    expect(termWeekLabel(london("2026-10-07T12:00:00"), [])).toBeUndefined()
  })
})

describe("deriveOrgStatus (data-model §6)", () => {
  const now = london("2026-10-07T12:00:00")

  test("defunct is archived whatever else is true", () => {
    expect(deriveOrgStatus({ defunct: true, lastActiveAt: now }, now)).toBe("archived")
  })

  test("recent activity is active; old activity without a registration is dormant", () => {
    expect(deriveOrgStatus({ lastActiveAt: now - 10 * DAY_MS }, now)).toBe("active")
    expect(deriveOrgStatus({ lastActiveAt: now - ACTIVE_WINDOW_MS - DAY_MS }, now)).toBe("dormant")
  })

  test("a registration for the current academic year makes it active", () => {
    const old = now - 400 * DAY_MS
    expect(
      deriveOrgStatus(
        { lastActiveAt: old, registrations: { proctors: { registered: true, year: "2026-27" } } },
        now,
      ),
    ).toBe("active")
    expect(
      deriveOrgStatus(
        { lastActiveAt: old, registrations: { proctors: { registered: true, year: "2025-26" } } },
        now,
      ),
    ).toBe("dormant")
    expect(
      deriveOrgStatus({ registrations: { su: { registered: false, year: "2026-27" } } }, now),
    ).toBe("unknown")
  })

  test("a year-less registration counts when it was seen this academic year", () => {
    const org = {
      registrations: { su: { registered: true } },
      meta: { "registrations.su": { status: "found" as const, retrievedAt: now - DAY_MS } },
    }
    expect(deriveOrgStatus(org, now)).toBe("active")
    const stale = {
      ...org,
      meta: { "registrations.su": { status: "found" as const, retrievedAt: now - 200 * DAY_MS } },
    }
    expect(deriveOrgStatus(stale, now)).toBe("unknown")
  })

  test("no signal at all is unknown", () => {
    expect(deriveOrgStatus({}, now)).toBe("unknown")
  })

  test("a Camdram listing alone is no current registration (ENG-36)", () => {
    // Camdram keeps every society that ever put on a show.
    const seen = { status: "found" as const, retrievedAt: now - DAY_MS }
    const listed = {
      registrations: { camdram: { registered: true } },
      meta: { "registrations.camdram": seen },
    }
    expect(deriveOrgStatus(listed, now)).toBe("unknown")
    expect(deriveOrgStatus({ ...listed, lastActiveAt: now - 400 * DAY_MS }, now)).toBe("dormant")
    // A show this term counts as activity, like any event.
    expect(deriveOrgStatus({ ...listed, lastActiveAt: now - 20 * DAY_MS }, now)).toBe("active")
    // The registers that list only this year's groups still count.
    const both = {
      registrations: { camdram: { registered: true }, su: { registered: true, year: "2026-27" } },
      meta: { "registrations.camdram": seen },
    }
    expect(deriveOrgStatus(both, now)).toBe("active")
    const rowing = { registrations: { cucbc: { registered: true, year: "2026-27" } } }
    expect(deriveOrgStatus(rowing, now)).toBe("active")
  })
})

describe("sweepGroupOf", () => {
  test("whole-source listings, per-URL listings and one-off readings", () => {
    expect(sweepGroupOf("camdram", "https://www.camdram.net/shows/x.json", "show:1")).toBe(
      "camdram",
    )
    expect(sweepGroupOf("ics", "https://Example.org/cal.ics/", "uid-1")).toBe(
      "ics:example.org/cal.ics",
    )
    expect(sweepGroupOf("mailing_list", "inbound:<m1>", "org-q:2026-11-10:quiz")).toBeUndefined()
  })

  test("a society's pages and cards are one listing per society (ENG-36)", () => {
    const calendar = "https://german-society.example/calendars/"
    const events = "https://german-society.example/our-events/"
    expect(sweepGroupOf("website", calendar, "org-german-society:2026-11-07:med")).toBe(
      "own:org-german-society",
    )
    expect(sweepGroupOf("termcard", events, "org-german-society:2026-11-07:med")).toBe(
      "own:org-german-society",
    )
    // Another society on the same host is its own listing.
    expect(sweepGroupOf("website", calendar, "org-french-society:2026-11-07:x")).toBe(
      "own:org-french-society",
    )
    // An external id without an organisation keeps its listing URL.
    expect(sweepGroupOf("termcard", events, "list:x:2026-11-07:med")).toBe(
      "termcard:german-society.example/our-events",
    )
    expect(sweepGroupOf("website", calendar)).toBe("website:german-society.example/calendars")
  })
})

describe("classifyEmail", () => {
  // Shared with the pipeline (pipeline/src/tests/test_links.py), which withholds
  // personal CRSid addresses by the same rules before anything is posted.
  test.each(emailTypes.cases.map((c) => [c.email, c.type]))("%s → %s", (email, type) => {
    expect(classifyEmail(email)).toBe(type as never)
  })
})

describe("orgSearchText", () => {
  test("joins names, short description, tags and category labels, lowercased and de-duplicated", () => {
    const text = orgSearchText({
      name: "CU German Society",
      aliases: ["German Soc", "cu german society"],
      shortName: "CUGS",
      shortDescription: "Stammtisch and films",
      tags: ["film-nights"],
      categories: ["cultural_international"],
    })
    expect(text).toBe(
      "cu german society · german soc · cugs · stammtisch and films · film nights · cultural & international",
    )
  })
})

describe("isUniversityListing (ENG-24)", () => {
  const listing = { source: "uni_events_api", organiserKeys: [], coHostKeys: [] }

  test("a University programme event credited to no student group", () => {
    expect(isUniversityListing(listing)).toBe(true)
  })

  test("not once a society organises or co-hosts it, nor from any other source", () => {
    expect(isUniversityListing({ ...listing, organiserKeys: ["org-chess"] })).toBe(false)
    expect(isUniversityListing({ ...listing, coHostKeys: ["org-chess"] })).toBe(false)
    expect(isUniversityListing({ ...listing, source: "ics" })).toBe(false)
    expect(isUniversityListing({ ...listing, source: "talks_cam" })).toBe(false)
  })
})
