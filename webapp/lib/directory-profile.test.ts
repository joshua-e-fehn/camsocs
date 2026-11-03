import { describe, expect, test } from "bun:test"
import {
  alternateNames,
  descriptionAttribution,
  isInCambridge,
  isThinProfile,
  jsonLdEvents,
  KIND_NOUNS,
  profileLead,
  profileSources,
  schemaType,
  societyFullName,
  societyJsonLd,
  societyTitle,
} from "./directory-profile"
import { eventHasStructuredData } from "./events"
import type { EventListItem, OrgPublic } from "./public-api"
import { ORG_LEVELS, ORG_TYPES } from "./vocab"

// Synthetic listings only.

const NOW = Date.UTC(2026, 10, 1, 12)

function org(overrides: Partial<OrgPublic> = {}): OrgPublic {
  return {
    key: "org-chess-club",
    slug: "chess-club",
    name: "Chess Club",
    aliases: [],
    collegeKeys: [],
    isCounterpart: false,
    status: "active",
    registrations: {},
    categories: [],
    activityTypes: [],
    audiences: [],
    languages: [],
    tags: [],
    roleEmails: [],
    socials: [],
    chatChannels: [],
    missingFields: [],
    meta: {},
    updatedAt: NOW,
    ...overrides,
  } as OrgPublic
}

describe("societyFullName and alternateNames (G2, entity-aliases-missing)", () => {
  test("an alias naming Cambridge is the full name, preferring one containing the name", () => {
    const chess = org({ aliases: ["CUCC", "Cambridge Chess", "Cambridge University Chess Club"] })
    expect(societyFullName(chess)).toBe("Cambridge University Chess Club")
    expect(societyFullName(org({ name: "Cambridge Union" }))).toBe("Cambridge Union")
    expect(societyFullName(org({ aliases: ["CUCC"] }))).toBeUndefined()
  })

  test("never a 'University of Cambridge …' form", () => {
    expect(
      societyFullName(org({ aliases: ["University of Cambridge Chess Club"] })),
    ).toBeUndefined()
  })

  test("other names come once each, never the name itself", () => {
    const golf = org({
      name: "Golf Club",
      shortName: "CUGC",
      aliases: ["Golf Club", "golf club", "Cambridge University Golf Club", "CUGC"],
    })
    expect(alternateNames(golf)).toEqual(["Cambridge University Golf Club", "CUGC"])
  })
})

describe("societyTitle (G2)", () => {
  test("the full name when there is one", () => {
    expect(societyTitle(org({ aliases: ["Cambridge University Chess Club"] }))).toBe(
      "Cambridge University Chess Club",
    )
  })

  test("else '<Name>, Cambridge'; a name that says Cambridge stays as is", () => {
    expect(societyTitle(org())).toBe("Chess Club, Cambridge")
    expect(societyTitle(org({ name: "Cambridge Union" }))).toBe("Cambridge Union")
  })

  test("a sponsor or a society elsewhere is not placed in Cambridge", () => {
    expect(societyTitle(org({ name: "Acme Ltd", isCounterpart: true, orgType: "company" }))).toBe(
      "Acme Ltd",
    )
    expect(isInCambridge({ isCounterpart: false, level: "external" })).toBe(false)
    expect(isInCambridge({ isCounterpart: true, orgType: "college" })).toBe(true)
  })

  test("at most 60 characters: the suffix goes, then the long form", () => {
    const fortyNine = "Society for the Appreciation of Very Long Names X"
    expect(societyTitle(org({ name: fortyNine }))).toEqual({
      absolute: `${fortyNine}, Cambridge`,
    })
    const long = org({
      name: "Lindy Hop Society",
      aliases: ["Cambridge University Lindy Hop and Swing Dance Appreciation Society"],
    })
    expect(societyTitle(long)).toBe("Lindy Hop Society, Cambridge")
  })

  // Invented names of the shapes the audit found (title-length-overflow-minor).
  const text = (title: string | { absolute: string }) =>
    typeof title === "string" ? `${title} · CAMsocs` : title.absolute
  const longName = "Association of Invented and Imaginary University Students" // 57

  test("a name too long for ', Cambridge' takes a shorter name that keeps it", () => {
    expect(societyTitle(org({ name: longName, shortName: "AIIUS" }))).toBe("AIIUS, Cambridge")
    // The longest shorter form first; one naming Cambridge as it is.
    expect(
      societyTitle(
        org({ name: longName, shortName: "AIIUS", aliases: ["Cambridge Invented Students"] }),
      ),
    ).toBe("Cambridge Invented Students")
    // Never a "University of Cambridge …" form, even as the only short one.
    expect(
      societyTitle(org({ name: longName, aliases: ["University of Cambridge AIIUS"] })),
    ).toEqual({ absolute: longName })
  })

  test("a society named 'University of Cambridge …' leads with a shorter name it has", () => {
    const name = "University of Cambridge Invented Tour"
    expect(societyTitle(org({ name, shortName: "CU Invented Tour" }))).toBe(
      "CU Invented Tour, Cambridge",
    )
    // Its own name, when it is the only one: never renamed (data honesty).
    expect(societyTitle(org({ name }))).toBe(name)
  })

  // Review of the SEO audit 2026-11-02 (affiliation-copy): the title quotes
  // the society's own registered name, so it may lead with "University of
  // Cambridge"; we only never add the form ourselves.
  test("a society's own 'University of Cambridge …' name is quoted, never extended", () => {
    const name = "University of Cambridge Invented Tour"
    expect(text(societyTitle(org({ name })))).toStartWith("University of Cambridge")
    expect(text(societyTitle(org({ name })))).not.toContain(", Cambridge")
    // Too long for the limit: cut at a word, still its own name.
    const long = "University of Cambridge Society for Invented and Entirely Imaginary Tours"
    const title = text(societyTitle(org({ name: long })))
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title).toStartWith("University of Cambridge Society for")
    expect(title).toEndWith("…")
    // An alias of that form never becomes the full name or the title.
    expect(societyFullName(org({ name: "Invented Tour", aliases: [name] }))).toBeUndefined()
    expect(societyTitle(org({ name: "Invented Tour", aliases: [name] }))).toBe(
      "Invented Tour, Cambridge",
    )
  })

  test("never longer than 60: a name with no short form is cut at a word", () => {
    const name = "Society for the Promotion of Invented Hobbies and Entirely Imaginary Pastimes" // 77
    const title = text(societyTitle(org({ name })))
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title).toBe("Society for the Promotion of Invented Hobbies…, Cambridge")
    // Elsewhere: no Cambridge, still within the limit.
    const away = text(societyTitle(org({ name, isCounterpart: true, orgType: "company" })))
    expect(away.length).toBeLessThanOrEqual(60)
    expect(away).not.toContain("Cambridge")
    // A short name that fits wins over the cut.
    expect(societyTitle(org({ name, shortName: "SPIHEIP" }))).toBe("SPIHEIP, Cambridge")
  })

  test("every title fits, whatever the names", () => {
    const names = [
      "A",
      "Chess Club",
      longName,
      `${longName} and Friends of the Invented Society`,
      "Cambridge University Invented Society With a Name Long Enough to Overflow",
    ]
    for (const name of names) {
      for (const shortName of [
        undefined,
        "IS",
        "Invented Society of a Considerable Length Too, Really",
      ]) {
        expect(text(societyTitle(org({ name, shortName }))).length).toBeLessThanOrEqual(60)
      }
    }
  })
})

describe("profileLead (unique-lead-text)", () => {
  test("states the kind, place, categories, days, events and channels it holds", () => {
    const { lead, description } = profileLead({
      org: org({
        aliases: ["Cambridge University Chess Club"],
        orgType: "society",
        level: "university",
        categories: ["hobbies_games"],
        email: "chess@example.org",
        socials: [{ platform: "instagram", url: "https://instagram.com/x" }],
      }),
      collegeNames: {},
      sessions: [{ dayOfWeek: 4 }, { dayOfWeek: 2 }, { dayOfWeek: 2 }],
      upcomingEvents: 3,
    })
    expect(lead).toBe(
      "Cambridge University Chess Club is a university-wide society in Cambridge, listed under Hobbies, Games & Food. It meets on Tuesdays and Thursdays, has 3 upcoming events listed and can be reached through email or Instagram.",
    )
    expect(description.length).toBeLessThanOrEqual(160)
    expect(description).toBe(
      "Cambridge University Chess Club is a university-wide society in Cambridge, listed under Hobbies, Games & Food.",
    )
  })

  test("a college society names its college; a sports club its sport", () => {
    const { lead } = profileLead({
      org: org({
        name: "Boat Club",
        orgType: "college_boat_club",
        level: "college",
        collegeKeys: ["org-x"],
        sport: { sport: "Rowing", genderCategories: [] },
      }),
      collegeNames: { "org-x": "Example College" },
      sessions: [],
      upcomingEvents: 0,
    })
    expect(lead).toBe("Boat Club is a boat club (rowing) at Example College, Cambridge.")
  })

  test("says nothing it does not hold", () => {
    const { lead } = profileLead({ org: org(), collegeNames: {}, sessions: [], upcomingEvents: 0 })
    expect(lead).toBe("Chess Club is a student group in Cambridge.")
  })

  test("an archived listing says so; a partner says what it is", () => {
    expect(
      profileLead({
        org: org({ status: "archived", orgType: "society", website: "https://x.org" }),
        collegeNames: {},
        sessions: [],
        upcomingEvents: 0,
      }).lead,
    ).toBe("Chess Club is a society in Cambridge. A source lists it as no longer active.")
    expect(
      profileLead({
        org: org({ name: "Acme Ltd", isCounterpart: true, orgType: "company" }),
        collegeNames: {},
        sessions: [],
        upcomingEvents: 0,
      }).lead,
    ).toBe(
      "Acme Ltd is a company that Cambridge student societies name as a sponsor, host or partner.",
    )
  })
})

describe("profileLead: the kind phrase for every type and level", () => {
  const leadFor = (overrides: Partial<OrgPublic>) =>
    profileLead({ org: org(overrides), collegeNames: {}, sessions: [], upcomingEvents: 0 }).lead

  test("never 'an another', 'a another' or a wrong a/an, with or without a level", () => {
    for (const orgType of ORG_TYPES) {
      for (const level of [undefined, ...ORG_LEVELS]) {
        for (const isCounterpart of [false, true]) {
          const lead = leadFor({ orgType, level, isCounterpart })
          expect(lead).not.toMatch(/\ban? another\b/i)
          // "an" before a consonant sound, "a" before a vowel sound.
          expect(lead).not.toMatch(/\ban (?!MCR|NGO|intercollegiate|[aeio])/)
          expect(lead).not.toMatch(/\ba (?:intercollegiate|[aeio]|MCR\b)/i)
          // No level word repeating the kind ("a university-wide University office").
          expect(lead).not.toMatch(/university-wide University|departmental department/i)
        }
      }
    }
  })

  test("other is 'a group'; levels read naturally", () => {
    expect(leadFor({ name: "Invented Group", orgType: "other" })).toBe(
      "Invented Group is a group in Cambridge.",
    )
    expect(leadFor({ name: "Invented Group", orgType: "other", level: "university" })).toBe(
      "Invented Group is a university-wide group in Cambridge.",
    )
    expect(leadFor({ name: "Invented Group", orgType: "other", level: "intercollegiate" })).toBe(
      "Invented Group is an intercollegiate group in Cambridge.",
    )
    expect(leadFor({ name: "Invented Office", orgType: "uni_office", level: "university" })).toBe(
      "Invented Office is a University office in Cambridge.",
    )
    expect(leadFor({ name: "Invented MCR", orgType: "mcr" })).toBe(
      "Invented MCR is an MCR in Cambridge.",
    )
    expect(leadFor({ name: "Invented Partner", orgType: "other", isCounterpart: true })).toBe(
      "Invented Partner is a group that Cambridge student societies name as a sponsor, host or partner.",
    )
  })

  test("every type has a bare noun with no article", () => {
    for (const orgType of ORG_TYPES) expect(KIND_NOUNS[orgType]).not.toMatch(/^(an?|another) /i)
  })
})

test("isThinProfile: only no description, no events and no website (G3)", () => {
  const none = { hasDescription: false, hasWebsite: false, hasEvents: false }
  expect(isThinProfile(none)).toBe(true)
  expect(isThinProfile({ ...none, hasDescription: true })).toBe(false)
  expect(isThinProfile({ ...none, hasWebsite: true })).toBe(false)
  expect(isThinProfile({ ...none, hasEvents: true })).toBe(false)
})

describe("provenance (provenance-not-crawlable)", () => {
  const meta: OrgPublic["meta"] = {
    name: {
      status: "found",
      sourceUrl: "https://www.cambridgesu.co.uk/organisation/1/",
      retrievedAt: 5,
    },
    description: {
      status: "found",
      sourceUrl: "https://www.cambridgesu.co.uk/organisation/1/",
      sourceType: "su_profile",
      retrievedAt: NOW,
    },
    website: { status: "found", sourceUrl: "https://example.org/", retrievedAt: 3 },
    email: { status: "found", sourceType: "manual" },
    joinUrl: { status: "missing", missingReason: "not_found", sourceUrl: "https://gone.example/" },
    termcardUrl: { status: "found", sourceUrl: "https://talks.cam.ac.uk/show/index/1" },
  }

  test("each public source once, with the facts it backs, most-used first", () => {
    expect(profileSources(meta)).toEqual([
      {
        url: "https://www.cambridgesu.co.uk/organisation/1/",
        host: "cambridgesu.co.uk",
        fields: ["Name", "Description"],
        retrievedAt: NOW,
      },
      { url: "https://example.org/", host: "example.org", fields: ["Website"], retrievedAt: 3 },
    ])
  })

  test("the About text names where it came from", () => {
    expect(descriptionAttribution(meta)).toEqual({
      url: "https://www.cambridgesu.co.uk/organisation/1/",
      label: "the society’s Cambridge SU profile",
      own: true,
      retrievedOn: expect.any(String),
    })
    expect(descriptionAttribution({})).toBeUndefined()
  })
})

describe("societyJsonLd (org-jsonld-thin, jsonld-graph-breadcrumbs)", () => {
  const listed = (key: string, overrides: Partial<EventListItem> = {}) =>
    ({
      key,
      title: "Invented social",
      visibility: "public",
      status: "confirmed",
      source: "ics",
      allDay: false,
      talksDerived: false,
      ...overrides,
    }) as EventListItem
  const events = [
    listed("evt-1"),
    listed("evt-2", { visibility: "cam_only" }),
    listed("evt-3", { source: "talks_cam", talksDerived: true }),
    // Convex's verdict, from provenance this list item does not show.
    listed("evt-4", { talksDerived: true }),
  ]

  test("links only public events not from talks.cam", () => {
    expect(jsonLdEvents(events)).toEqual(["evt-1"])
  })

  test("links only events whose own page has the Event node (no dangling @id)", () => {
    const candidates = [
      listed("evt-read", { meta: { startsAt: { status: "found" } } }),
      listed("evt-inferred", { meta: { startsAt: { status: "inferred" } } }),
      listed("evt-tbc-title", { title: "Winter formal (date TBC)" }),
      listed("evt-tbc-status", { status: "tbc" }),
      // A day-long event read from its source has an Event node (a date).
      listed("evt-all-day", { allDay: true }),
      // A model's start is the source's dated words where the pipeline asked
      // for a dated quote; an Instagram caption's or a parser's guess is not.
      listed("evt-model-day", {
        allDay: true,
        meta: { startsAt: { status: "inferred", method: "llm", sourceType: "society_website" } },
      }),
      listed("evt-caption-guess", {
        allDay: true,
        meta: { startsAt: { status: "inferred", method: "llm", sourceType: "instagram_api" } },
      }),
      listed("evt-parser-guess", { meta: { startsAt: { status: "inferred", method: "parser" } } }),
    ]
    expect(jsonLdEvents(candidates)).toEqual(["evt-read", "evt-all-day", "evt-model-day"])
    // The same predicate as the event page's, so the two can never disagree.
    for (const event of candidates) {
      expect(jsonLdEvents([event]).length === 1).toBe(eventHasStructuredData(event))
    }
  })

  test("types by org type; never an educational institution", () => {
    expect(schemaType("sports_club")).toBe("SportsOrganization")
    expect(schemaType("college_boat_club")).toBe("SportsOrganization")
    expect(schemaType("theatre_company")).toBe("TheaterGroup")
    expect(schemaType("ngo")).toBe("NGO")
    expect(schemaType("college")).toBe("Organization")
    expect(schemaType(undefined)).toBe("Organization")
  })

  test("one graph: page, organisation and breadcrumbs joined by @id", () => {
    const data = societyJsonLd({
      org: org({
        orgType: "sports_club",
        categories: ["sport"],
        aliases: ["Cambridge University Chess Club"],
        sport: { sport: "Chess", genderCategories: [] },
        email: "chess@example.org",
        joinUrl: "https://example.org/join",
        website: "https://example.org/",
        socials: [{ platform: "instagram", url: "https://instagram.com/x" }],
        meta: { website: { status: "found", sourceUrl: "https://example.org/" } },
      }),
      title: "Cambridge University Chess Club",
      description: "A lead.",
      eventKeys: ["evt-1"],
    })
    const [page, organization, breadcrumbs] = data["@graph"] as Record<string, unknown>[]
    expect(page).toMatchObject({
      "@type": "ProfilePage",
      "@id": "https://camsocs.uk/societies/chess-club",
      isPartOf: { "@id": "https://camsocs.uk/#website" },
      mainEntity: { "@id": "https://camsocs.uk/societies/chess-club#organization" },
      breadcrumb: { "@id": "https://camsocs.uk/societies/chess-club#breadcrumb" },
      dateModified: new Date(NOW).toISOString(),
      isBasedOn: ["https://example.org/"],
    })
    expect(organization).toEqual({
      "@type": "SportsOrganization",
      "@id": "https://camsocs.uk/societies/chess-club#organization",
      name: "Chess Club",
      alternateName: ["Cambridge University Chess Club"],
      description: "A lead.",
      url: "https://example.org/",
      email: "chess@example.org",
      sameAs: ["https://instagram.com/x"],
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "membership",
        url: "https://example.org/join",
      },
      sport: "Chess",
      location: {
        "@type": "Place",
        name: "Cambridge",
        address: { "@type": "PostalAddress", addressLocality: "Cambridge", addressCountry: "GB" },
      },
      keywords: "Sport & Fitness",
      event: [{ "@id": "https://camsocs.uk/events/evt-1#event" }],
    })
    expect(organization).not.toHaveProperty("isPartOf")
    expect(organization).not.toHaveProperty("mainEntityOfPage")
    expect(breadcrumbs).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 1, name: "Societies", item: "https://camsocs.uk/societies" },
        { position: 2, name: "Sport & Fitness", item: "https://camsocs.uk/categories/sport" },
        { position: 3, name: "Chess Club", item: "https://camsocs.uk/societies/chess-club" },
      ],
    })
  })
})
