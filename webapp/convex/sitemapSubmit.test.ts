import { describe, expect, test } from "bun:test"
import { fileUrl, RESUBMIT_EVERY_MS, resubmitSitemaps, shouldSubmit } from "./lib/sitemapSubmit"
import type { SearchConsoleConfig } from "./lib/traffic"

/** The daily sitemap resubmission (convex/lib/sitemapSubmit.ts), against a
 * fake Google: no request leaves the test. */

const CONFIG: SearchConsoleConfig = {
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
  siteUrl: "https://example.org/",
}
const NOW = Date.parse("2026-11-08T06:10:00Z")
const DAY = 86_400_000

describe("shouldSubmit", () => {
  test("never submitted, an event stored since, or a week old: submit; else leave it", () => {
    expect(shouldSubmit(null, null, NOW)).toBe(true)
    expect(shouldSubmit(NOW - DAY, NOW - 1000, NOW)).toBe(true)
    expect(shouldSubmit(NOW - DAY, NOW - 2 * DAY, NOW)).toBe(false)
    expect(shouldSubmit(NOW - DAY, null, NOW)).toBe(false)
    expect(shouldSubmit(NOW - RESUBMIT_EVERY_MS, NOW - 9 * DAY, NOW)).toBe(true)
  })
})

describe("fileUrl", () => {
  test("from a URL-prefix property, or the site origin for a domain property", () => {
    expect(fileUrl(CONFIG, "https://ignored.example", "events.atom")).toBe(
      "https://example.org/events.atom",
    )
    expect(
      fileUrl(
        { ...CONFIG, siteUrl: "sc-domain:example.org" },
        "https://example.org",
        "sitemap.xml",
      ),
    ).toBe("https://example.org/sitemap.xml")
  })
})

type Call = { method: string; url: string; auth?: string }

function fakeGoogle(
  lastSubmitted: Record<string, string | null>,
  opts: { tokenStatus?: number } = {},
) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
    calls.push({ method, url, auth })
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const status = opts.tokenStatus ?? 200
      return new Response(
        JSON.stringify(status === 200 ? { access_token: "tok" } : { error: "invalid_grant" }),
        { status },
      )
    }
    const file = decodeURIComponent(url.split("/sitemaps/")[1] ?? "")
    if (method === "PUT") return new Response(null, { status: 204 })
    const last = lastSubmitted[file]
    if (last === undefined)
      return new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 })
    return new Response(JSON.stringify(last ? { path: file, lastSubmitted: last } : { path: file }))
  }) as typeof fetch
  return { calls, impl }
}

describe("resubmitSitemaps", () => {
  test("submits only the files with news, with the access token, to the property's endpoint", async () => {
    const google = fakeGoogle({
      "https://example.org/sitemap.xml": new Date(NOW - DAY).toISOString(),
      // events.atom never submitted: 404
    })
    const outcomes = await resubmitSitemaps(
      CONFIG,
      "https://example.org",
      NOW - 2 * DAY,
      NOW,
      google.impl,
    )
    expect(outcomes).toEqual([
      { file: "sitemap.xml", action: "unchanged" },
      { file: "events.atom", action: "submitted" },
    ])
    const puts = google.calls.filter((c) => c.method === "PUT")
    expect(puts).toHaveLength(1)
    expect(puts[0].url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.org%2F/sitemaps/https%3A%2F%2Fexample.org%2Fevents.atom",
    )
    expect(puts[0].auth).toBe("Bearer tok")
  })

  test("an event stored since the last submission sends both", async () => {
    const at = new Date(NOW - DAY).toISOString()
    const google = fakeGoogle({
      "https://example.org/sitemap.xml": at,
      "https://example.org/events.atom": at,
    })
    const outcomes = await resubmitSitemaps(
      CONFIG,
      "https://example.org",
      NOW - 3600_000,
      NOW,
      google.impl,
    )
    expect(outcomes.map((o) => o.action)).toEqual(["submitted", "submitted"])
  })

  test("a refused token fails every file, never throws, and never leaks the secret", async () => {
    const google = fakeGoogle({}, { tokenStatus: 400 })
    const outcomes = await resubmitSitemaps(CONFIG, "https://example.org", null, NOW, google.impl)
    expect(outcomes.map((o) => o.action)).toEqual(["failed", "failed"])
    expect(JSON.stringify(outcomes)).not.toContain("secret")
    expect(google.calls.filter((c) => c.method === "PUT")).toHaveLength(0)
  })
})
