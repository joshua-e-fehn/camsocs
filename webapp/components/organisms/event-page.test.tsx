import { describe, expect, test } from "bun:test"
import { ConvexProvider, ConvexReactClient } from "convex/react"
import { renderToString } from "react-dom/server"
import { EventPage } from "@/components/organisms/event-page"
import { crawlerTrapRel } from "@/lib/crawl-traps"
import { eventStructuredData } from "@/lib/events"
import type { EventPublic } from "@/lib/public-api"

// An invented event only.

const NOW = Date.UTC(2026, 10, 1, 12)

const EVENT = {
  key: `evt-${"e".repeat(40)}`,
  title: "Invented quiz night",
  startsAt: Date.UTC(2026, 10, 2, 19, 30),
  endsAt: Date.UTC(2026, 10, 2, 21),
  allDay: false,
  venueText: "The Invented Hall",
  organisers: [
    { key: "org-invented", slug: "invented-society", name: "Invented Society", role: "organiser" },
  ],
  speakers: [],
  visibility: "public",
  eventType: "social",
  cancelled: false,
  status: "confirmed",
  source: "ics",
  sourceUrl: "https://example.org/calendar",
  hosting: "hosts",
  talksDerived: false,
  lastSeenAt: NOW,
  confidence: 0.9,
  meta: {},
} as unknown as EventPublic

function render(event: EventPublic): string {
  const client = new ConvexReactClient("https://invented-test-1.convex.cloud")
  const html = renderToString(
    <ConvexProvider client={client}>
      <EventPage event={event} now={NOW} />
    </ConvexProvider>,
  )
  void client.close()
  return html.replaceAll("<!-- -->", "")
}

/** The visible breadcrumb's links, as (label, href) pairs. */
function visibleCrumbs(html: string): { name: string; href: string }[] {
  const nav = /<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ""
  return [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1].replaceAll("&amp;", "&"),
    name: match[2].replace(/<[^>]+>/g, "").trim(),
  }))
}

describe("the event page's breadcrumb (event-breadcrumb-mismatch)", () => {
  test("the JSON-LD BreadcrumbList is the visible trail, then the event", () => {
    const crumbs = visibleCrumbs(render(EVENT))
    // No day crumb: `/events?date=` is a robots.txt trap (bot policy 2026-11-03).
    expect(crumbs).toEqual([{ name: "Events", href: "/events" }])
    for (const crumb of crumbs) expect(crawlerTrapRel(crumb.href)).toBeUndefined()
    const graph = eventStructuredData(EVENT)?.["@graph"] as Record<string, unknown>[]
    const list = graph.find((node) => node["@type"] === "BreadcrumbList") as {
      itemListElement: { name: string; item: string }[]
    }
    expect(list.itemListElement.map((item) => item.name)).toEqual([
      ...crumbs.map((crumb) => crumb.name),
      "Invented quiz night",
    ])
    expect(list.itemListElement.map((item) => item.item)).toEqual([
      ...crumbs.map((crumb) => `https://camsocs.uk${crumb.href}`),
      `https://camsocs.uk/events/${EVENT.key}`,
    ])
  })
})

describe("the event page's correction link", () => {
  test("is a nofollow preset form naming the event (request-param-urls, event-correction-link)", () => {
    const html = render(EVENT)
    const tag = /<a [^>]*href="(\/request\?[^"]*)"[^>]*>/.exec(html)
    expect(tag?.[1].replaceAll("&amp;", "&")).toBe(
      `/request?kind=correct&org=invented-society&event=${EVENT.key}`,
    )
    expect(tag?.[0]).toMatch(/rel="nofollow"/)
  })
})

describe("the event page's society calendar link (bot policy 2026-11-03)", () => {
  test("is the society calendar's canonical, followed and crawlable", () => {
    const html = render(EVENT)
    const tags = [...html.matchAll(/<a [^>]*href="(\/events\?[^"]*)"[^>]*>/g)]
    expect(tags.length).toBeGreaterThan(0)
    for (const [tag, href] of tags) {
      expect(href.replaceAll("&amp;", "&")).toBe("/events?org=invented-society")
      expect(crawlerTrapRel(href)).toBeUndefined()
      expect(tag).not.toMatch(/rel="nofollow"/)
    }
  })

  test("is the same link once the event has ended", () => {
    const html = render({
      ...EVENT,
      startsAt: NOW - 86_400_000,
      endsAt: NOW - 82_800_000,
    } as EventPublic)
    expect(html).toContain("This event has ended.")
    const hrefs = [...html.matchAll(/<a [^>]*href="(\/events\?[^"]*)"/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThanOrEqual(2)
    for (const href of hrefs) expect(href).toBe("/events?org=invented-society")
  })
})

describe("the event page's poster (mobile-lcp-js-weight)", () => {
  test("is fetched first and never lazily: it is the likely LCP element", () => {
    const html = render({
      ...EVENT,
      imageUrl: "https://invented-test-1.convex.cloud/api/storage/poster",
    } as EventPublic)
    const img = /<img [^>]*alt="Poster for[^"]*"[^>]*>/.exec(html)?.[0] ?? ""
    expect(img).toMatch(/fetchPriority="high"/i)
    expect(img).not.toMatch(/loading="lazy"/)
  })
})
