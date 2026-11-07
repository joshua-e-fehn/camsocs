import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  failureReason,
  fetchPostHogTraffic,
  fetchSearchConsoleTraffic,
  GOOGLE_TOKEN_URL,
  hogqlBody,
  POSTHOG_QUERIES,
  type PostHogTraffic,
  pagePath,
  posthogQueryConfig,
  readSource,
  searchConsoleConfig,
  searchConsoleWindow,
  TrafficSourceError,
} from "./lib/traffic"
import { mergeSource } from "./traffic"

/**
 * The broker overview's website traffic: PostHog and Search Console are read
 * with the network stubbed, their numbers folded into one snapshot row that
 * only the broker can read; a failed read keeps the last good numbers and
 * never carries a key or a response body.
 */

const BROKER = "broker@example.com"
const POSTHOG_KEY = "phx_test_personal_key_never_logged"
const REFRESH_TOKEN = "1//test-refresh-token-never-logged"
const NOW = Date.UTC(2026, 10, 7, 12, 0)

type Call = { url: string; init: RequestInit }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** PostHog's query API: a canned result per query, keyed by its first column. */
function posthogStub(calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const query: string = JSON.parse(String(init.body)).query.query
    if (query === hogqlBody(POSTHOG_QUERIES.totals, "cam").query.query) {
      return json({ results: [[17, 9, 97, 40, 29]] })
    }
    if (query.includes("AS day")) {
      return json({
        results: [
          ["2026-11-06", 5, 20],
          ["2026-11-07", 4, 12],
          ["bad", 1, 1],
        ],
      })
    }
    if (query.includes("AS domain")) {
      return json({
        results: [
          ["$direct", 25, 14],
          ["www.google.com", 3, 3],
          [null, 1, 1],
        ],
      })
    }
    if (query.includes("AS source,")) {
      return json({
        results: [
          ["google", 30, 12],
          ["direct", 10, 4],
        ],
      })
    }
    if (query.includes("AS page,")) {
      return json({ results: [["society", 25, 9]] })
    }
    return json({
      results: [
        ["/", 40, 12],
        ["/societies", 20, 8],
      ],
    })
  }) as typeof fetch
}

/** Google's token endpoint and Search Analytics API. */
function gscStub(calls: Call[], { tokenStatus = 200 } = {}): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url === GOOGLE_TOKEN_URL) {
      return tokenStatus === 200
        ? json({ access_token: "ya29.test", expires_in: 3599 })
        : json({ error: "invalid_grant", error_description: "Token has been revoked." }, 400)
    }
    const { dimensions } = JSON.parse(String(init.body)) as { dimensions: string[] }
    const row = (keys: string[], clicks: number) => ({
      keys,
      clicks,
      impressions: clicks * 10,
      ctr: 0.1,
      position: 7.5,
    })
    if (dimensions.length === 0)
      return json({ rows: [{ clicks: 12, impressions: 300, ctr: 0.04, position: 9.1 }] })
    if (dimensions[0] === "date")
      return json({ rows: [row(["2026-11-05"], 2), row(["2026-11-04"], 1)] })
    if (dimensions[0] === "query") return json({ rows: [row(["cambridge societies"], 5)] })
    return json({
      rows: [row(["https://camsocs.uk/societies?x=1"], 4), row(["https://other.example/"], 1)],
    })
  }) as typeof fetch
}

const posthogConfig = { key: POSTHOG_KEY, projectId: "330133", appHost: "https://eu.posthog.com" }
const gscConfig = {
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "secret",
  refreshToken: REFRESH_TOKEN,
  siteUrl: "https://camsocs.uk/",
}

describe("configuration", () => {
  test("each source is off until all of its env vars are set", () => {
    expect(posthogQueryConfig({})).toBeNull()
    expect(posthogQueryConfig({ POSTHOG_PERSONAL_API_KEY: "k" })).toBeNull()
    expect(
      posthogQueryConfig({ POSTHOG_PERSONAL_API_KEY: "k", POSTHOG_PROJECT_ID: "x1" }),
    ).toBeNull()
    expect(
      posthogQueryConfig({ POSTHOG_PERSONAL_API_KEY: "k", POSTHOG_PROJECT_ID: "330133" }),
    ).toEqual({ key: "k", projectId: "330133", appHost: "https://eu.posthog.com" })
    expect(searchConsoleConfig({ GSC_CLIENT_ID: "a", GSC_CLIENT_SECRET: "b" })).toBeNull()
    const env = { GSC_CLIENT_ID: "a", GSC_CLIENT_SECRET: "b", GSC_REFRESH_TOKEN: "c" }
    expect(searchConsoleConfig(env)).toBeNull()
    expect(searchConsoleConfig({ ...env, SITE_URL: "https://camsocs.uk" })?.siteUrl).toBe(
      "https://camsocs.uk/",
    )
    expect(
      searchConsoleConfig({ ...env, SITE_URL: "https://x", GSC_SITE_URL: "sc-domain:camsocs.uk" })
        ?.siteUrl,
    ).toBe("sc-domain:camsocs.uk")
  })
})

describe("PostHog", () => {
  test("pageviews of this campus, with the internal/test filter, over 30 days", () => {
    const body = hogqlBody(POSTHOG_QUERIES.pages, "cam")
    expect(body.query.query).toContain("ifNull(properties.campus, 'cam') = 'cam'")
    expect(body.query.query).toContain("{filters}")
    expect(body.query.filters).toEqual({
      dateRange: { date_from: "-30d" },
      filterTestAccounts: true,
    })
    expect(() => hogqlBody(POSTHOG_QUERIES.pages, "cam' OR 1=1")).toThrow(TrafficSourceError)
  })

  test("reads totals, days, referrers and pages", async () => {
    const calls: Call[] = []
    const traffic = await fetchPostHogTraffic(posthogConfig, posthogStub(calls), "cam")
    expect(calls).toHaveLength(7)
    expect(calls[0]?.url).toBe("https://eu.posthog.com/api/projects/330133/query/")
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe(`Bearer ${POSTHOG_KEY}`)
    expect(traffic).toMatchObject({ visitors: 17, visitors7d: 9, pageviews: 97, sessions: 29 })
    expect(traffic.daily.map((d) => d.day)).toEqual(["2026-11-06", "2026-11-07"])
    expect(traffic.referrers.map((r) => r.domain)).toEqual(["$direct", "www.google.com", "$direct"])
    expect(traffic.pages[0]).toEqual({ path: "/", pageviews: 40, visitors: 12 })
    // The server's consent-free count, summed from its kinds of source.
    expect(traffic.serverVisits).toEqual({
      visits: 40,
      visits7d: 16,
      daily: [
        { day: "2026-11-06", visits: 5 },
        { day: "2026-11-07", visits: 4 },
      ],
      sources: [
        { source: "google", visits: 30, visits7d: 12 },
        { source: "direct", visits: 10, visits7d: 4 },
      ],
      pages: [{ page: "society", visits: 25, visits7d: 9 }],
    })
  })

  test("a refusal is a short reason, never the key", async () => {
    const refuse = (async () =>
      json({ detail: "Global variable not found: x" }, 400)) as unknown as typeof fetch
    const result = await readSource(posthogConfig, (config) =>
      fetchPostHogTraffic(config, refuse, "cam"),
    )
    expect(result).toEqual({ status: "failed", error: "HTTP 400: Global variable not found: x" })
    expect(JSON.stringify(result)).not.toContain(POSTHOG_KEY)
  })
})

describe("Search Console", () => {
  test("28 days ending yesterday", () => {
    expect(searchConsoleWindow(NOW)).toEqual({ startDate: "2026-10-10", endDate: "2026-11-06" })
  })

  test("pages of the property become paths; other URLs stay whole", () => {
    expect(pagePath("https://camsocs.uk/societies/x", "https://camsocs.uk/")).toBe("/societies/x")
    expect(pagePath("https://other.example/a", "https://camsocs.uk/")).toBe(
      "https://other.example/a",
    )
  })

  test("refreshes a token, then reads totals, days, queries and pages", async () => {
    const calls: Call[] = []
    const traffic = await fetchSearchConsoleTraffic(gscConfig, NOW, gscStub(calls))
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_URL)
    expect(String(calls[0]?.init.body)).toContain("grant_type=refresh_token")
    const api = calls.slice(1)
    expect(api).toHaveLength(4)
    expect(api[0]?.url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fcamsocs.uk%2F/searchAnalytics/query",
    )
    expect(new Headers(api[0]?.init.headers).get("Authorization")).toBe("Bearer ya29.test")
    expect(JSON.parse(String(api[0]?.init.body))).toMatchObject({
      startDate: "2026-10-10",
      endDate: "2026-11-06",
      dataState: "all",
    })
    expect(traffic).toMatchObject({ clicks: 12, impressions: 300, ctr: 0.04, position: 9.1 })
    expect(traffic.daily.map((d) => d.day)).toEqual(["2026-11-04", "2026-11-05"])
    expect(traffic.queries).toEqual([
      { query: "cambridge societies", clicks: 5, impressions: 50, ctr: 0.1, position: 7.5 },
    ])
    expect(traffic.pages.map((p) => p.path)).toEqual(["/societies?x=1", "https://other.example/"])
  })

  test("a revoked refresh token is reported by its OAuth code only", async () => {
    const result = await readSource(gscConfig, (config) =>
      fetchSearchConsoleTraffic(config, NOW, gscStub([], { tokenStatus: 400 })),
    )
    expect(result).toEqual({ status: "failed", error: "token HTTP 400: invalid_grant" })
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN)
  })

  test("a timeout is named, not thrown", () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    expect(failureReason(abort)).toBe("timed out")
  })
})

describe("snapshot", () => {
  const data: PostHogTraffic = {
    windowDays: 30,
    visitors: 1,
    visitors7d: 1,
    pageviews: 2,
    pageviews7d: 2,
    sessions: 1,
    daily: [],
    referrers: [],
    pages: [],
  }

  test("a failed read keeps the last good data; switching a source off drops it", () => {
    const ok = mergeSource(undefined, { status: "ok", data }, 1)
    expect(ok).toEqual({ status: "ok", checkedAt: 1, fetchedAt: 1, data })
    expect(mergeSource(ok, { status: "failed", error: "HTTP 503" }, 2)).toEqual({
      status: "failed",
      checkedAt: 2,
      error: "HTTP 503",
      fetchedAt: 1,
      data,
    })
    expect(mergeSource(ok, { status: "not_configured" }, 3)).toEqual({
      status: "not_configured",
      checkedAt: 3,
    })
  })

  test("refresh stores one row only the broker reads", async () => {
    await withEnv(
      {
        BROKER_EMAILS: BROKER,
        POSTHOG_PERSONAL_API_KEY: undefined,
        POSTHOG_PROJECT_ID: undefined,
        GSC_REFRESH_TOKEN: undefined,
      },
      async () => {
        const t = newTest()
        const broker = (await signedInAs(t, BROKER)) as unknown as TestConvex
        const stranger = (await signedInAs(t, "someone@example.com")) as unknown as TestConvex
        expect(await broker.query(api.broker.overview.traffic, {})).toBeNull()
        await expect(stranger.query(api.broker.overview.traffic, {})).rejects.toThrow()
        await expect(stranger.mutation(api.broker.overview.refreshTraffic, {})).rejects.toThrow()

        await broker.mutation(api.broker.overview.refreshTraffic, {})
        await t.finishAllScheduledFunctions(() => {})
        const first = await broker.query(api.broker.overview.traffic, {})
        expect(first?.posthog.status).toBe("not_configured")
        expect(first?.searchConsole.status).toBe("not_configured")

        await t.mutation(internal.traffic.store, {
          checkedAt: 5,
          posthog: { status: "ok", data },
          searchConsole: { status: "failed", error: "token HTTP 400: invalid_grant" },
        })
        const second = await broker.query(api.broker.overview.traffic, {})
        expect(second?.posthog).toEqual({ status: "ok", checkedAt: 5, fetchedAt: 5, data })
        expect(second?.searchConsole).toEqual({
          status: "failed",
          checkedAt: 5,
          error: "token HTTP 400: invalid_grant",
        })
        const rows = await t.run((ctx) => ctx.db.query("trafficSnapshots").collect())
        expect(rows).toHaveLength(1)
      },
    )
  })
})
