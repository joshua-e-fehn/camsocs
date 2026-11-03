import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { HubList } from "@/components/molecules/hub-list"
import { ListingLinkSnippet } from "@/components/molecules/listing-link-snippet"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { UnknownFacts } from "@/components/molecules/unknown-facts"
import { DirectoryHub } from "@/components/organisms/directory-hub"
import { OrgProfile } from "@/components/organisms/org-profile"
import { alternateNames, profileLead, profileSources } from "@/lib/directory-profile"
import { withoutTalksCam } from "@/lib/directory-talks-guard"
import type { OrgPage } from "@/lib/public-api"

// Synthetic listings and events only: no real talk, list or speaker.

const NOW = Date.UTC(2026, 10, 1, 12)
const SOON = NOW + 3 * 86_400_000

function page(): OrgPage {
  return {
    org: {
      key: "org-chess-club",
      slug: "chess-club",
      name: "Chess Club",
      aliases: ["Chess Club", "Cambridge University Chess Club"],
      orgType: "society",
      level: "university",
      collegeKeys: [],
      isCounterpart: false,
      status: "active",
      registrations: {},
      categories: ["hobbies_games"],
      activityTypes: [],
      audiences: [],
      languages: [],
      tags: [],
      description: "We play every week. Talks: [list](https://talks.cam.ac.uk/show/index/1).",
      website: "https://chess.example.org/",
      roleEmails: [],
      socials: [
        { platform: "instagram", url: "https://instagram.com/invented" },
        { platform: "website_blog", url: "https://talks.cam.ac.uk/show/index/1" },
      ],
      chatChannels: [],
      missingFields: [],
      logo: { url: "https://example.convex.cloud/api/storage/logo" },
      meta: {
        name: { status: "found", sourceUrl: "https://www.cambridgesu.co.uk/organisation/1/" },
        description: {
          status: "found",
          sourceType: "su_profile",
          sourceUrl: "https://www.cambridgesu.co.uk/organisation/1/",
          retrievedAt: NOW,
        },
        website: { status: "found", sourceUrl: "https://talks.cam.ac.uk/show/index/1" },
        howToJoin: { status: "missing", missingReason: "not_found" },
        joinUrl: { status: "missing", missingReason: "not_attempted" },
        membership: { status: "missing", missingReason: "not_found" },
      },
      updatedAt: NOW,
    },
    teams: [],
    sessions: [],
    events: [
      {
        key: "evt-1111111111111111111111111111111111111111",
        title: "Invented seminar from talks",
        startsAt: SOON,
        allDay: false,
        organisers: [],
        visibility: "public",
        eventType: "talk",
        cancelled: false,
        status: "confirmed",
        source: "talks_cam",
        sourceUrl: "https://talks.cam.ac.uk/talk/index/1",
        hosting: "hosts",
      },
      {
        key: "evt-2222222222222222222222222222222222222222",
        title: "Invented blitz night",
        startsAt: SOON,
        allDay: false,
        organisers: [],
        visibility: "public",
        eventType: "social",
        cancelled: false,
        status: "confirmed",
        source: "ics",
        sourceUrl: "https://chess.example.org/cal.ics",
        hosting: "hosts",
      },
    ],
    relationships: [],
    hasPublicEvents: true,
  } as unknown as OrgPage
}

function renderProfile(raw: OrgPage) {
  const clean = withoutTalksCam(raw)
  const { lead } = profileLead({
    org: clean.org,
    collegeNames: {},
    sessions: clean.sessions,
    upcomingEvents: clean.events.length,
  })
  return renderToString(
    <OrgProfile
      page={clean}
      collegeNames={{}}
      hiddenEvents={null}
      related={[]}
      lead={lead}
      alternate={alternateNames(clean.org)}
      sources={profileSources(clean.org.meta)}
    />,
  )
}

/** Every link to a preset request form (`/request?…`) and whether it is
 * nofollow (SEO audit 2026-11-02, request-param-urls). */
function presetRequestLinks(html: string): { href: string; nofollow: boolean }[] {
  return [...html.matchAll(/<a [^>]*href="(\/request\?[^"]*)"[^>]*>/g)].map(([tag, href]) => ({
    href: href.replaceAll("&amp;", "&"),
    nofollow: /rel="[^"]*nofollow/.test(tag),
  }))
}

describe("a society profile's server HTML", () => {
  const html = renderProfile(page())

  test("carries nothing from talks.cam (owner decision G1)", () => {
    expect(html).not.toContain("talks.cam")
    expect(html).not.toContain("Invented seminar from talks")
    expect(html).toContain("Invented blitz night")
  })

  test("leads with facts, says where the About text is from, lists its sources", () => {
    expect(html).toContain(
      "Cambridge University Chess Club is a university-wide society in Cambridge",
    )
    expect(html).toContain("In their words, from")
    expect(html).toContain("Cambridge SU profile")
    expect(html).toContain('href="https://www.cambridgesu.co.uk/organisation/1/"')
    expect(html).toMatch(/<time[^>]*dateTime="2026-11-01T12:00:00.000Z"/i)
  })

  test("names itself once: no alias equal to the name (entity-aliases-missing)", () => {
    expect(html).toContain("Also known as <!-- -->Cambridge University Chess Club")
    expect(html).not.toMatch(/Also known as[^<]*Chess Club, /)
  })

  test("links its category hub, not a filtered directory view (G13)", () => {
    expect(html).toContain('href="/categories/hobbies-games"')
    expect(html).not.toContain("/societies?cat=")
  })

  test("its logo has a name (image-alt-text)", () => {
    expect(html).toContain('alt="Chess Club logo"')
  })

  test("its preset request links, /request under its canonical, are nofollow (request-param-urls)", () => {
    const archived = page()
    archived.org.status = "archived"
    archived.org.meta.joinUrl = { status: "missing", missingReason: "not_found" }
    const links = presetRequestLinks(renderProfile(archived))
    expect(links.map((link) => link.href)).toEqual(
      expect.arrayContaining([
        "/request?kind=claim&org=chess-club",
        "/request?kind=correct&org=chess-club",
        "/request?kind=remove&org=chess-club",
      ]),
    )
    // The "defunct" alert's "tell us" and the unknown facts' "Tell us" too.
    expect(
      links.filter((link) => link.href === "/request?kind=correct&org=chess-club").length,
    ).toBeGreaterThanOrEqual(3)
    for (const link of links) expect(link).toEqual({ href: link.href, nofollow: true })
  })

  test("offers the society a link to its listing (backlink-loop)", () => {
    expect(html).toContain("Link to this listing from your site")
    expect(html).toContain("https://camsocs.uk/societies/chess-club")
  })
})

describe("molecules", () => {
  test("a list tile's logo stays decorative", () => {
    const html = renderToString(
      <OrgMonogram name="Chess Club" url="https://example.org/logo.png" size={40} />,
    )
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('alt=""')
  })

  test("unknown facts are grouped by reason, names only, and kept out of snippets", () => {
    const html = renderToString(
      <UnknownFacts
        correctHref="/request"
        facts={[
          { label: "Join link", meta: { status: "missing", missingReason: "not_found" } },
          { label: "Membership", meta: { status: "missing", missingReason: "not_found" } },
          { label: "Termcard", meta: { status: "missing", missingReason: "not_attempted" } },
        ]}
      />,
    )
    expect(html).toContain("data-nosnippet")
    const text = html.replace(/<[^>]*>/g, "")
    expect(text.match(/We looked, and no source we use publishes this\./g)).toHaveLength(1)
    expect(html).toContain("Join link, Membership")
    // The bare form is the canonical one: followed.
    expect(html).not.toContain("nofollow")
    const preset = renderToString(
      <UnknownFacts
        correctHref="/request?kind=correct&org=chess-club"
        facts={[{ label: "Join link", meta: { status: "missing", missingReason: "not_found" } }]}
      />,
    )
    expect(presetRequestLinks(preset)).toEqual([
      { href: "/request?kind=correct&org=chess-club", nofollow: true },
    ])
  })

  test("the listing link snippet is plain HTML to our page", () => {
    const html = renderToString(<ListingLinkSnippet slug="chess-club" />)
    expect(html).toContain(
      "&lt;a href=&quot;https://camsocs.uk/societies/chess-club&quot;&gt;Find us on camsocs&lt;/a&gt;",
    )
  })

  test("a hub lists every member as a link, with one H1", () => {
    const cards = [
      {
        key: "org-a",
        slug: "a",
        name: "Alpha Boat Club",
        orgType: "college_boat_club" as const,
        collegeKeys: ["org-x"],
        categories: ["sport" as const],
      },
    ]
    const html = renderToString(
      <DirectoryHub
        eyebrow="College"
        title="Societies and clubs at Example College, Cambridge"
        intro="Intro."
        crumbs={[{ name: "Societies", href: "/societies" }, { name: "Example College" }]}
        sections={[{ id: "sport", title: "Sport & Fitness", cards }]}
        collegeNames={{ "org-x": "Example College" }}
        missingHref="/request?kind=add"
        missingText="Missing a society at Example College?"
      />,
    )
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(presetRequestLinks(html)).toEqual([{ href: "/request?kind=add", nofollow: true }])
    expect(html).toContain('href="/societies/a"')
    expect(html).toContain("Example College · College boat club")
    expect(renderToString(<HubList cards={cards} collegeNames={{}} />)).toContain("Alpha Boat Club")
  })
})
