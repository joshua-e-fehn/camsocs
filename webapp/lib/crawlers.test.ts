import { describe, expect, test } from "bun:test"
import {
  AI_CRAWLERS,
  AI_SEARCH_CRAWLERS,
  AI_TRAINING_CRAWLERS,
  AI_USER_AGENTS,
  isAiCrawler,
  isScraper,
  refusesAiAgent,
  SCRAPERS,
} from "./crawlers"

/**
 * The crawler tiers (bot policy 2026-11-03) and the AI agents kept off the
 * talks pillar (owner decisions G1, G6): who is on each list and how a
 * request's user agent is matched. The Vercel firewall rules built from the
 * same lists: lib/firewall-rules.test.ts.
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
  amznSearch:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-SearchBot/0.1) Chrome/119.0.6045.214 Safari/537.36",
  metaIndexer:
    "meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  ahrefs: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  bytespider:
    "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
}

describe("the crawler tiers", () => {
  test("AI_CRAWLERS is the search, user-triggered and training tiers (G6)", () => {
    expect(AI_CRAWLERS).toEqual([...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS, ...AI_TRAINING_CRAWLERS])
    for (const token of [
      "OAI-SearchBot",
      "Claude-SearchBot",
      "meta-webindexer",
      "Amzn-SearchBot",
    ]) {
      expect(AI_SEARCH_CRAWLERS).toContain(token)
    }
    for (const token of ["ChatGPT-User", "Claude-User", "Perplexity-User", "Amzn-User"]) {
      expect(AI_USER_AGENTS).toContain(token)
    }
    for (const token of ["GPTBot", "ClaudeBot", "CCBot", "meta-externalagent", "Amazonbot"]) {
      expect(AI_TRAINING_CRAWLERS).toContain(token)
    }
  })

  test("no token is listed twice, in any tier", () => {
    const all = [...AI_CRAWLERS, ...SCRAPERS].map((token) => token.toLowerCase())
    expect(new Set(all).size).toBe(all.length)
  })

  test("bulk scrapers are not AI agents (bot policy 2026-11-03)", () => {
    for (const token of ["Bytespider", "Diffbot", "ImagesiftBot", "AhrefsBot", "PetalBot"]) {
      expect(SCRAPERS).toContain(token)
      expect(AI_CRAWLERS).not.toContain(token)
    }
  })

  test("never a general search crawler", () => {
    const listed = [...AI_CRAWLERS, ...SCRAPERS].map((agent) => agent.toLowerCase())
    for (const token of ["Googlebot", "Bingbot", "Applebot", "GoogleOther"]) {
      expect(listed).not.toContain(token.toLowerCase())
    }
  })
})

describe("isAiCrawler / refusesAiAgent", () => {
  test("matches the agents' tokens in a user agent string, in any case", () => {
    for (const ua of [
      UAS.chatgptUser,
      UAS.duckAssist,
      UAS.metaFetcher,
      UAS.mistral,
      UAS.amznSearch,
      UAS.metaIndexer,
    ]) {
      expect(isAiCrawler(ua)).toBe(true)
      expect(isScraper(ua)).toBe(false)
    }
    for (const ua of [UAS.ahrefs, UAS.bytespider]) {
      expect(isScraper(ua)).toBe(true)
      expect(isAiCrawler(ua)).toBe(false)
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
      expect(refusesAiAgent(path, UAS.bytespider)).toBe(true)
      expect(refusesAiAgent(path, UAS.googlebot)).toBe(false)
      expect(refusesAiAgent(path, UAS.chrome)).toBe(false)
    }
    for (const path of ["/", "/events", "/events/evt-x", "/societies/chess"]) {
      expect(refusesAiAgent(path, UAS.chatgptUser)).toBe(false)
    }
  })
})
