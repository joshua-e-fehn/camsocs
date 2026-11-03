import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { AI_CRAWLERS, isAiCrawler, refusesAiAgent } from "./crawlers"

/**
 * The AI agents kept off the talks pillar (owner decisions G1, G6): who is
 * on the list, how a request's user agent is matched, and that the reviewed
 * Vercel firewall rule names exactly the same agents.
 */

const UAS = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  chatgptUser:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  duckAssist: "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)",
  metaFetcher:
    "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  mistral:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
  facebookPreview: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
}

describe("AI_CRAWLERS", () => {
  test("names the AI answer engines, fetchers and training crawlers (G6)", () => {
    for (const token of [
      "DuckAssistBot",
      "MistralAI-User",
      "meta-externalfetcher",
      "YouBot",
      "AI2Bot",
      "Ai2Bot-Dolma",
      "Timpibot",
      "ImagesiftBot",
      "omgili",
      "Google-CloudVertexBot",
      "FacebookBot",
    ]) {
      expect(AI_CRAWLERS).toContain(token)
    }
    expect(new Set(AI_CRAWLERS.map((token) => token.toLowerCase())).size).toBe(AI_CRAWLERS.length)
  })

  test("never a general search crawler", () => {
    for (const token of ["Googlebot", "Bingbot", "Applebot", "GoogleOther", "PetalBot"]) {
      expect(AI_CRAWLERS.map((agent) => agent.toLowerCase())).not.toContain(token.toLowerCase())
    }
  })
})

describe("isAiCrawler / refusesAiAgent", () => {
  test("matches the agents' tokens in a user agent string, in any case", () => {
    for (const ua of [UAS.chatgptUser, UAS.duckAssist, UAS.metaFetcher, UAS.mistral]) {
      expect(isAiCrawler(ua)).toBe(true)
    }
    expect(isAiCrawler("CLAUDEBOT/1.0")).toBe(true)
    for (const ua of [UAS.chrome, UAS.googlebot, UAS.bingbot, UAS.facebookPreview, "", null]) {
      expect(isAiCrawler(ua)).toBe(false)
    }
  })

  test("refuses AI agents on the talks pillar only", () => {
    for (const path of [
      "/talks",
      "/talks/departments",
      "/talks/talk-0",
      "/talks.ics",
      "/talks/events/x",
    ]) {
      expect(refusesAiAgent(path, UAS.chatgptUser)).toBe(true)
      expect(refusesAiAgent(path, UAS.googlebot)).toBe(false)
      expect(refusesAiAgent(path, UAS.chrome)).toBe(false)
    }
    for (const path of ["/", "/events", "/events/evt-x", "/societies/chess"]) {
      expect(refusesAiAgent(path, UAS.chatgptUser)).toBe(false)
    }
  })
})

describe("ops/vercel/talks-ai-crawlers.json", () => {
  test("denies exactly AI_CRAWLERS (as documented and in lower case) under /talks", () => {
    const file = path.join(import.meta.dir, "..", "..", "ops", "vercel", "talks-ai-crawlers.json")
    const rule = JSON.parse(readFileSync(file, "utf8"))
    const [group] = rule.value.conditionGroup
    expect(rule.value.conditionGroup).toHaveLength(1)
    expect(group.conditions[0]).toEqual({ op: "pre", type: "path", value: "/talks" })
    const variants = [...new Set(AI_CRAWLERS.flatMap((token) => [token, token.toLowerCase()]))]
    expect(group.conditions[1]).toEqual({
      op: "re",
      type: "user_agent",
      value: `(${variants.join("|")})`,
    })
  })
})
