import { v } from "convex/values"
import { internal } from "./_generated/api"
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server"
import { requireBrokerUser } from "./lib/auth"
import {
  BATCH,
  CONCURRENCY,
  classify,
  DAILY_BUDGET,
  type Inspection,
  isKey,
  kindOf,
  ownProblem,
  type SitemapStatus,
  selectDue,
  sitemapUrls,
  summarize,
} from "./lib/indexing"
import {
  accessToken,
  GSC_API,
  REQUEST_TIMEOUT_MS,
  request,
  type SearchConsoleConfig,
  searchConsoleConfig,
} from "./lib/traffic"
import { indexCheckFields, indexingSummaryFields } from "./schema"

/**
 * The daily indexing check (convex/lib/indexing.ts has the rules). The cron
 * `indexing-check-daily` starts `run`, which
 *  1. reads our three sitemaps (past the edge cache) and syncs one
 *     `indexChecks` row per listed URL (rows no longer listed go);
 *  2. reads every key page (pages.xml and the hubs) itself: 200, no
 *     noindex, a self canonical;
 *  3. reads Search Console's status of the submitted sitemaps;
 *  4. hands over to `inspectBatch`, which inspects the most urgent URLs
 *     through the URL Inspection API, `BATCH` at a time, up to
 *     `DAILY_BUDGET` a day, each call scheduling the next;
 *  5. `finish` writes the one `indexingSummaries` row the broker overview
 *     shows and the VPS monitor reads (`monitorSummary`, through
 *     `/api/pipeline/indexing/summary`; it pages on `alerts`).
 * A no-op where the `GSC_*` variables are unset (dev, previews).
 */

const SITEMAP_FILES = ["pages.xml", "societies.xml", "events.xml"] as const
/** Rows read at most: one per sitemap URL (~1,500 in Nov 2026), far below
 * this and a mutation's write limit. */
const MAX_ROWS = 6_000
const USER_AGENT = "camsocs-indexing-check/0.1 (+https://camsocs.uk/about)"
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

function siteOrigin(config: SearchConsoleConfig): string {
  const fromEnv = process.env.SITE_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, "")
  return config.siteUrl.replace(/\/+$/, "")
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await request(
    fetch,
    url,
    { headers: { "User-Agent": USER_AGENT }, redirect: "manual" },
    REQUEST_TIMEOUT_MS,
  )
  return { status: response.status, text: response.status === 200 ? await response.text() : "" }
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await work(items[index])
      }
    }),
  )
  return out
}

const sitemapStatus = v.object({
  path: v.string(),
  lastDownloaded: v.optional(v.number()),
  errors: v.number(),
  warnings: v.number(),
  submitted: v.optional(v.number()),
})

/** Search Console's status of the submitted sitemaps and the index's children. */
async function readSitemapStatus(
  config: SearchConsoleConfig,
  origin: string,
  token: string,
): Promise<SitemapStatus[]> {
  const base = `${GSC_API}/sites/${encodeURIComponent(config.siteUrl)}/sitemaps`
  const read = async (url: string) => {
    const response = await request(
      fetch,
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      REQUEST_TIMEOUT_MS,
    )
    if (!response.ok) throw new Error(`sitemaps HTTP ${response.status}`)
    const body = (await response.json()) as { sitemap?: Record<string, unknown>[] }
    return body.sitemap ?? []
  }
  const top = await read(base)
  const children = await read(
    `${base}?sitemapIndex=${encodeURIComponent(`${origin}/sitemap.xml`)}`,
  ).catch(() => [])
  const seen = new Set<string>()
  const out: SitemapStatus[] = []
  for (const s of [...top, ...children]) {
    const path = typeof s.path === "string" ? s.path : ""
    if (!path || seen.has(path)) continue
    seen.add(path)
    const time = (value: unknown) => {
      const at = typeof value === "string" ? Date.parse(value) : Number.NaN
      return Number.isFinite(at) ? at : undefined
    }
    out.push({
      path: path.startsWith(origin) ? path.slice(origin.length) || "/" : path,
      lastDownloaded: time(s.lastDownloaded),
      submitted: time(s.lastSubmitted),
      errors: Number(s.errors ?? 0) || 0,
      warnings: Number(s.warnings ?? 0) || 0,
    })
  }
  return out
}

export const run = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const config = searchConsoleConfig()
    if (!config) return null
    const origin = siteOrigin(config)
    const now = Date.now()
    // 1. What the sitemaps list now.
    const entries: { url: string; kind: "page" | "hub" | "society" | "event" }[] = []
    for (const file of SITEMAP_FILES) {
      const { status, text } = await fetchText(`${origin}/sitemaps/${file}?fresh=${now}`)
      // A sitemap that cannot be read now: keep yesterday's rows, try tomorrow.
      if (status !== 200) {
        console.error(`Indexing check: sitemaps/${file} answered ${status}; nothing synced`)
        return null
      }
      for (const url of sitemapUrls(text)) {
        entries.push({ url, kind: kindOf(file, new URL(url).pathname) })
      }
    }
    await ctx.runMutation(internal.indexing.sync, { entries, now })
    // 2. Our own read of the key pages.
    const keys = entries.filter((entry) => isKey(entry.kind))
    const own = await pool(keys, CONCURRENCY, async ({ url }) => {
      try {
        const { status, text } = await fetchText(url)
        return { url, problem: ownProblem(url, status, text) }
      } catch {
        return { url, problem: "did not answer" }
      }
    })
    await ctx.runMutation(internal.indexing.recordOwn, { results: own, now })
    // 3. Search Console's view of the sitemaps.
    let sitemaps: SitemapStatus[] = []
    try {
      const token = await accessToken(config, fetch, REQUEST_TIMEOUT_MS)
      sitemaps = await readSitemapStatus(config, origin, token)
    } catch (error) {
      console.error(`Indexing check: sitemap status unread (${(error as Error).message})`)
    }
    // 4. The inspections, batch by batch.
    await ctx.scheduler.runAfter(0, internal.indexing.inspectBatch, {
      budget: DAILY_BUDGET,
      inspected: 0,
      sitemaps,
    })
    return null
  },
})

export const inspectBatch = internalAction({
  args: { budget: v.number(), inspected: v.number(), sitemaps: v.array(sitemapStatus) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = searchConsoleConfig()
    if (!config) return null
    const limit = Math.min(BATCH, args.budget)
    const due = limit > 0 ? await ctx.runQuery(internal.indexing.dueRows, { limit }) : []
    let done = 0
    if (due.length > 0) {
      const token = await accessToken(config, fetch, REQUEST_TIMEOUT_MS)
      const results = await pool(due, CONCURRENCY, async (url) => {
        try {
          const response = await request(
            fetch,
            INSPECT_URL,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ inspectionUrl: url, siteUrl: config.siteUrl }),
            },
            REQUEST_TIMEOUT_MS,
          )
          if (response.status === 429) return { url, quota: true as const }
          if (!response.ok) return { url, failed: `HTTP ${response.status}` }
          const body = (await response.json()) as {
            inspectionResult?: { indexStatusResult?: Inspection }
          }
          return { url, result: body.inspectionResult?.indexStatusResult ?? {} }
        } catch (error) {
          return { url, failed: (error as Error).name }
        }
      })
      const inspected = results.flatMap((r) => ("result" in r && r.result ? [r] : []))
      await ctx.runMutation(internal.indexing.recordInspections, {
        now: Date.now(),
        results: inspected.map(({ url, result }) => ({
          url,
          verdict: result.verdict,
          coverageState: result.coverageState,
          robotsTxtState: result.robotsTxtState,
          indexingState: result.indexingState,
          pageFetchState: result.pageFetchState,
          googleCanonical: result.googleCanonical,
          lastCrawlTime: result.lastCrawlTime,
        })),
      })
      done = inspected.length
      const quota = results.some((r) => "quota" in r)
      const failed = results.filter((r) => "failed" in r).length
      if (failed) console.error(`Indexing check: ${failed} inspections failed`)
      // More to do, budget left and Google still answering: the next batch.
      if (!quota && due.length === limit && args.budget - limit > 0) {
        await ctx.scheduler.runAfter(1_000, internal.indexing.inspectBatch, {
          budget: args.budget - limit,
          inspected: args.inspected + done,
          sitemaps: args.sitemaps,
        })
        return null
      }
    }
    await ctx.runMutation(internal.indexing.finish, {
      now: Date.now(),
      inspected: args.inspected + done,
      sitemaps: args.sitemaps,
    })
    return null
  },
})

export const sync = internalMutation({
  args: {
    entries: v.array(v.object({ url: v.string(), kind: indexCheckFields.kind })),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const listed = new Map(args.entries.map((entry) => [entry.url, entry.kind]))
    const rows = await ctx.db.query("indexChecks").take(MAX_ROWS)
    for (const row of rows) {
      const kind = listed.get(row.url)
      if (kind === undefined) await ctx.db.delete(row._id)
      else if (kind !== row.kind) await ctx.db.patch(row._id, { kind })
      listed.delete(row.url)
    }
    for (const [url, kind] of listed) {
      await ctx.db.insert("indexChecks", { url, kind, listedSince: args.now })
    }
    return null
  },
})

export const recordOwn = internalMutation({
  args: {
    results: v.array(v.object({ url: v.string(), problem: v.optional(v.string()) })),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const { url, problem } of args.results) {
      const row = await ctx.db
        .query("indexChecks")
        .withIndex("by_url", (q) => q.eq("url", url))
        .unique()
      if (row) await ctx.db.patch(row._id, { ownProblem: problem, ownCheckedAt: args.now })
    }
    return null
  },
})

/** The URLs to inspect next (`selectDue`). */
export const dueRows = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("indexChecks").take(MAX_ROWS)
    return selectDue(rows, Date.now(), args.limit).map((row) => row.url)
  },
})

export const recordInspections = internalMutation({
  args: {
    now: v.number(),
    results: v.array(
      v.object({
        url: v.string(),
        verdict: v.optional(v.string()),
        coverageState: v.optional(v.string()),
        robotsTxtState: v.optional(v.string()),
        indexingState: v.optional(v.string()),
        pageFetchState: v.optional(v.string()),
        googleCanonical: v.optional(v.string()),
        lastCrawlTime: v.optional(v.string()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const result of args.results) {
      const row = await ctx.db
        .query("indexChecks")
        .withIndex("by_url", (q) => q.eq("url", result.url))
        .unique()
      if (!row) continue
      const { state, problem } = classify(result.url, result)
      const crawl = result.lastCrawlTime ? Date.parse(result.lastCrawlTime) : Number.NaN
      await ctx.db.patch(row._id, {
        checkedAt: args.now,
        state,
        problem,
        coverage: result.coverageState,
        lastCrawlAt: Number.isFinite(crawl) ? crawl : undefined,
      })
    }
    return null
  },
})

export const finish = internalMutation({
  args: { now: v.number(), inspected: v.number(), sitemaps: v.array(sitemapStatus) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("indexChecks").take(MAX_ROWS)
    const summary = summarize(rows, args.sitemaps, args.now)
    const doc = { scope: "site" as const, runAt: args.now, inspected: args.inspected, ...summary }
    const existing = await ctx.db
      .query("indexingSummaries")
      .withIndex("by_scope", (q) => q.eq("scope", "site"))
      .first()
    if (existing) await ctx.db.replace(existing._id, doc)
    else await ctx.db.insert("indexingSummaries", doc)
    console.log(
      `Indexing check: ${args.inspected} inspected, ${summary.problems.length} problems, ${summary.alerts.length} alerts`,
    )
    return null
  },
})

const { scope: _scope, ...summaryFields } = indexingSummaryFields

/** The broker overview's indexing card: the latest summary, or null. */
export const summary = query({
  args: {},
  returns: v.union(v.null(), v.object(summaryFields)),
  handler: async (ctx) => {
    await requireBrokerUser(ctx)
    const row = await ctx.db
      .query("indexingSummaries")
      .withIndex("by_scope", (q) => q.eq("scope", "site"))
      .first()
    if (!row) return null
    const { _id, _creationTime, scope, ...rest } = row
    return rest
  },
})

/** What the VPS monitor reads (`/api/pipeline/indexing/summary`): when the
 * check last ran and how many things are wrong, as counts (its Slack alert
 * carries numbers only; the overview has the URLs). */
export const monitorSummary = internalQuery({
  args: {},
  returns: v.object({
    runAt: v.union(v.number(), v.null()),
    problems: v.number(),
    sitemapIssues: v.number(),
  }),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("indexingSummaries")
      .withIndex("by_scope", (q) => q.eq("scope", "site"))
      .first()
    if (!row) return { runAt: null, problems: 0, sitemapIssues: 0 }
    const problems = Object.values(row.counts).reduce((sum, c) => sum + c.problem, 0)
    return {
      runAt: row.runAt,
      problems,
      sitemapIssues: row.sitemaps.filter((s) => s.issue).length,
    }
  },
})
