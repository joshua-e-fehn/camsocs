import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { HomeOverview, type OverviewSlice } from "@/components/organisms/home-overview"
import { OrgProfile } from "@/components/organisms/org-profile"
import { api, internal } from "@/convex/_generated/api"
import { newTest } from "@/convex/lib/harness.testing"
import { eventStructuredData } from "@/lib/events"
import { eventKey } from "@/lib/keys"

/**
 * The talks boundary (owner decision G1, lib/talks-boundary.ts), end to end:
 * no talks.cam-derived text reaches the server render (HTML or RSC props) of
 * a URL outside /talks. A regression here republishes talks.cam's listings
 * to the AI agents its robots.txt — and ours, for /talks — keep out.
 *
 *  - No server module outside the /talks routes (app/, components/, lib/)
 *    reads a talk's text (`talks.list`, `talks.get`, `talks.search`) or asks
 *    for talks.cam-derived events (`talksCam` other than "exclude"). Client
 *    components and hooks may: they read after hydration, which no crawler's
 *    HTML holds.
 *  - A society profile, rendered on the server from `orgs.getBySlug`, lists
 *    none of them — however the event is talks-derived, including by fields a
 *    list item does not carry — and links no talks.cam page.
 *  - The home page's overview renders no talk rows on the server, even if
 *    handed some.
 *  - None gets JSON-LD.
 * All data here is invented.
 */

const WEBAPP = path.join(import.meta.dir, "..")

/** Route folders that serve the /talks prefix (page groups and handlers). */
const TALKS_ROUTES = [
  path.join("app", "(site)", "talks"),
  path.join("app", "talks"),
  path.join("app", "talks.ics"),
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(WEBAPP, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(relative))
    else if (/\.tsx?$/.test(entry.name) && !/\.test(ing)?\.tsx?$/.test(entry.name)) {
      out.push(relative)
    }
  }
  return out
}

/** Server modules: no "use client" directive at the top. */
function isServerModule(source: string): boolean {
  return !/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source)
}

/** The code of a module without its comments (which may name the query). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** A call (not a type: `typeof api.talks.list` reads nothing). */
const READS_TALK_TEXT = /(?<!typeof\s+)api\.talks\.(?:list|get|search)\b/
/** Any `talksCam` but the default's own value. */
const ASKS_FOR_TALKS_EVENTS = /\btalksCam\b(?!\s*:\s*["']exclude["'])/

describe("server modules outside /talks", () => {
  const files = [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")].filter(
    (file) => !TALKS_ROUTES.some((dir) => file.startsWith(`${dir}${path.sep}`)),
  )

  test("the scan sees the pages and helpers it guards", () => {
    expect(files).toContain(path.join("app", "(site)", "page.tsx"))
    expect(files).toContain(path.join("app", "(site)", "events", "page.tsx"))
    expect(files).toContain(path.join("app", "(site)", "events", "[key]", "page.tsx"))
    expect(files).toContain(path.join("lib", "public-data.ts"))
    expect(files).toContain(path.join("lib", "event-page.ts"))
  })

  test("the patterns catch what they guard against, and nothing else", () => {
    expect(READS_TALK_TEXT.test("fetchQuery(api.talks.list, {})")).toBe(true)
    expect(READS_TALK_TEXT.test("FunctionArgs<typeof api.talks.list>")).toBe(false)
    expect(ASKS_FOR_TALKS_EVENTS.test('{ talksCam: "only" }')).toBe(true)
    expect(ASKS_FOR_TALKS_EVENTS.test("{ ...args, talksCam }")).toBe(true)
    expect(ASKS_FOR_TALKS_EVENTS.test('{ talksCam: "exclude" }')).toBe(false)
  })

  for (const file of files) {
    const source = readFileSync(path.join(WEBAPP, file), "utf8")
    if (!isServerModule(source)) continue
    test(`${file} reads no talk text and no talks.cam-derived events`, () => {
      expect(code(source)).not.toMatch(READS_TALK_TEXT)
      expect(code(source)).not.toMatch(ASKS_FOR_TALKS_EVENTS)
    })
  }
})

describe("server renders", () => {
  test("a society profile lists none of its talks.cam-derived events", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-astro", "name", "Invented Astronomy Society", "organisation"),
        claim("org-astro", "level", "university", "organisation"),
      ],
    })
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        claim("org-optics", "name", "Invented Optics Society", "organisation"),
        claim("org-optics", "level", "university", "organisation"),
      ],
    })
    const keys = {
      plain: eventKey("ics", "plain"),
      series: eventKey("talks_cam", "series"),
      linked: eventKey("ics", "linked"),
      // Talks-derived only by fields a list item does not carry.
      described: eventKey("ics", "described"),
      booked: eventKey("ics", "booked"),
    }
    const event = (
      key: string,
      title: string,
      days: number,
      source: string,
      url: string,
      extra: Record<string, unknown> = {},
    ) =>
      Object.entries({
        title,
        startsAt: NOW + days * DAY,
        visibility: "public",
        externalId: title,
        source,
        sourceUrl: url,
        ...extra,
      }).map(([field, value]) => claim(key, field, value))
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ...event(keys.plain, "Invented star party", 1, "ics", "https://example.org/a.ics"),
        ...event(keys.series, "Invented comet seminar", 2, "talks_cam", TALKS_URL),
        ...event(keys.linked, "Invented moon lecture", 3, "ics", TALKS_URL),
        ...event(keys.described, "Invented quasar colloquium", 4, "ics", "https://example.org/q", {
          description: `Details at ${TALKS_URL}`,
        }),
        ...event(keys.booked, "Invented pulsar evening", 5, "ics", "https://example.org/p", {
          bookingUrl: TALKS_URL,
        }),
      ],
    })
    // Every event is the society's; the talks.cam series is co-hosted, so
    // its connection's only evidence would be a talks.cam page: the
    // connection rests on talks.cam alone and is left out.
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: Object.values(keys).map((key) => ({
        eventKey: key,
        organisers: [
          { orgKey: "org-astro", role: "organiser" as const },
          ...(key === keys.series ? [{ orgKey: "org-optics", role: "co_host" as const }] : []),
        ],
      })),
    })
    const page = await t.query(api.orgs.getBySlug, { slug: "astro" })
    if (!page) throw new Error("no page")
    expect(page.relationships).toEqual([])

    const html = renderToString(
      <OrgProfile page={page} collegeNames={{}} hiddenEvents={null} related={[]} />,
    )
    expect(html).toContain("Invented star party")
    expect(html).toContain(`href="/events/${keys.plain}"`)
    for (const text of [
      "Invented comet seminar",
      "Invented moon lecture",
      "Invented quasar colloquium",
      "Invented pulsar evening",
      "Invented Optics Society",
      "talks.cam.ac.uk",
      keys.series,
      keys.described,
    ]) {
      expect(html).not.toContain(text)
    }
    // Nor anywhere in what the page's server component would serialise.
    expect(JSON.stringify(page)).not.toContain("talks.cam.ac.uk")
  })

  test("the home overview renders talk counts, never talk rows", () => {
    const slice: OverviewSlice = {
      heading: "Today",
      summary: "1 event · 3 talks · 1 society hosting",
      events: { items: [], total: 0, href: "/events" },
      // The server never passes rows; were one passed, it must still not render.
      talks: {
        items: [
          { key: "t1", href: "/talks?talk=t1", time: "16:00", title: "Invented quasar seminar" },
        ],
        total: 3,
        href: "/talks",
      },
      societies: { items: [], total: 0, href: "/societies" },
    }
    // A client that never connects: the server render must not query at all.
    const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
    const html = renderToString(
      <ConvexProvider client={client}>
        <HomeOverview
          todayIso="2026-11-02"
          now={NOW}
          today={slice}
          week={slice}
          days={[]}
          weekRange="Mon 2 – Sun 8 Nov"
        />
      </ConvexProvider>,
    )
    void client.close()
    expect(html).toContain("3 talks")
    expect(html).not.toContain("/talks?talk=")
    expect(html).not.toContain("Invented quasar seminar")
  })

  test("a talks.cam-derived event never gets JSON-LD", () => {
    const base = {
      key: eventKey("ics", "x"),
      source: "ics",
      title: "Invented seminar",
      startsAt: NOW,
      allDay: false,
      cancelled: false,
      hosting: "hosts",
      eventType: "talk" as const,
      organisers: [],
      visibility: "public",
      status: "confirmed",
    }
    // Convex's verdict (`talksDerived`) decides, never a re-run on a projection.
    expect(eventStructuredData({ ...base, talksDerived: false })).not.toBeNull()
    expect(eventStructuredData({ ...base, talksDerived: true })).toBeNull()
  })
})

const NOW = Date.now()
const DAY = 86_400_000
const TALKS_URL = "https://talks.cam.ac.uk/talk/index/1"

function claim(entityKey: string, field: string, value: unknown, entityType = "event") {
  return {
    entityType: entityType as "event" | "organisation",
    entityKey,
    field,
    value,
    evidence: "primary" as const,
    method: "parser" as const,
    extractor: "test",
    sourceKey: "src-test",
    sourceUrl: "https://example.org/",
    sourceType: "society_website" as const,
    retrievedAt: NOW - 60_000,
  }
}
