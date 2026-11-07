import { describe, expect, test } from "bun:test"
import { config } from "../proxy"
import { VISIT_PAGES, type VISIT_SOURCES, visitFacts, visitPage, visitSource } from "./visit-count"

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

function navigation(pathname: string, extra: Record<string, string> = {}, method = "GET") {
  return {
    method,
    pathname,
    siteHost: "camsocs.uk",
    headers: new Headers({
      "user-agent": BROWSER,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      ...extra,
    }),
  }
}

describe("visitFacts", () => {
  test("a browser's page load from Google is a visit, as two enums", () => {
    expect(
      visitFacts(navigation("/societies/chess-club", { referer: "https://www.google.com/" })),
    ).toEqual({ page: "society", source: "google" })
  })

  test("only top-level browser navigations count", () => {
    const noFetchMetadata = navigation("/")
    noFetchMetadata.headers.delete("sec-fetch-mode")
    expect(visitFacts(noFetchMetadata)).toBeNull()
    expect(visitFacts(navigation("/", { "sec-fetch-dest": "iframe" }))).toBeNull()
    expect(visitFacts(navigation("/", { "sec-fetch-mode": "cors" }))).toBeNull()
    expect(visitFacts(navigation("/", {}, "HEAD"))).toBeNull()
    expect(visitFacts(navigation("/", { "sec-purpose": "prefetch;prerender" }))).toBeNull()
  })

  test("crawlers that name themselves are not visits", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)",
      "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0 Safari/537.36",
    ]) {
      expect(visitFacts(navigation("/", { "user-agent": ua }))).toBeNull()
    }
  })

  test("the private areas and machinery are never counted", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/requests",
      "/sign-in",
      "/api/request",
      "/relay/e",
    ]) {
      expect(visitFacts(navigation(path))).toBeNull()
    }
  })
})

describe("visitPage", () => {
  test("keeps the kind of page, never its key or slug", () => {
    expect(visitPage("/")).toBe("home")
    expect(visitPage("/societies")).toBe("societies")
    expect(visitPage("/societies/x")).toBe("society")
    expect(visitPage("/categories")).toBe("categories")
    expect(visitPage("/categories/sport")).toBe("categories")
    expect(visitPage("/events/")).toBe("events")
    expect(visitPage(`/events/evt-${"0".repeat(40)}`)).toBe("event")
    expect(visitPage("/talks/departments")).toBe("talks")
    expect(visitPage("/term-dates")).toBe("term_dates")
    expect(visitPage("/privacy")).toBe("info")
    expect(visitPage("/guides/freshers")).toBe("other")
    for (const path of ["/", "/societies/x", "/nowhere"]) {
      expect(VISIT_PAGES).toContain(visitPage(path))
    }
  })
})

describe("visitSource", () => {
  test("reduces the referrer to a kind of site", () => {
    const cases: [string | null, string][] = [
      [null, "direct"],
      ["not a url", "direct"],
      ["https://camsocs.uk/events", "internal"],
      ["https://www.google.co.uk/", "google"],
      ["https://gemini.google.com/app", "ai_assistant"],
      ["https://www.bing.com/search?q=x", "bing"],
      ["https://duckduckgo.com/", "other_search"],
      ["https://chatgpt.com/", "ai_assistant"],
      ["https://l.instagram.com/", "social"],
      ["https://www.cambridgesu.co.uk/organisation/1/", "cambridge"],
      ["https://www.chu.cam.ac.uk/", "cambridge"],
      ["https://example.org/", "other_site"],
    ]
    for (const [referer, source] of cases) {
      expect(visitSource(referer, "camsocs.uk")).toBe(source as (typeof VISIT_SOURCES)[number])
    }
  })
})

describe("the proxy sees the public pages it counts", () => {
  const sources = (config.matcher as { source: string }[]).map((entry) => entry.source)
  test("every top-level public page is matched", () => {
    for (const source of [
      "/",
      "/societies",
      "/societies/:key",
      "/events",
      "/events/:key",
      "/categories/:path*",
      "/term-dates",
      "/talks/:path*",
    ]) {
      expect(sources).toContain(source)
    }
  })
})
