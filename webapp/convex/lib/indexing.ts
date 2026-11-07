/**
 * The daily indexing check (convex/indexing.ts; event indexing follow-up,
 * 2026-11-07): what Google says about every URL our sitemaps list, read
 * through Search Console's URL Inspection API, plus our own read of the key
 * pages, so a page that cannot be indexed is found the day it breaks rather
 * than weeks later. Pure functions here; the reads and writes are in
 * convex/indexing.ts.
 *
 * What it can and cannot do: nothing makes Google index a page. The API is
 * read-only (requesting indexing is Search Console's UI alone, a few a day),
 * and "Discovered – currently not indexed" on a new domain is Google's
 * crawl queue, not a fault. So the check separates three things:
 *  - **problems**: Google or our own read finds the page cannot be indexed
 *    as it stands (noindex, robots.txt, 404, a redirect, another canonical,
 *    a fetch error) — a bug of ours, alerted on (the VPS monitor pages);
 *  - **lagging key pages**: a page of pages.xml or a hub still not indexed
 *    `KEY_PAGE_GRACE_MS` after it was first listed — the dashboard lists
 *    them, worth a "Request indexing" by hand;
 *  - **waiting**: everything else Google has not indexed yet — counted only.
 */

export type UrlKind = "page" | "hub" | "society" | "event"
export type IndexState = "indexed" | "waiting" | "not_indexed" | "problem"

/** URL inspections a day: Search Console allows 2,000 per property (and
 * 600 a minute), and a few hundred stay free for inspections by hand. */
export const DAILY_BUDGET = 1_400
/** Inspections per action call, so each call stays well inside an action's
 * time limit; the next is scheduled by the one before. */
export const BATCH = 120
/** In flight at once. */
export const CONCURRENCY = 4
/** A page or hub is checked every day; an indexed society or event again
 * after this long, one Google has not indexed yet after `RECHECK_WAITING_MS`. */
export const RECHECK_INDEXED_MS = 10 * 24 * 60 * 60 * 1000
export const RECHECK_WAITING_MS = 2 * 24 * 60 * 60 * 1000
export const RECHECK_KEY_MS = 20 * 60 * 60 * 1000
/** A key page not indexed this long after it was first listed is "lagging". */
export const KEY_PAGE_GRACE_MS = 10 * 24 * 60 * 60 * 1000
/** A sitemap Google has not read for this long is an issue. */
export const SITEMAP_STALE_MS = 4 * 24 * 60 * 60 * 1000
/** Rows kept per list in the summary. */
export const MAX_LISTED = 25

/** The kind of a sitemap entry, by the file that lists it and its path. */
export function kindOf(file: string, path: string): UrlKind {
  if (file === "pages.xml") return "page"
  if (file === "events.xml") return "event"
  return path === "/categories" || path.startsWith("/categories/") ? "hub" : "society"
}

export function isKey(kind: UrlKind): boolean {
  return kind === "page" || kind === "hub"
}

/** The parts of a URL Inspection `indexStatusResult` the check reads. */
export type Inspection = {
  verdict?: string
  coverageState?: string
  robotsTxtState?: string
  indexingState?: string
  pageFetchState?: string
  googleCanonical?: string
  userCanonical?: string
  lastCrawlTime?: string
}

/** Coverage states that mean the page as served cannot be indexed. */
const PROBLEM_COVERAGE =
  /noindex|robots\.txt|not found|404|redirect|soft 404|server error|5xx|forbidden|403|401|duplicate|alternate page|blocked/i

function sameUrl(a: string, b: string): boolean {
  const norm = (url: string) => url.replace(/\/+$/, "")
  return norm(a) === norm(b)
}

/** Google's verdict on one URL, as the check's state, with the problem (a
 * short machine word plus what Google said) when there is one. */
export function classify(url: string, r: Inspection): { state: IndexState; problem?: string } {
  const coverage = r.coverageState ?? ""
  if (r.robotsTxtState === "DISALLOWED")
    return { state: "problem", problem: "robots.txt blocks it" }
  if (r.indexingState?.startsWith("BLOCKED_BY")) {
    return { state: "problem", problem: `noindex (${r.indexingState})` }
  }
  if (
    r.pageFetchState &&
    !["SUCCESSFUL", "PAGE_FETCH_STATE_UNSPECIFIED"].includes(r.pageFetchState)
  ) {
    return { state: "problem", problem: `fetch: ${r.pageFetchState}` }
  }
  if (r.googleCanonical && !sameUrl(r.googleCanonical, url)) {
    return { state: "problem", problem: `Google chose another canonical: ${r.googleCanonical}` }
  }
  if (r.verdict === "PASS" || /^(submitted and )?indexed/i.test(coverage))
    return { state: "indexed" }
  if (PROBLEM_COVERAGE.test(coverage)) return { state: "problem", problem: coverage }
  if (/crawled/i.test(coverage)) return { state: "not_indexed" }
  return { state: "waiting" }
}

/** Our own read of a page: answered 200, says it may be indexed, and names
 * itself as canonical. A problem, or undefined when fine. */
export function ownProblem(url: string, status: number, html: string): string | undefined {
  if (status !== 200) return `answers HTTP ${status}`
  const robots = html.match(/<meta[^>]+name="robots"[^>]+content="([^"]*)"/i)?.[1] ?? ""
  if (/noindex/i.test(robots)) return "carries noindex"
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i)?.[1]
  if (!canonical) return "has no canonical link"
  if (!sameUrl(canonical, url)) return `canonical points elsewhere: ${canonical}`
  return undefined
}

/** The paths a sitemap's `<loc>` entries name (absolute URLs kept). */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"))
}

export type CheckRow = {
  url: string
  kind: UrlKind
  listedSince: number
  checkedAt?: number
  state?: IndexState
}

/** When a row is next due: key pages daily, never-checked at once, others
 * by their state. */
export function dueAt(row: CheckRow): number {
  if (row.checkedAt === undefined) return 0
  if (isKey(row.kind)) return row.checkedAt + RECHECK_KEY_MS
  return row.checkedAt + (row.state === "indexed" ? RECHECK_INDEXED_MS : RECHECK_WAITING_MS)
}

/** The rows to inspect now, most urgent first: never checked (key pages
 * before the rest), then the longest overdue; at most `limit`. */
export function selectDue<T extends CheckRow>(rows: readonly T[], now: number, limit: number): T[] {
  return rows
    .filter((row) => dueAt(row) <= now)
    .sort((a, b) => {
      const neverA = a.checkedAt === undefined ? 0 : 1
      const neverB = b.checkedAt === undefined ? 0 : 1
      if (neverA !== neverB) return neverA - neverB
      const keyA = isKey(a.kind) ? 0 : 1
      const keyB = isKey(b.kind) ? 0 : 1
      if (keyA !== keyB) return keyA - keyB
      return dueAt(a) - dueAt(b)
    })
    .slice(0, limit)
}

export type SitemapStatus = {
  path: string
  lastDownloaded?: number
  errors: number
  warnings: number
  submitted?: number
}

/** What is wrong with one sitemap as Search Console reports it. */
export function sitemapIssue(s: SitemapStatus, now: number): string | undefined {
  if (s.errors > 0) return `${s.errors} errors`
  if (s.lastDownloaded === undefined) return "never read by Google"
  if (now - s.lastDownloaded > SITEMAP_STALE_MS) {
    return `not read for ${Math.floor((now - s.lastDownloaded) / 86_400_000)} days`
  }
  return undefined
}

export type SummaryRow = CheckRow & { problem?: string; ownProblem?: string }

export type Counts = Record<UrlKind, Record<IndexState | "unchecked", number>>

export type Summary = {
  counts: Counts
  problems: { url: string; kind: UrlKind; problem: string }[]
  lagging: { url: string; kind: UrlKind; listedSince: number; state: IndexState | "unchecked" }[]
  sitemaps: { path: string; issue?: string; lastDownloaded?: number }[]
  /** One line per thing that is wrong, for the VPS monitor's page: counts
   * and URLs of our own pages only. Empty when all is well. */
  alerts: string[]
}

const KINDS: UrlKind[] = ["page", "hub", "society", "event"]

export function summarize(
  rows: readonly SummaryRow[],
  sitemaps: readonly SitemapStatus[],
  now: number,
): Summary {
  const counts = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      { indexed: 0, waiting: 0, not_indexed: 0, problem: 0, unchecked: 0 },
    ]),
  ) as Counts
  const problems: Summary["problems"] = []
  const lagging: Summary["lagging"] = []
  for (const row of rows) {
    const own = row.ownProblem
    const state: IndexState | "unchecked" = own ? "problem" : (row.state ?? "unchecked")
    counts[row.kind][state] += 1
    const problem = own ? `our page ${own}` : row.state === "problem" ? row.problem : undefined
    if (problem) problems.push({ url: row.url, kind: row.kind, problem })
    else if (isKey(row.kind) && state !== "indexed" && now - row.listedSince > KEY_PAGE_GRACE_MS) {
      lagging.push({ url: row.url, kind: row.kind, listedSince: row.listedSince, state })
    }
  }
  // Key pages first, then by URL, so the lists are stable.
  const order = (a: { kind: UrlKind; url: string }, b: { kind: UrlKind; url: string }) =>
    Number(!isKey(a.kind)) - Number(!isKey(b.kind)) || a.url.localeCompare(b.url)
  problems.sort(order)
  lagging.sort((a, b) => a.listedSince - b.listedSince || a.url.localeCompare(b.url))
  const sitemapRows = sitemaps.map((s) => ({
    path: s.path,
    lastDownloaded: s.lastDownloaded,
    issue: sitemapIssue(s, now),
  }))
  const alerts: string[] = []
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map((p) => `${new URL(p.url).pathname} (${p.problem})`)
    alerts.push(
      `${problems.length} sitemap URL${problems.length === 1 ? "" : "s"} cannot be indexed: ${shown.join("; ")}${problems.length > 3 ? "; …" : ""}`,
    )
  }
  for (const s of sitemapRows) {
    if (s.issue) alerts.push(`sitemap ${s.path}: ${s.issue}`)
  }
  return {
    counts,
    problems: problems.slice(0, MAX_LISTED),
    lagging: lagging.slice(0, MAX_LISTED),
    sitemaps: sitemapRows,
    alerts,
  }
}
