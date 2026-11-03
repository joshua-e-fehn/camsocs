import { describe, expect, test } from "bun:test"
import { AI_CRAWLERS } from "@/lib/crawlers"
import robots from "./robots"

/** The robots.txt rule a path falls under for one agent: the longest
 * matching prefix in the agent's own group, else the `*` group. */
function allowed(agent: string, path: string): boolean {
  const rules = [robots().rules].flat()
  const own = rules.find((rule) => [rule.userAgent].flat().includes(agent))
  const group = own ?? rules.find((rule) => [rule.userAgent].flat().includes("*"))
  if (!group) return true
  let best: { length: number; allow: boolean } = { length: -1, allow: true }
  for (const [list, allow] of [
    [group.allow, true],
    [group.disallow, false],
  ] as const) {
    for (const prefix of [list ?? []].flat()) {
      if (path.startsWith(prefix) && prefix.length >= best.length) {
        best = { length: prefix.length, allow }
      }
    }
  }
  return best.allow
}

describe("robots.txt", () => {
  test("search engines may crawl the talks pillar", () => {
    for (const path of ["/talks", "/talks/talk-05f9cb992668bbf0c8dc", "/talks.ics"]) {
      expect(allowed("Googlebot", path)).toBe(true)
    }
    expect(allowed("Googlebot", "/dashboard")).toBe(false)
  })

  test("AI crawlers may not read talks or their feeds, but may read the rest", () => {
    for (const agent of [
      "anthropic-ai",
      "CCBot",
      "PerplexityBot",
      "DuckAssistBot",
      "MistralAI-User",
      "meta-externalfetcher",
      "YouBot",
      "Ai2Bot-Dolma",
    ]) {
      expect(AI_CRAWLERS).toContain(agent)
      for (const path of [
        "/talks",
        "/talks?dept=engineering",
        "/talks/talk-05f9cb992668bbf0c8dc",
        "/talks/talk-05f9cb992668bbf0c8dc/ics",
        "/talks/departments",
        "/talks/events/evt-0",
        "/talks.ics",
      ]) {
        expect(allowed(agent, path)).toBe(false)
      }
      expect(allowed(agent, "/societies")).toBe(true)
      expect(allowed(agent, "/events")).toBe(true)
      // Their group repeats the private paths.
      expect(allowed(agent, "/dashboard")).toBe(false)
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

  test("every AI crawler but the two site-blocked ones has the talks group", () => {
    for (const agent of AI_CRAWLERS) {
      expect(allowed(agent, "/talks")).toBe(false)
      expect(allowed(agent, "/societies")).toBe(["GPTBot", "ClaudeBot"].includes(agent) === false)
    }
  })

  test("GPTBot and ClaudeBot may read nothing (G5: unchanged)", () => {
    for (const agent of ["GPTBot", "ClaudeBot"]) {
      for (const path of ["/", "/events", "/societies", "/talks"]) {
        expect(allowed(agent, path)).toBe(false)
      }
    }
  })
})
