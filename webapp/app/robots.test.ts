import { describe, expect, test } from "bun:test"
import {
  AI_CRAWLERS,
  AI_SEARCH_CRAWLERS,
  AI_TRAINING_CRAWLERS,
  AI_USER_AGENTS,
  SCRAPERS,
} from "@/lib/crawlers"
import { EMPTY_EVENTS, eventsHref, eventsIndexing, ORG_WEEKS } from "@/lib/url-state"
import robots from "./robots"

/** Whether a robots.txt path pattern matches a URL path (with its query), as
 * Google reads one: a prefix, where `*` is any run of characters and a final
 * `$` anchors the end. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$")
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path)
}

/** The robots.txt verdict for one agent and path, by Google's rules: the
 * agent's own group, else the `*` group; the longest matching pattern wins,
 * and an Allow wins a tie (the least restrictive rule). */
function allowed(agent: string, path: string): boolean {
  const rules = [robots().rules].flat()
  const own = rules.find((rule) =>
    [rule.userAgent].flat().some((name) => name?.toLowerCase() === agent.toLowerCase()),
  )
  const group = own ?? rules.find((rule) => [rule.userAgent].flat().includes("*"))
  if (!group) return true
  let best: { length: number; allow: boolean } = { length: -1, allow: true }
  for (const [list, allow] of [
    [group.disallow, false],
    [group.allow, true],
  ] as const) {
    for (const pattern of [list ?? []].flat()) {
      if (matches(pattern, path) && pattern.length >= best.length) {
        best = { length: pattern.length, allow }
      }
    }
  }
  return best.allow
}

/** URLs whose page is canonical and indexable: every one must stay
 * crawlable by search engines and AI agents alike (talks aside for AI). */
const CANONICAL = [
  "/",
  "/about",
  "/privacy",
  "/term-dates",
  "/categories",
  "/categories/science-tech",
  "/societies",
  "/societies?page=2",
  "/societies/chess",
  "/events",
  eventsIndexing({ ...EMPTY_EVENTS, org: "chess", weeks: ORG_WEEKS }).canonical,
  "/events/evt-0123456789abcdef0123456789abcdef01234567",
  "/request",
  "/llms.txt",
]
const TALKS_CANONICAL = [
  "/talks",
  "/talks?dept=engineering",
  "/talks?school=technology",
  "/talks/departments",
  "/talks/talk-05f9cb992668bbf0c8dc",
  "/talks/events/evt-0",
]

/** Parameter views that are crawler traps (bot policy 2026-11-03). */
const TRAPS = [
  "/events?date=2026-11-03",
  "/events?view=week&date=2026-11-03",
  "/events?weeks=2",
  "/events?preset=weekend",
  "/events?university=only",
  "/events?cat=music",
  "/events?event=evt-0123456789abcdef0123456789abcdef01234567",
  "/events?_rsc=abc12",
  "/events?org=chess&weeks=8",
  "/events?org=chess&university=hide",
  "/events?org=chess&event=evt-0123456789abcdef0123456789abcdef01234567",
  "/events?date=2026-11-03&org=chess",
  "/events/evt-0123456789abcdef0123456789abcdef01234567/ics",
  "/societies?cat=music",
  "/societies?q=chess",
  "/societies?sort=newest&page=2",
  "/societies?page=2&x=1",
  "/request?kind=claim&org=chess",
]
const TALKS_TRAPS = [
  "/talks?from=2026-11-03",
  "/talks?school=technology&dept=engineering",
  "/talks?dept=engineering&kind=seminar",
  "/talks?q=quantum",
  "/talks/departments?view=az",
]

describe("robots.txt", () => {
  test("the org calendar's canonical is /events?org=<slug> alone", () => {
    expect(eventsHref({ ...EMPTY_EVENTS, org: "chess", weeks: ORG_WEEKS })).toBe(
      "/events?org=chess",
    )
  })

  test("search engines may crawl every canonical page, the talks pillar included", () => {
    for (const agent of ["Googlebot", "Bingbot", "Applebot"]) {
      for (const path of [...CANONICAL, ...TALKS_CANONICAL, "/talks.ics"]) {
        expect([path, allowed(agent, path)]).toEqual([path, true])
      }
    }
    expect(allowed("Googlebot", "/dashboard")).toBe(false)
  })

  test("nobody may follow the parameter traps", () => {
    for (const agent of ["Googlebot", "Bingbot", "GPTBot", "OAI-SearchBot", "Claude-User"]) {
      for (const path of [...TRAPS, ...TALKS_TRAPS]) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, false])
      }
    }
  })

  test("an RSC fetch of a cached page is not a trap", () => {
    expect(allowed("Googlebot", "/societies/chess?_rsc=abc12")).toBe(true)
    expect(allowed("GPTBot", "/events/evt-0123456789abcdef0123456789abcdef01234567")).toBe(true)
  })

  test("AI agents of every tier may read the canonical public pages, never talks", () => {
    for (const agent of [...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS, ...AI_TRAINING_CRAWLERS]) {
      for (const path of CANONICAL) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, true])
      }
      for (const path of [
        ...TALKS_CANONICAL,
        "/talks/talk-05f9cb992668bbf0c8dc/ics",
        "/talks.ics",
      ]) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, false])
      }
      // Their group repeats the private paths.
      expect(allowed(agent, "/dashboard")).toBe(false)
    }
  })

  test("GPTBot and ClaudeBot left the site-wide block (step 2)", () => {
    for (const agent of ["GPTBot", "ClaudeBot"]) {
      expect(AI_CRAWLERS).toContain(agent)
      for (const path of ["/", "/events", "/societies", "/societies/chess"]) {
        expect(allowed(agent, path)).toBe(true)
      }
      expect(allowed(agent, "/talks")).toBe(false)
    }
  })

  test("SEO tools and commercial scrapers may read nothing", () => {
    for (const agent of SCRAPERS) {
      for (const path of ["/", "/societies", "/events", "/llms.txt", "/talks"]) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, false])
      }
    }
  })

  test("no crawler may fetch the analytics relay", () => {
    for (const agent of ["Googlebot", "Bingbot", "anthropic-ai", "CCBot", "GPTBot"]) {
      for (const path of ["/relay", "/relay/e/", "/relay/static/array.js", "/relay/array/x"]) {
        expect(allowed(agent, path)).toBe(false)
      }
    }
    // The prefix is the relay alone, not every path that starts with it.
    expect(allowed("Googlebot", "/societies")).toBe(true)
  })

  test("every agent is in exactly one group, and the sitemap is named", () => {
    const named = [robots().rules]
      .flat()
      .flatMap((rule) => [rule.userAgent].flat())
      .filter((agent): agent is string => agent !== undefined && agent !== "*")
      .map((agent) => agent.toLowerCase())
    expect(new Set(named).size).toBe(named.length)
    expect(named).toHaveLength(AI_CRAWLERS.length + SCRAPERS.length)
    expect(robots().sitemap).toMatch(/\/sitemap\.xml$/)
  })
})
