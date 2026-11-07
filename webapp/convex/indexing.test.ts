import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"
import {
  classify,
  dueAt,
  KEY_PAGE_GRACE_MS,
  kindOf,
  ownProblem,
  RECHECK_INDEXED_MS,
  selectDue,
  sitemapIssue,
  sitemapUrls,
  summarize,
} from "./lib/indexing"

/** The daily indexing check (convex/indexing.ts, convex/lib/indexing.ts).
 * Invented URLs only; no request leaves the test. */

const NOW = Date.parse("2026-11-08T07:00:00Z")
const DAY = 86_400_000
const SITE = "https://example.org"

describe("classify", () => {
  const url = `${SITE}/colleges`
  test("indexed, waiting and crawled-not-indexed are states, not problems", () => {
    expect(classify(url, { verdict: "PASS", coverageState: "Submitted and indexed" })).toEqual({
      state: "indexed",
    })
    expect(
      classify(url, { verdict: "NEUTRAL", coverageState: "URL is unknown to Google" }).state,
    ).toBe("waiting")
    expect(classify(url, { coverageState: "Discovered - currently not indexed" }).state).toBe(
      "waiting",
    )
    expect(classify(url, { coverageState: "Crawled - currently not indexed" }).state).toBe(
      "not_indexed",
    )
  })

  test("noindex, robots.txt, fetch errors, redirects and a foreign canonical are problems", () => {
    expect(classify(url, { indexingState: "BLOCKED_BY_META_TAG" }).problem).toContain("noindex")
    expect(classify(url, { robotsTxtState: "DISALLOWED" }).problem).toContain("robots.txt")
    expect(classify(url, { pageFetchState: "NOT_FOUND" }).problem).toBe("fetch: NOT_FOUND")
    expect(classify(url, { coverageState: "Page with redirect" }).state).toBe("problem")
    expect(classify(url, { verdict: "PASS", googleCanonical: `${SITE}/colleges?x=1` }).state).toBe(
      "problem",
    )
    // The same URL with or without a trailing slash is the same page.
    expect(classify(`${SITE}/`, { verdict: "PASS", googleCanonical: SITE }).state).toBe("indexed")
  })
})

describe("ownProblem", () => {
  const url = `${SITE}/guides`
  const page = (head: string) => `<html><head>${head}</head><body></body></html>`
  test("200, no noindex and a self canonical is fine; anything else is named", () => {
    expect(ownProblem(url, 200, page(`<link rel="canonical" href="${url}"/>`))).toBeUndefined()
    expect(ownProblem(url, 404, "")).toBe("answers HTTP 404")
    expect(
      ownProblem(
        url,
        200,
        page(
          `<meta name="robots" content="noindex, follow"/><link rel="canonical" href="${url}"/>`,
        ),
      ),
    ).toBe("carries noindex")
    expect(ownProblem(url, 200, page(""))).toBe("has no canonical link")
    expect(ownProblem(url, 200, page(`<link rel="canonical" href="${SITE}/"/>`))).toContain(
      "elsewhere",
    )
  })
})

describe("sitemaps and scheduling", () => {
  test("kinds by file and path; <loc> entries read", () => {
    expect(kindOf("pages.xml", "/guides")).toBe("page")
    expect(kindOf("societies.xml", "/categories/sport")).toBe("hub")
    expect(kindOf("societies.xml", "/societies/chess")).toBe("society")
    expect(kindOf("events.xml", "/events/evt-1")).toBe("event")
    expect(
      sitemapUrls(
        `<urlset><url><loc>${SITE}/a?x=1&amp;y=2</loc></url><url><loc> ${SITE}/b </loc></url></urlset>`,
      ),
    ).toEqual([`${SITE}/a?x=1&y=2`, `${SITE}/b`])
  })

  test("never-checked key pages first, then never-checked others, then the most overdue", () => {
    const rows = [
      {
        url: "indexed-event",
        kind: "event" as const,
        listedSince: 0,
        checkedAt: NOW - 2 * DAY,
        state: "indexed" as const,
      },
      {
        url: "old-event",
        kind: "event" as const,
        listedSince: 0,
        checkedAt: NOW - 30 * DAY,
        state: "indexed" as const,
      },
      { url: "new-event", kind: "event" as const, listedSince: NOW },
      { url: "new-page", kind: "page" as const, listedSince: NOW },
      {
        url: "page-yesterday",
        kind: "page" as const,
        listedSince: 0,
        checkedAt: NOW - DAY,
        state: "indexed" as const,
      },
      {
        url: "waiting-society",
        kind: "society" as const,
        listedSince: 0,
        checkedAt: NOW - 3 * DAY,
        state: "waiting" as const,
      },
    ]
    expect(selectDue(rows, NOW, 10).map((r) => r.url)).toEqual([
      "new-page",
      "new-event",
      "page-yesterday",
      "old-event",
      "waiting-society",
    ])
    expect(selectDue(rows, NOW, 2)).toHaveLength(2)
    expect(dueAt(rows[0])).toBe(NOW - 2 * DAY + RECHECK_INDEXED_MS)
  })

  test("a sitemap with errors, never read or unread for days is an issue", () => {
    expect(sitemapIssue({ path: "/a", errors: 2, warnings: 0, lastDownloaded: NOW }, NOW)).toBe(
      "2 errors",
    )
    expect(sitemapIssue({ path: "/a", errors: 0, warnings: 0 }, NOW)).toBe("never read by Google")
    expect(
      sitemapIssue({ path: "/a", errors: 0, warnings: 0, lastDownloaded: NOW - 5 * DAY }, NOW),
    ).toBe("not read for 5 days")
    expect(
      sitemapIssue({ path: "/a", errors: 0, warnings: 3, lastDownloaded: NOW - DAY }, NOW),
    ).toBeUndefined()
  })
})

describe("summarize", () => {
  test("problems alert, lagging key pages are listed, waiting ones are only counted", () => {
    const rows = [
      {
        url: `${SITE}/guides`,
        kind: "page" as const,
        listedSince: NOW - 20 * DAY,
        checkedAt: NOW,
        state: "waiting" as const,
      },
      {
        url: `${SITE}/colleges`,
        kind: "page" as const,
        listedSince: NOW - DAY,
        checkedAt: NOW,
        state: "waiting" as const,
      },
      {
        url: `${SITE}/terms`,
        kind: "page" as const,
        listedSince: 0,
        ownProblem: "carries noindex",
      },
      {
        url: `${SITE}/societies/a`,
        kind: "society" as const,
        listedSince: 0,
        checkedAt: NOW,
        state: "problem" as const,
        problem: "Page with redirect",
      },
      {
        url: `${SITE}/events/e`,
        kind: "event" as const,
        listedSince: NOW - 20 * DAY,
        checkedAt: NOW,
        state: "waiting" as const,
      },
      {
        url: `${SITE}/`,
        kind: "page" as const,
        listedSince: 0,
        checkedAt: NOW,
        state: "indexed" as const,
      },
    ]
    const s = summarize(
      rows,
      [{ path: "/sitemaps/events.xml", errors: 0, warnings: 0, lastDownloaded: NOW - 6 * DAY }],
      NOW,
    )
    expect(s.counts.page).toEqual({
      indexed: 1,
      waiting: 2,
      not_indexed: 0,
      problem: 1,
      unchecked: 0,
    })
    expect(s.problems.map((p) => [new URL(p.url).pathname, p.problem])).toEqual([
      ["/terms", "our page carries noindex"],
      ["/societies/a", "Page with redirect"],
    ])
    // Listed 20 days ago and still waiting; /colleges is inside the grace period.
    expect(s.lagging.map((l) => new URL(l.url).pathname)).toEqual(["/guides"])
    expect(NOW - (NOW - 20 * DAY)).toBeGreaterThan(KEY_PAGE_GRACE_MS)
    expect(s.alerts).toEqual([
      "2 sitemap URLs cannot be indexed: /terms (our page carries noindex); /societies/a (Page with redirect)",
      "sitemap /sitemaps/events.xml: not read for 6 days",
    ])
  })

  test("all well: no alerts", () => {
    const s = summarize(
      [{ url: `${SITE}/`, kind: "page", listedSince: 0, checkedAt: NOW, state: "indexed" }],
      [{ path: "/sitemap.xml", errors: 0, warnings: 0, lastDownloaded: NOW - DAY }],
      NOW,
    )
    expect(s.alerts).toEqual([])
  })
})

describe("the check's storage", () => {
  test("sync follows the sitemaps; inspections and our own reads end in one summary", async () => {
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const t = newTest()
      const T0 = Date.now()
      await t.mutation(internal.indexing.sync, {
        now: T0,
        entries: [
          { url: `${SITE}/`, kind: "page" },
          { url: `${SITE}/gone`, kind: "page" },
          { url: `${SITE}/events/e1`, kind: "event" },
        ],
      })
      await t.mutation(internal.indexing.sync, {
        now: T0 + DAY,
        entries: [
          { url: `${SITE}/`, kind: "page" },
          { url: `${SITE}/events/e1`, kind: "event" },
          { url: `${SITE}/events/e2`, kind: "event" },
        ],
      })
      // Never-checked first, the key page before the events.
      expect(await t.query(internal.indexing.dueRows, { limit: 10 })).toEqual([
        `${SITE}/`,
        `${SITE}/events/e1`,
        `${SITE}/events/e2`,
      ])
      await t.mutation(internal.indexing.recordOwn, {
        now: T0,
        results: [{ url: `${SITE}/`, problem: undefined }],
      })
      await t.mutation(internal.indexing.recordInspections, {
        now: T0,
        results: [
          { url: `${SITE}/`, verdict: "PASS", coverageState: "Submitted and indexed" },
          {
            url: `${SITE}/events/e1`,
            coverageState: "Excluded by ‘noindex’ tag",
            indexingState: "BLOCKED_BY_META_TAG",
          },
        ],
      })
      expect(await t.query(internal.indexing.monitorSummary, {})).toEqual({
        runAt: null,
        problems: 0,
        sitemapIssues: 0,
      })
      await t.mutation(internal.indexing.finish, { now: T0, inspected: 2, sitemaps: [] })
      expect(await t.query(internal.indexing.monitorSummary, {})).toEqual({
        runAt: T0,
        problems: 1,
        sitemapIssues: 0,
      })

      const broker = (await signedInAs(t, "broker@example.com")) as unknown as TestConvex
      const summary = await broker.query(api.indexing.summary, {})
      expect(summary?.counts.page.indexed).toBe(1)
      expect(summary?.counts.event).toMatchObject({ problem: 1, unchecked: 1 })
      // Not for anyone else.
      await expect(t.query(api.indexing.summary, {})).rejects.toThrow()
    })
  })
})
