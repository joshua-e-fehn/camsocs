import { describe, expect, test } from "bun:test"
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data"
import { robotsGroupAllows } from "@/lib/crawl-traps"
import {
  AI_CRAWLERS,
  AI_SEARCH_CRAWLERS,
  AI_TRAINING_CRAWLERS,
  AI_USER_AGENTS,
  SCRAPERS,
} from "@/lib/crawlers"
import { EMPTY_EVENTS, eventsHref, eventsIndexing, ORG_WEEKS } from "@/lib/url-state"
import robots from "./robots"

/** The robots.txt verdict for one agent and path, by Google's rules: the
 * agent's own group (named in any case), else the `*` group. */
function allowed(agent: string, path: string): boolean {
  const rules = [robots().rules].flat()
  const own = rules.find((rule) =>
    [rule.userAgent].flat().some((name) => name?.toLowerCase() === agent.toLowerCase()),
  )
  const group = own ?? rules.find((rule) => [rule.userAgent].flat().includes("*"))
  return group ? robotsGroupAllows(group, path) : true
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
/** The canonical pages the edge serves from cache: all a training crawler
 * (T3) may read, as the firewall lets it (lib/firewall-rules.ts). */
const CACHED_CANONICAL = [
  "/",
  "/about",
  "/privacy",
  "/term-dates",
  "/categories",
  "/categories/science-tech",
  "/societies/chess",
  "/events/evt-0123456789abcdef0123456789abcdef01234567",
  "/llms.txt",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemaps/events.xml",
]
/** Canonical pages rendered per request, and the other paths the firewall
 * denies a training crawler. */
const T3_DENIED = [
  "/events",
  "/events.rsc",
  eventsIndexing({ ...EMPTY_EVENTS, org: "chess", weeks: ORG_WEEKS }).canonical,
  "/societies",
  "/societies?page=2",
  "/request",
  "/sign-in",
  "/api/auth/get-session",
  "/dashboard",
  "/events.ics",
  "/events/evt-0123456789abcdef0123456789abcdef01234567/ics",
  "/events/evt-0/opengraph-image-xy7nla",
  "/societies/chess?_rsc=abc12",
  "/about?utm_source=x",
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

  test("AI agents of every tier may read the cached canonical pages, never talks", () => {
    for (const agent of [...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS, ...AI_TRAINING_CRAWLERS]) {
      for (const path of CACHED_CANONICAL) {
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

  test("AI search and user-triggered agents may read every canonical page but talks", () => {
    for (const agent of [...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS]) {
      for (const path of CANONICAL) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, true])
      }
    }
  })

  test("training crawlers: cached pages only, as the firewall enforces (step 2)", () => {
    for (const agent of AI_TRAINING_CRAWLERS) {
      for (const path of T3_DENIED) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, false])
      }
    }
    for (const agent of ["GPTBot", "ClaudeBot"]) {
      expect(AI_CRAWLERS).toContain(agent)
      for (const path of ["/", "/societies/chess", "/categories/sport", "/sitemap.xml"]) {
        expect(allowed(agent, path)).toBe(true)
      }
      for (const path of ["/events", "/societies", "/talks"]) {
        expect(allowed(agent, path)).toBe(false)
      }
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

/** robots.txt as Next serialises it, read back by a matcher written apart
 * from lib/crawl-traps.ts (RFC 9309: the agent's own group, else `*`; the
 * longest match wins, an Allow wins a tie), so a serialiser change or a bug
 * in `robotsGroupAllows` cannot pass unseen (bot policy 2026-11-03). */
describe("robots.txt as served", () => {
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[] }

  function parse(text: string): Group[] {
    const groups: Group[] = []
    let current: Group | undefined
    let lastWasAgent = false
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim()
      if (!line) continue
      const colon = line.indexOf(":")
      const key = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (key === "user-agent") {
        if (!lastWasAgent || !current) {
          current = { agents: [], rules: [] }
          groups.push(current)
        }
        current.agents.push(value.toLowerCase())
        lastWasAgent = true
        continue
      }
      lastWasAgent = false
      if (current && (key === "allow" || key === "disallow") && value) {
        current.rules.push({ allow: key === "allow", path: value })
      }
    }
    return groups
  }

  /** A backtracking match of one pattern against a whole path. */
  function matches(pattern: string, path: string): boolean {
    const anchored = pattern.endsWith("$")
    const body = anchored ? pattern.slice(0, -1) : pattern
    const walk = (i: number, j: number): boolean => {
      if (i === body.length) return anchored ? j === path.length : true
      if (body[i] === "*") {
        for (let k = j; k <= path.length; k++) if (walk(i + 1, k)) return true
        return false
      }
      return j < path.length && body[i] === path[j] && walk(i + 1, j + 1)
    }
    return walk(0, 0)
  }

  const text = resolveRobots(robots())
  const groups = parse(text)

  function served(agent: string, path: string): boolean {
    const own = groups.filter((group) => group.agents.includes(agent.toLowerCase()))
    const rules = (own.length ? own : groups.filter((group) => group.agents.includes("*"))).flatMap(
      (group) => group.rules,
    )
    let best: { length: number; allow: boolean } | undefined
    for (const rule of rules) {
      if (!matches(rule.path, path)) continue
      if (
        !best ||
        rule.path.length > best.length ||
        (rule.path.length === best.length && rule.allow)
      )
        best = { length: rule.path.length, allow: rule.allow }
    }
    return best?.allow ?? true
  }

  test("names the sitemap and one group per tier", () => {
    expect(text).toMatch(/^Sitemap: https:\/\/[^\s]+\/sitemap\.xml$/m)
    expect(groups).toHaveLength(4)
  })

  test("agrees with the policy for every agent", () => {
    const search = ["Googlebot", "Bingbot", "Applebot"]
    const check = (agent: string, path: string, want: boolean) =>
      expect([agent, path, served(agent, path)]).toEqual([agent, path, want])
    for (const agent of search) {
      for (const path of [...CANONICAL, ...TALKS_CANONICAL]) check(agent, path, true)
    }
    for (const agent of [...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS]) {
      for (const path of CANONICAL) check(agent, path, true)
    }
    for (const agent of AI_TRAINING_CRAWLERS) {
      for (const path of CACHED_CANONICAL) check(agent, path, true)
      for (const path of T3_DENIED) check(agent, path, false)
    }
    for (const agent of AI_CRAWLERS) {
      for (const path of [...TALKS_CANONICAL, "/talks.ics"]) check(agent, path, false)
    }
    for (const agent of [...search, ...AI_CRAWLERS, ...SCRAPERS]) {
      for (const path of [...TRAPS, ...TALKS_TRAPS]) check(agent, path, false)
    }
    for (const agent of SCRAPERS) {
      for (const path of ["/", "/societies", "/llms.txt", "/talks"]) check(agent, path, false)
    }
  })

  test("the in-repo matcher reads the served text the same way", () => {
    const paths = [...CANONICAL, ...CACHED_CANONICAL, ...T3_DENIED, ...TRAPS, ...TALKS_CANONICAL]
    for (const agent of ["Googlebot", "GPTBot", "OAI-SearchBot", "AhrefsBot"]) {
      for (const path of paths) {
        expect([agent, path, allowed(agent, path)]).toEqual([agent, path, served(agent, path)])
      }
    }
  })
})
