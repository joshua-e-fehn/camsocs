import { describe, expect, test } from "bun:test"
import { crawlerTrapRel, dynamicPrefetch, linkProps, robotsPatternMatches } from "./crawl-traps"
import { EMPTY_DIRECTORY, EMPTY_EVENTS, eventsHref, serializeDirectoryState } from "./url-state"

/** The links robots.txt disallows get rel=nofollow; canonical views do not
 * (bot policy 2026-11-03). */

describe("robotsPatternMatches", () => {
  test("reads Google's syntax: a prefix, `*` any run, `$` the end", () => {
    expect(robotsPatternMatches("/events?", "/events?date=2026-11-03")).toBe(true)
    expect(robotsPatternMatches("/events?", "/events")).toBe(false)
    expect(robotsPatternMatches("/events?org=*&", "/events?org=chess&weeks=8")).toBe(true)
    expect(robotsPatternMatches("/events?org=*&", "/events?org=chess")).toBe(false)
    expect(robotsPatternMatches("/events/*/ics", "/events/evt-0/ics")).toBe(true)
    expect(robotsPatternMatches("/a.b$", "/a.b")).toBe(true)
    expect(robotsPatternMatches("/a.b$", "/a.bc")).toBe(false)
    expect(robotsPatternMatches("/a.b", "/axb")).toBe(false)
  })
})

describe("crawlerTrapRel", () => {
  test("nofollow on calendar slices: days, weeks, views, presets, filters", () => {
    for (const href of [
      eventsHref({ ...EMPTY_EVENTS, date: "2026-11-03" }),
      eventsHref({ ...EMPTY_EVENTS, weeks: 2 }),
      eventsHref({ ...EMPTY_EVENTS, view: "month", date: "2026-12-01" }),
      eventsHref({ ...EMPTY_EVENTS, preset: "weekend" }),
      eventsHref({ ...EMPTY_EVENTS, university: "only" }),
      eventsHref({ ...EMPTY_EVENTS, university: "only", weeks: 4 }),
      eventsHref({ ...EMPTY_EVENTS, org: "chess", weeks: 8 }),
      eventsHref({ ...EMPTY_EVENTS, org: "chess", date: "2026-11-10" }),
      "/talks?from=2026-11-03",
      "/talks?talk=talk-05f9cb992668bbf0c8dc",
      "/talks/departments?view=az",
      `/societies${serializeDirectoryState({ ...EMPTY_DIRECTORY, q: "jazz" })}`,
      "/societies?beginner=yes",
      "/societies?level=university",
      "/request?kind=add",
      "/sign-in?cam=1&next=%2Fevents",
    ]) {
      expect([href, crawlerTrapRel(href)]).toEqual([href, "nofollow"])
    }
  })

  test("followed: canonical pages and canonical parameter views", () => {
    for (const href of [
      "/",
      "/events",
      eventsHref({ ...EMPTY_EVENTS, org: "chess", weeks: 4 }),
      "/events/evt-0123456789abcdef0123456789abcdef01234567",
      "/societies",
      `/societies${serializeDirectoryState({ ...EMPTY_DIRECTORY, page: 3 })}`,
      "/societies/chess",
      "/categories/sport",
      "/talks",
      "/talks?dept=engineering",
      "/talks?school=technology",
      "/talks/departments",
      "/request",
      "https://example.org/?q=1",
      "#section",
    ]) {
      expect([href, crawlerTrapRel(href)]).toEqual([href, undefined])
    }
  })

  test("linkProps carries the href, rel when nofollow, and no prefetch of a dynamic page", () => {
    expect(linkProps("/events")).toEqual({ href: "/events", prefetch: false })
    expect(linkProps("/events?weeks=2")).toEqual({
      href: "/events?weeks=2",
      rel: "nofollow",
      prefetch: false,
    })
    expect(linkProps("/events/evt-0")).toEqual({ href: "/events/evt-0" })
    expect(linkProps("/about")).toEqual({ href: "/about" })
    expect(linkProps("/sign-in?cam=1")).toEqual({ href: "/sign-in?cam=1", rel: "nofollow" })
  })

  test("dynamicPrefetch: off for the per-request pages and their views only", () => {
    for (const href of ["/events", "/events?org=chess", "/societies?page=2", "/talks#x"]) {
      expect(dynamicPrefetch(href)).toBe(false)
    }
    for (const href of ["/talks/departments", "/request?kind=add"]) {
      expect(dynamicPrefetch(href)).toBe(false)
    }
    for (const href of ["/", "/societies/chess", "/talks/talk-0", "/categories", "https://x.org"]) {
      expect(dynamicPrefetch(href)).toBeUndefined()
    }
  })
})
