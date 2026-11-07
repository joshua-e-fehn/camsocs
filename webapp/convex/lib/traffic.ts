/**
 * Website traffic for the broker overview: aggregate numbers read from
 * PostHog's query API and Google Search Console's Search Analytics API by
 * `convex/traffic.ts`, folded into one `trafficSnapshots` row. Pure but for
 * `fetch`, so the tests stub the network.
 *
 * What it reads, and what it never does:
 *
 *  - **PostHog** (HogQL over `$pageview`, the project's internal/test filter
 *    on, this deployment's campus only): unique visitors, pageviews and
 *    sessions, per day and in total; sessions by the domain they entered from;
 *    pageviews by path. Browser events exist only for visitors who accepted
 *    analytics, so every number undercounts (docs/analytics.md). Paths and
 *    domains are all it returns: no person, no device, no title. Besides,
 *    the server's own `page_visit` count (every browser page load, no
 *    consent needed: lib/visit-count.ts) per day, by kind of source and by
 *    kind of page.
 *  - **Search Console** (the property `GSC_SITE_URL`, else `SITE_URL` + "/"):
 *    clicks, impressions, CTR and average position in Google Search, in total,
 *    per day, by search query and by page. Google aggregates them and leaves
 *    out rare ("anonymised") queries.
 *  - Each source is off until its env vars are set (production only), and a
 *    failure is reported as a short reason (an HTTP status, an OAuth error
 *    code, PostHog's one-line `detail`), never a response body or a key.
 *
 * Credentials (Convex env, `bunx convex env set --prod …`; docs/deploy.md
 * "Website traffic"):
 *
 *   POSTHOG_PERSONAL_API_KEY   a personal key with `query:read`, scoped to the project
 *   POSTHOG_PROJECT_ID         the project's id (330133 for Cambridge)
 *   POSTHOG_APP_HOST           optional, default https://eu.posthog.com
 *   GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN
 *                              an OAuth client and a refresh token granted
 *                              `webmasters.readonly` by a user of the property
 *   GSC_SITE_URL               optional, the property (default SITE_URL + "/")
 *
 * ⚠ Never log a key, a token or a request body.
 */

import { deploymentCampus } from "../../lib/campus/deployment"
import { DAY_MS, londonIsoDate } from "./derived"

type Env = Record<string, string | undefined>

/** PostHog's window: the last 30 days, and the 7 inside it. */
export const POSTHOG_WINDOW_DAYS = 30
/** Search Console's window: 28 days ending yesterday (Google's default). */
export const GSC_WINDOW_DAYS = 28
/** Rows kept per breakdown (referrers, pages, search queries). */
export const TOP_ROWS = 15
/** Search queries kept (the card shows them all, scrollable). */
export const TOP_QUERIES = 25
/** How long one request may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 20_000
/** The longest text kept for a domain, path or search query. */
export const MAX_LABEL = 200

export const DEFAULT_POSTHOG_APP_HOST = "https://eu.posthog.com"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3"

// --- configuration ----------------------------------------------------------------------

export type PostHogQueryConfig = { key: string; projectId: string; appHost: string }

/** PostHog's query settings, or null when they are not all set. Read per
 * call, so setting the env vars takes effect without a deploy. */
export function posthogQueryConfig(env: Env = process.env): PostHogQueryConfig | null {
  const key = env.POSTHOG_PERSONAL_API_KEY?.trim()
  const projectId = env.POSTHOG_PROJECT_ID?.trim()
  if (!key || !projectId || !/^\d+$/.test(projectId)) return null
  const appHost = (env.POSTHOG_APP_HOST?.trim() || DEFAULT_POSTHOG_APP_HOST).replace(/\/+$/, "")
  return { key, projectId, appHost }
}

export type SearchConsoleConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
  siteUrl: string
}

/** Search Console's settings, or null when they are not all set. */
export function searchConsoleConfig(env: Env = process.env): SearchConsoleConfig | null {
  const clientId = env.GSC_CLIENT_ID?.trim()
  const clientSecret = env.GSC_CLIENT_SECRET?.trim()
  const refreshToken = env.GSC_REFRESH_TOKEN?.trim()
  const site = env.GSC_SITE_URL?.trim() || (env.SITE_URL?.trim() ? `${env.SITE_URL.trim()}` : "")
  if (!clientId || !clientSecret || !refreshToken || !site) return null
  // A URL-prefix property ends in "/"; a domain property is "sc-domain:…".
  const siteUrl = site.startsWith("sc-domain:") || site.endsWith("/") ? site : `${site}/`
  return { clientId, clientSecret, refreshToken, siteUrl }
}

// --- shapes -----------------------------------------------------------------------------

export type PostHogTraffic = {
  windowDays: number
  visitors: number
  visitors7d: number
  pageviews: number
  pageviews7d: number
  sessions: number
  daily: { day: string; visitors: number; pageviews: number }[]
  referrers: { domain: string; sessions: number; visitors: number }[]
  pages: { path: string; pageviews: number; visitors: number }[]
  serverVisits?: ServerVisits
}

/** The server's `page_visit` count (lib/visit-count.ts) over the window. */
export type ServerVisits = {
  visits: number
  visits7d: number
  daily: { day: string; visits: number }[]
  sources: { source: string; visits: number; visits7d: number }[]
  pages: { page: string; visits: number; visits7d: number }[]
}

export type SearchRow = { clicks: number; impressions: number; ctr: number; position: number }

export type SearchConsoleTraffic = SearchRow & {
  siteUrl: string
  startDate: string
  endDate: string
  daily: ({ day: string } & SearchRow)[]
  queries: ({ query: string } & SearchRow)[]
  pages: ({ path: string } & SearchRow)[]
}

/** One source's outcome: its data, or why there is none this time. */
export type SourceResult<T> =
  | { status: "ok"; data: T }
  | { status: "not_configured" }
  | { status: "failed"; error: string }

export class TrafficSourceError extends Error {
  override name = "TrafficSourceError"
}

// --- helpers ----------------------------------------------------------------------------

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function label(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value)
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}

/** A short, secret-free reason for a failed request. */
export function failureReason(error: unknown): string {
  if (error instanceof TrafficSourceError) return error.message
  if (error instanceof Error && error.name === "AbortError") return "timed out"
  return error instanceof Error ? error.name : typeof error
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** `{ detail }` (PostHog) or `{ error: { message } }` / `{ error }` (Google),
 * one line and short; never the whole body. */
async function errorDetail(response: Response): Promise<string> {
  let detail = ""
  try {
    const body = (await response.json()) as Record<string, unknown>
    const error = body.error
    detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof error === "string"
          ? error
          : typeof (error as { message?: unknown } | undefined)?.message === "string"
            ? String((error as { message: string }).message)
            : ""
  } catch {
    // not JSON
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 160)
  return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`
}

// --- PostHog ----------------------------------------------------------------------------

/** Every query's condition: pageviews of this deployment's campus (an event
 * sent before `campus` existed is Cambridge's), with PostHog's date range and
 * the project's internal/test filter applied through `{filters}`. `{campus}`
 * is replaced by `hogqlBody` with a quoted campus id (PostHog's own `values`
 * placeholders cannot be combined with `{filters}`). */
const PAGEVIEWS =
  "event = '$pageview' AND ifNull(properties.campus, 'cam') = {campus} AND {filters}"

/** The server's `page_visit` events (proxy.ts, lib/visit-count.ts): every
 * browser page load, consent or not, as two enums. Server events carry
 * `environment`, so the internal/test filter applies to them as well. */
const VISITS = "event = 'page_visit' AND ifNull(properties.campus, 'cam') = {campus} AND {filters}"

export const POSTHOG_QUERIES = {
  totals:
    "SELECT uniq(person_id), uniqIf(person_id, timestamp >= now() - INTERVAL 7 DAY)," +
    " count(), countIf(timestamp >= now() - INTERVAL 7 DAY), uniq(properties.$session_id)" +
    ` FROM events WHERE ${PAGEVIEWS}`,
  daily:
    "SELECT toString(toDate(toTimeZone(timestamp, 'Europe/London'))) AS day," +
    " uniq(person_id) AS visitors, count() AS pageviews" +
    ` FROM events WHERE ${PAGEVIEWS} GROUP BY day ORDER BY day`,
  referrers:
    "SELECT coalesce(nullIf(toString(properties.$session_entry_referring_domain), ''), '$direct')" +
    " AS domain, uniq(properties.$session_id) AS sessions, uniq(person_id) AS visitors" +
    ` FROM events WHERE ${PAGEVIEWS} GROUP BY domain ORDER BY sessions DESC, domain LIMIT ${TOP_ROWS}`,
  pages:
    "SELECT coalesce(toString(properties.$pathname), '') AS path, count() AS pageviews," +
    " uniq(person_id) AS visitors" +
    ` FROM events WHERE ${PAGEVIEWS} GROUP BY path ORDER BY pageviews DESC, path LIMIT ${TOP_ROWS}`,
  visitsDaily:
    "SELECT toString(toDate(toTimeZone(timestamp, 'Europe/London'))) AS day, count() AS visits" +
    ` FROM events WHERE ${VISITS} GROUP BY day ORDER BY day`,
  visitsBySource:
    "SELECT coalesce(nullIf(toString(properties.source), ''), 'direct') AS source, count() AS visits," +
    " countIf(timestamp >= now() - INTERVAL 7 DAY) AS visits7d" +
    ` FROM events WHERE ${VISITS} GROUP BY source ORDER BY visits DESC, source LIMIT ${TOP_ROWS}`,
  visitsByPage:
    "SELECT coalesce(nullIf(toString(properties.page), ''), 'other') AS page, count() AS visits," +
    " countIf(timestamp >= now() - INTERVAL 7 DAY) AS visits7d" +
    ` FROM events WHERE ${VISITS} GROUP BY page ORDER BY visits DESC, page LIMIT ${TOP_ROWS}`,
} as const

/** The body of one HogQL query over the last `POSTHOG_WINDOW_DAYS` days. A
 * campus id is a short lower-case code (lib/campus), so it is safe to quote;
 * anything else is refused. */
export function hogqlBody(query: string, campus: string) {
  if (!/^[a-z]{2,12}$/.test(campus)) throw new TrafficSourceError("bad campus id")
  return {
    query: {
      kind: "HogQLQuery",
      query: query.replaceAll("{campus}", `'${campus}'`),
      filters: {
        dateRange: { date_from: `-${POSTHOG_WINDOW_DAYS}d` },
        filterTestAccounts: true,
      },
    },
    name: "camsocs broker overview traffic",
  }
}

async function hogql(
  config: PostHogQueryConfig,
  query: string,
  campus: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown[][]> {
  const response = await request(
    fetchImpl,
    `${config.appHost}/api/projects/${config.projectId}/query/`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(hogqlBody(query, campus)),
    },
    timeoutMs,
  )
  if (!response.ok) throw new TrafficSourceError(await errorDetail(response))
  const body = (await response.json()) as { results?: unknown }
  if (!Array.isArray(body.results)) throw new TrafficSourceError("unexpected response")
  return body.results.filter(Array.isArray) as unknown[][]
}

/** PostHog's numbers for the deployment's campus. Four HogQL queries, run
 * together; any failure fails the source. */
export async function fetchPostHogTraffic(
  config: PostHogQueryConfig,
  fetchImpl: typeof fetch = fetch,
  campus: string = deploymentCampus(),
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<PostHogTraffic> {
  const run = (query: string) => hogql(config, query, campus, fetchImpl, timeoutMs)
  const [totals, daily, referrers, pages, visitsDaily, visitsBySource, visitsByPage] =
    await Promise.all([
      run(POSTHOG_QUERIES.totals),
      run(POSTHOG_QUERIES.daily),
      run(POSTHOG_QUERIES.referrers),
      run(POSTHOG_QUERIES.pages),
      run(POSTHOG_QUERIES.visitsDaily),
      run(POSTHOG_QUERIES.visitsBySource),
      run(POSTHOG_QUERIES.visitsByPage),
    ])
  const visitSources = visitsBySource.map(([source, n, n7]) => ({
    source: label(source) || "direct",
    visits: num(n),
    visits7d: num(n7),
  }))
  const [visitors, visitors7d, pageviews, pageviews7d, sessions] = (totals[0] ?? []).map(num)
  return {
    windowDays: POSTHOG_WINDOW_DAYS,
    visitors: visitors ?? 0,
    visitors7d: visitors7d ?? 0,
    pageviews: pageviews ?? 0,
    pageviews7d: pageviews7d ?? 0,
    sessions: sessions ?? 0,
    daily: daily
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row[0])))
      .map(([day, v, p]) => ({ day: String(day), visitors: num(v), pageviews: num(p) })),
    referrers: referrers.map(([domain, s, v]) => ({
      domain: label(domain) || "$direct",
      sessions: num(s),
      visitors: num(v),
    })),
    pages: pages.map(([path, p, v]) => ({
      path: label(path) || "(unknown)",
      pageviews: num(p),
      visitors: num(v),
    })),
    serverVisits: {
      visits: visitSources.reduce((sum, row) => sum + row.visits, 0),
      visits7d: visitSources.reduce((sum, row) => sum + row.visits7d, 0),
      daily: visitsDaily
        .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row[0])))
        .map(([day, n]) => ({ day: String(day), visits: num(n) })),
      sources: visitSources,
      pages: visitsByPage.map(([page, n, n7]) => ({
        page: label(page) || "other",
        visits: num(n),
        visits7d: num(n7),
      })),
    },
  }
}

// --- Search Console ---------------------------------------------------------------------

/** The window Search Console is asked for: `GSC_WINDOW_DAYS` days ending
 * yesterday (London), inclusive. */
export function searchConsoleWindow(now: number): { startDate: string; endDate: string } {
  return {
    startDate: londonIsoDate(now - GSC_WINDOW_DAYS * DAY_MS),
    endDate: londonIsoDate(now - DAY_MS),
  }
}

/** A short-lived access token from the stored refresh token. */
async function accessToken(
  config: SearchConsoleConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const response = await request(
    fetchImpl,
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }).toString(),
    },
    timeoutMs,
  )
  if (!response.ok) throw new TrafficSourceError(`token ${await errorDetail(response)}`)
  const body = (await response.json()) as { access_token?: unknown }
  if (typeof body.access_token !== "string") throw new TrafficSourceError("token: no access_token")
  return body.access_token
}

type GscRow = {
  keys?: unknown[]
  clicks?: unknown
  impressions?: unknown
  ctr?: unknown
  position?: unknown
}

function searchRow(row: GscRow): SearchRow {
  return {
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: num(row.ctr),
    position: num(row.position),
  }
}

/** A page URL of the property as a path ("/societies/…"), else the URL. */
export function pagePath(url: string, siteUrl: string): string {
  try {
    const page = new URL(url)
    if (!siteUrl.startsWith("sc-domain:") && page.origin !== new URL(siteUrl).origin)
      return label(url)
    return label(`${page.pathname}${page.search}`)
  } catch {
    return label(url)
  }
}

/** Search Console's numbers for the property: totals, per day, by query and
 * by page, over `searchConsoleWindow(now)` with fresh (not yet final) data. */
export async function fetchSearchConsoleTraffic(
  config: SearchConsoleConfig,
  now: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<SearchConsoleTraffic> {
  const token = await accessToken(config, fetchImpl, timeoutMs)
  const window = searchConsoleWindow(now)
  const url = `${GSC_API}/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`
  const run = async (dimensions: string[], rowLimit: number): Promise<GscRow[]> => {
    const response = await request(
      fetchImpl,
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...window, dimensions, rowLimit, dataState: "all", type: "web" }),
      },
      timeoutMs,
    )
    if (!response.ok) throw new TrafficSourceError(await errorDetail(response))
    const body = (await response.json()) as { rows?: unknown }
    return Array.isArray(body.rows) ? (body.rows as GscRow[]) : []
  }
  const [totals, daily, queries, pages] = await Promise.all([
    run([], 1),
    run(["date"], GSC_WINDOW_DAYS + 5),
    run(["query"], TOP_QUERIES),
    run(["page"], TOP_ROWS),
  ])
  const key = (row: GscRow) => label(Array.isArray(row.keys) ? row.keys[0] : "")
  return {
    siteUrl: config.siteUrl,
    ...window,
    ...(totals[0] ? searchRow(totals[0]) : { clicks: 0, impressions: 0, ctr: 0, position: 0 }),
    daily: daily
      .map((row) => ({ day: key(row), ...searchRow(row) }))
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day))
      .sort((a, b) => a.day.localeCompare(b.day)),
    queries: queries.map((row) => ({ query: key(row), ...searchRow(row) })),
    pages: pages.map((row) => ({ path: pagePath(key(row), config.siteUrl), ...searchRow(row) })),
  }
}

// --- both -------------------------------------------------------------------------------

/** One source, run if configured, its failure caught. */
export async function readSource<C, T>(
  config: C | null,
  read: (config: C) => Promise<T>,
): Promise<SourceResult<T>> {
  if (!config) return { status: "not_configured" }
  try {
    return { status: "ok", data: await read(config) }
  } catch (error) {
    return { status: "failed", error: failureReason(error) }
  }
}
