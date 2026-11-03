import { describe, expect, test } from "bun:test"
import { isTalksCamEvent, stripTalksCamText, withoutTalksCam } from "./directory-talks-guard"
import { isTalksCamUrl } from "./talks-boundary"

// Synthetic data only: no real talk, list or speaker.

describe("isTalksCamUrl", () => {
  test("talks.cam and its subdomains, with or without a scheme", () => {
    expect(isTalksCamUrl("https://talks.cam.ac.uk/talk/index/1")).toBe(true)
    expect(isTalksCamUrl("http://www.talks.cam.ac.uk/show/index/2")).toBe(true)
    expect(isTalksCamUrl("talks.cam.ac.uk/list")).toBe(true)
    expect(isTalksCamUrl("HTTPS://TALKS.CAM.AC.UK/")).toBe(true)
  })

  test("never another host that merely mentions it", () => {
    expect(isTalksCamUrl("https://example.org/?ref=talks.cam.ac.uk")).toBe(false)
    expect(isTalksCamUrl("https://nottalks.cam.ac.uk.example.org/")).toBe(false)
    expect(isTalksCamUrl("https://www.cam.ac.uk/")).toBe(false)
    expect(isTalksCamUrl("not a url")).toBe(false)
  })
})

describe("isTalksCamEvent", () => {
  test("by source, source page or external page", () => {
    expect(isTalksCamEvent({ source: "talks_cam" })).toBe(true)
    expect(isTalksCamEvent({ source: "ics", sourceUrl: "https://talks.cam.ac.uk/x.ics" })).toBe(
      true,
    )
    expect(isTalksCamEvent({ source: "website", externalUrl: "https://talks.cam.ac.uk/t" })).toBe(
      true,
    )
    expect(isTalksCamEvent({ source: "ics", sourceUrl: "https://example.org/cal.ics" })).toBe(false)
  })

  test("a projection's talksDerived verdict wins, whatever it shows", () => {
    // Convex read talks.cam provenance this projection does not carry.
    expect(
      isTalksCamEvent({
        source: "ics",
        sourceUrl: "https://example.org/cal.ics",
        talksDerived: true,
      }),
    ).toBe(true)
  })
})

describe("stripTalksCamText", () => {
  test("cuts markdown links to their text and drops bare URLs", () => {
    expect(stripTalksCamText("See [our list](https://talks.cam.ac.uk/show/index/9) soon.")).toBe(
      "See our list soon.",
    )
    expect(stripTalksCamText("Talks at https://talks.cam.ac.uk/show/index/9 weekly")).toBe(
      "Talks at weekly",
    )
    expect(stripTalksCamText("Nothing to see")).toBe("Nothing to see")
  })
})

describe("withoutTalksCam: a profile page", () => {
  const page = {
    org: {
      name: "Invented Society",
      website: "https://talks.cam.ac.uk/show/index/1",
      description: "We meet weekly. Programme: [here](https://talks.cam.ac.uk/show/index/1).",
      socials: [
        { platform: "instagram", url: "https://instagram.com/invented" },
        { platform: "other", url: "https://talks.cam.ac.uk/show/index/1" },
      ],
      meta: {
        website: { status: "found", sourceUrl: "https://talks.cam.ac.uk/show/index/1" },
        name: {
          status: "conflicting",
          confidence: 0.9,
          sourceUrl: "https://example.org/",
          conflicts: [{ value: "Other", sourceUrl: "https://talks.cam.ac.uk/a" }],
        },
      },
    },
    events: [
      { key: "evt-a", title: "Invented talk", source: "talks_cam", startsAt: 1 },
      { key: "evt-b", title: "Invented social", source: "ics", startsAt: 2 },
      {
        key: "evt-c",
        title: "Invented seminar",
        source: "ics",
        sourceUrl: "https://talks.cam.ac.uk/feed.ics",
        startsAt: 3,
      },
    ],
    relationships: [
      {
        key: "rel-1",
        evidence: [
          { sourceUrl: "https://talks.cam.ac.uk/talk/1", seenAt: 1 },
          { sourceUrl: "https://example.org/e", seenAt: 2 },
        ],
      },
    ],
  }

  const clean = withoutTalksCam(page)

  test("no string anywhere still names talks.cam (the G1 invariant)", () => {
    expect(JSON.stringify(clean)).not.toContain("talks.cam")
  })

  test("talks.cam events leave the list; others stay", () => {
    expect(clean.events.map((event) => event.key)).toEqual(["evt-b"])
  })

  test("URL fields go, the rest of the listing stays", () => {
    expect("website" in clean.org).toBe(false)
    expect(clean.org.socials).toEqual([
      { platform: "instagram", url: "https://instagram.com/invented" },
    ])
    expect(clean.org.description).toBe("We meet weekly. Programme: here.")
    // Its value was read from talks.cam: the entry no longer claims "found".
    expect(clean.org.meta.website as unknown).toEqual({
      status: "missing",
      missingReason: "not_published",
    })
    expect(clean.relationships[0].evidence).toEqual([
      { sourceUrl: "https://example.org/e", seenAt: 2 },
    ])
  })

  test("a conflict left with no other reading is no conflict", () => {
    expect(clean.org.meta.name as unknown).toEqual({
      status: "found",
      confidence: 0.9,
      sourceUrl: "https://example.org/",
    })
  })

  test("a page with nothing from talks.cam comes back equal", () => {
    const plain = { org: { name: "A", socials: [{ url: "https://example.org" }] }, events: [] }
    expect(withoutTalksCam(plain)).toEqual(plain)
  })
})

describe("withoutTalksCam: values read from talks.cam (G1 hardening)", () => {
  const TALKS = "https://talks.cam.ac.uk/show/index/7"
  const page = {
    org: {
      key: "org-invented",
      slug: "invented",
      name: "Invented Society",
      description: "Invented text copied from a talks listing.",
      shortDescription: "Kept: read from the society's own site.",
      tags: ["invented-tag"],
      memberCount: 40,
      sport: { sport: "Invented sport", genderCategories: [] },
      registrations: { su: true },
      meta: {
        name: { status: "found", sourceUrl: TALKS },
        description: { status: "found", evidence: "explicit", sourceUrl: TALKS },
        shortDescription: { status: "found", sourceUrl: "https://example.org/" },
        tags: { status: "found", sourceUrl: TALKS },
        memberCount: { status: "found", sourceUrl: TALKS },
        "sport.sport": { status: "found", sourceUrl: TALKS },
        registrations: { status: "found", sourceUrl: TALKS },
      },
    },
    relationships: [
      {
        key: "rel-talks-only",
        evidence: [
          { sourceUrl: `${TALKS}/a`, seenAt: 1 },
          { sourceUrl: `${TALKS}/b`, seenAt: 2 },
        ],
      },
      { key: "rel-none", evidence: [] },
      { key: "rel-mixed", evidence: [{ sourceUrl: "https://example.org/r", seenAt: 3 }] },
    ],
  }
  const clean = withoutTalksCam(page)
  const notPublished = { status: "missing", missingReason: "not_published" }

  test("text and lists read from talks.cam go; the entry says not published", () => {
    expect(JSON.stringify(clean)).not.toContain("talks.cam")
    expect("description" in clean.org).toBe(false)
    expect(clean.org.meta.description as unknown).toEqual(notPublished)
    expect(clean.org.tags).toEqual([])
    expect(clean.org.sport as unknown).toEqual({ genderCategories: [] })
    expect(clean.org.meta["sport.sport"] as unknown).toEqual(notPublished)
  })

  test("other sources, numbers and the fields a page needs stay", () => {
    expect(clean.org.shortDescription).toBe("Kept: read from the society's own site.")
    expect(clean.org.meta.shortDescription).toEqual(page.org.meta.shortDescription)
    expect(clean.org.memberCount).toBe(40)
    expect(clean.org.name).toBe("Invented Society")
    expect(clean.org.key).toBe("org-invented")
    expect(clean.org.registrations).toEqual({ su: true })
  })

  test("a relationship resting on talks.cam alone leaves; one with no evidence stays", () => {
    expect(clean.relationships.map((rel) => rel.key)).toEqual(["rel-none", "rel-mixed"])
  })

  test("never drops the value it was given whole", () => {
    const only = withoutTalksCam({ key: "rel", evidence: [{ sourceUrl: TALKS, seenAt: 1 }] })
    expect(only).toEqual({ key: "rel", evidence: [] })
  })
})
