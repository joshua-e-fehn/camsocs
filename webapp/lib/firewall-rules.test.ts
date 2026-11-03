import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import robots from "@/app/robots"
import { robotsGroupAllows, TRAINING_DISALLOWS } from "./crawl-traps"
import { AI_CRAWLERS, AI_TRAINING_CRAWLERS, SCRAPERS } from "./crawlers"
import {
  type Condition,
  caseless,
  FIREWALL_FILES,
  firewallFileText,
  PROBE_PATHS,
  type RuleBody,
  TRAINING_RULE_ID,
  UNCACHED_PATHS,
  userAgentPatterns,
} from "./firewall-rules"

/** The reviewed Vercel firewall bodies of ops/vercel/ (bot policy
 * 2026-11-03): built from the crawler tiers, inside the API's limits, and
 * matching what they say they match. */

const DIR = path.join(import.meta.dir, "..", "..", "ops", "vercel")

const UAS = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  facebookPreview: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
}

/** The rule's verdict on a request, reading each condition as the WAF does
 * (unanchored regexes, as JavaScript reads them). */
function matchesRule(
  rule: RuleBody,
  request: { path: string; query?: string; userAgent: string },
): boolean {
  const holds = (condition: Condition): boolean => {
    const subject =
      condition.type === "path"
        ? request.path
        : condition.type === "raw_path"
          ? `${request.path}${request.query ? `?${request.query}` : ""}`
          : condition.type === "user_agent"
            ? request.userAgent
            : undefined
    if (condition.type === "query") {
      const params = new URLSearchParams(request.query ?? "")
      return condition.op === "ex" && condition.key !== undefined && params.has(condition.key)
    }
    if (subject === undefined) throw new Error(`untested condition type ${condition.type}`)
    const value = condition.value ?? ""
    switch (condition.op) {
      case "eq":
        return subject === value
      case "neq":
        return subject !== value
      case "pre":
        return subject.startsWith(value)
      case "re":
        return new RegExp(value).test(subject)
      default:
        throw new Error(`untested op ${condition.op}`)
    }
  }
  return rule.value.conditionGroup.some((group) => group.conditions.every(holds))
}

function rule(file: string): RuleBody {
  return JSON.parse(readFileSync(path.join(DIR, file), "utf8"))
}

/** A token as an agent might send it: inside a user agent, its case flipped. */
function shouted(token: string): string {
  return `Mozilla/5.0 (compatible; ${[...token].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("")}/1.0)`
}

describe("ops/vercel/", () => {
  test("each file is what lib/firewall-rules.ts builds (bun run firewall:rules)", () => {
    for (const { file, body } of FIREWALL_FILES) {
      expect([file, readFileSync(path.join(DIR, file), "utf8")]).toEqual([
        file,
        firewallFileText(body()),
      ])
    }
    expect(
      readdirSync(DIR)
        .filter((name) => name.endsWith(".json"))
        .sort(),
    ).toEqual(FIREWALL_FILES.map(({ file }) => file).sort())
  })

  test("every rule fits the API: at most 25 groups of 65 conditions, short texts", () => {
    for (const { file, body } of FIREWALL_FILES) {
      const value = body().value
      if (!("conditionGroup" in value)) continue
      // The PATCH schema's maxLength (openapi.vercel.sh, rules.insert/update).
      expect([file, value.description.length <= 256]).toEqual([file, true])
      expect([file, value.name.length <= 160]).toEqual([file, true])
      expect([file, value.conditionGroup.length <= 25]).toEqual([file, true])
      for (const group of value.conditionGroup)
        expect(group.conditions.length).toBeLessThanOrEqual(65)
      expect(value.conditionGroup.length).toBeGreaterThan(0)
    }
  })

  test("caseless patterns match a token in any case and nothing else", () => {
    expect(caseless("GPTBot")).toBe("[Gg][Pp][Tt][Bb][Oo][Tt]")
    expect(caseless("Dataprovider.com")).toContain("\\.")
    const [pattern, ...more] = userAgentPatterns(["GPTBot", "Dataprovider.com"])
    expect(more).toEqual([])
    expect(new RegExp(pattern).test("x gPtBoT/1.1")).toBe(true)
    expect(new RegExp(pattern).test("dataproviderXcom")).toBe(false)
  })
})

describe("control-files-bypass.json (T0)", () => {
  test("lets /robots.txt and /llms.txt through for everyone", () => {
    const bypass = rule("control-files-bypass.json")
    expect(bypass.value.action.mitigate.action).toBe("bypass")
    for (const path of ["/robots.txt", "/llms.txt"]) {
      expect(matchesRule(bypass, { path, userAgent: shouted("AhrefsBot") })).toBe(true)
    }
    expect(matchesRule(bypass, { path: "/", userAgent: UAS.chrome })).toBe(false)
  })
})

describe("talks-ai-deny.json (G1)", () => {
  const talks = rule("talks-ai-deny.json")

  test("denies every AI agent, in any case, under /talks only", () => {
    expect(talks.value.action.mitigate.action).toBe("deny")
    for (const token of AI_CRAWLERS) {
      for (const path of ["/talks", "/talks.ics", "/talks/departments", "/talks/talk-0/ics"]) {
        expect([token, path, matchesRule(talks, { path, userAgent: shouted(token) })]).toEqual([
          token,
          path,
          true,
        ])
      }
      expect(matchesRule(talks, { path: "/events", userAgent: shouted(token) })).toBe(false)
    }
  })

  test("never browsers or search crawlers", () => {
    for (const userAgent of Object.values(UAS)) {
      expect(matchesRule(talks, { path: "/talks", userAgent })).toBe(false)
    }
  })
})

describe("probes-and-scrapers-deny.json (T4, T5)", () => {
  const probes = rule("probes-and-scrapers-deny.json")

  test("denies other software's paths, for anyone", () => {
    for (const path of [
      "/.env",
      "/.env.local",
      "/.git/config",
      "/wp-login.php",
      "/wp-admin/",
      "/wordpress/",
      "/xmlrpc.php",
      "/phpmyadmin/",
      "/.aws/credentials",
      "/.DS_Store",
      "/index.php",
      "/old/admin.php",
    ]) {
      expect([path, matchesRule(probes, { path, userAgent: UAS.chrome })]).toEqual([path, true])
    }
  })

  test("never a page of the site", () => {
    expect(new RegExp(PROBE_PATHS).test("/events")).toBe(false)
    for (const path of [
      "/",
      "/events",
      "/events.ics",
      "/societies/chess",
      "/talks/departments",
      "/request",
      "/api/auth/get-session",
      "/relay/e/",
      "/robots.txt",
      "/llms.txt",
      "/sitemap.xml",
      "/sitemaps/events.xml",
      "/manifest.webmanifest",
      "/.well-known/security.txt",
    ]) {
      expect([path, matchesRule(probes, { path, userAgent: UAS.chrome })]).toEqual([path, false])
    }
  })

  test("denies every scraper in any case, and no other agent", () => {
    for (const token of SCRAPERS) {
      expect([token, matchesRule(probes, { path: "/", userAgent: shouted(token) })]).toEqual([
        token,
        true,
      ])
    }
    for (const userAgent of [...Object.values(UAS), ...AI_CRAWLERS.map(shouted)]) {
      expect([userAgent, matchesRule(probes, { path: "/", userAgent })]).toEqual([userAgent, false])
    }
  })
})

describe("training-crawlers.json (T3, step 2)", () => {
  const training = rule("training-crawlers.json")

  test("updates the live GPTBot/ClaudeBot rule in place", () => {
    expect(training.action).toBe("rules.update")
    expect(training.id).toBe(TRAINING_RULE_ID)
    expect(training.value.name).toBe("Training crawlers: cached public pages only")
  })

  test("training crawlers may read edge-cached pages", () => {
    for (const token of AI_TRAINING_CRAWLERS) {
      for (const path of [
        "/",
        "/about",
        "/privacy",
        "/term-dates",
        "/categories",
        "/categories/sport",
        "/societies/chess",
        "/events/evt-0123456789abcdef0123456789abcdef01234567",
        "/robots.txt",
        "/llms.txt",
        "/sitemap.xml",
      ]) {
        expect([token, path, matchesRule(training, { path, userAgent: shouted(token) })]).toEqual([
          token,
          path,
          false,
        ])
      }
    }
  })

  test("but never the pages rendered per request, talks, feeds, share images or a query", () => {
    for (const token of AI_TRAINING_CRAWLERS) {
      for (const request of [
        { path: "/events" },
        { path: "/events.rsc" },
        { path: "/societies" },
        { path: "/request" },
        { path: "/sign-in" },
        { path: "/api/auth/get-session" },
        { path: "/dashboard" },
        { path: "/talks" },
        { path: "/talks/departments" },
        { path: "/talks/talk-0" },
        { path: "/talks.ics" },
        { path: "/events.ics" },
        { path: "/events/evt-0/ics" },
        { path: "/events/evt-0/opengraph-image-xy7nla" },
        { path: "/societies/chess/opengraph-image-1y6yla" },
        { path: "/societies/chess", query: "_rsc=abc12" },
        { path: "/about", query: "utm_source=x" },
      ]) {
        expect([
          token,
          request,
          matchesRule(training, { ...request, userAgent: shouted(token) }),
        ]).toEqual([token, request, true])
      }
      expect(matchesRule(training, { path: "/robots.txt", query: "x=1", userAgent: token })).toBe(
        false,
      )
    }
    for (const path of ["/sign-in", "/sign-in.rsc", "/api/auth/get-session", "/dashboard"]) {
      expect([path, new RegExp(UNCACHED_PATHS).test(path)]).toEqual([path, true])
    }
    for (const path of ["/", "/about", "/societies/x", "/events/evt-0", "/sitemap.xml"]) {
      expect([path, new RegExp(UNCACHED_PATHS).test(path)]).toEqual([path, false])
    }
  })

  test("robots.txt tells training crawlers what the firewall enforces", () => {
    const group = [robots().rules].flat().find((rule) => [rule.userAgent].flat().includes("GPTBot"))
    expect(group?.disallow).toEqual([...TRAINING_DISALLOWS])
    if (!group) return
    for (const request of [
      { path: "/" },
      { path: "/about" },
      { path: "/categories/sport" },
      { path: "/societies/chess" },
      { path: "/events/evt-0" },
      { path: "/sitemap.xml" },
      { path: "/sitemaps/events.xml" },
      { path: "/llms.txt" },
      { path: "/events" },
      { path: "/events.rsc" },
      { path: "/events", query: "org=chess" },
      { path: "/events", query: "date=2026-11-03" },
      { path: "/societies" },
      { path: "/societies", query: "page=2" },
      { path: "/request" },
      { path: "/sign-in", query: "cam=1" },
      { path: "/api/auth/get-session" },
      { path: "/dashboard" },
      { path: "/talks" },
      { path: "/talks.ics" },
      { path: "/events.ics" },
      { path: "/events/evt-0/ics" },
      { path: "/events/evt-0/opengraph-image-xy7nla" },
      { path: "/societies/chess", query: "_rsc=abc12" },
      { path: "/about", query: "utm_source=x" },
    ]) {
      const denied = matchesRule(training, { ...request, userAgent: shouted("GPTBot") })
      const url = `${request.path}${request.query ? `?${request.query}` : ""}`
      // Denied by the firewall: disallowed by robots.txt. Disallowed only by
      // robots.txt (/relay, the rest of a private prefix) is fine.
      if (denied) expect([url, robotsGroupAllows(group, url)]).toEqual([url, false])
      else expect([url, robotsGroupAllows(group, url)]).toEqual([url, true])
    }
  })

  test("never browsers, search crawlers or AI search agents", () => {
    for (const userAgent of [
      ...Object.values(UAS),
      shouted("OAI-SearchBot"),
      shouted("Claude-User"),
    ]) {
      expect(matchesRule(training, { path: "/events", userAgent })).toBe(false)
    }
  })
})

describe("dynamic-rate-limit-log.json (T5)", () => {
  const limit = rule("dynamic-rate-limit-log.json")

  test("logs more than 120 a minute per IP on the dynamic paths, refusing nothing", () => {
    expect(limit.value.action.mitigate).toEqual({
      action: "rate_limit",
      rateLimit: { algo: "fixed_window", window: 60, limit: 120, keys: ["ip"], action: "log" },
    })
    for (const path of [
      "/events",
      "/societies.rsc",
      "/request",
      "/sign-in",
      "/talks/x",
      "/api/auth/x",
    ]) {
      expect([path, matchesRule(limit, { path, userAgent: UAS.chrome })]).toEqual([path, true])
    }
    for (const path of ["/", "/events/evt-0", "/societies/chess", "/about", "/relay/e/"]) {
      expect([path, matchesRule(limit, { path, userAgent: UAS.chrome })]).toEqual([path, false])
    }
  })
})

describe("bot-protection-log.json (T5)", () => {
  test("turns the Bot Protection managed ruleset on in log mode", () => {
    expect(JSON.parse(readFileSync(path.join(DIR, "bot-protection-log.json"), "utf8"))).toEqual({
      action: "managedRules.update",
      id: "bot_protection",
      value: { active: true, action: "log" },
    })
  })
})
