import { isAiCrawler, isScraper } from "./crawlers"

/**
 * The server's visit count (2026-11-07): one `page_visit` server event
 * (lib/posthog-server.ts `SERVER_EVENTS`) per page a browser loads from our
 * server, sent by the proxy (proxy.ts) with two enums and nothing else — the
 * kind of page and the kind of site the visitor came from.
 *
 * Why: browser analytics exists only for visitors who accept it (PECR), so
 * PostHog's pageviews undercount by an unknown factor; Search Console showed
 * a dozen Google clicks a day that PostHog never saw. This count needs no
 * consent because nothing is stored on or read from the visitor's device: it
 * is our server noting that it served a page (legitimate interests, record of
 * processing P12, the privacy notice's "anonymous counts from our servers").
 * No IP address, user agent, cookie, path, query string or full referrer is
 * sent: the referrer is reduced here to one of `VISIT_SOURCES`.
 *
 * What counts as a visit: a top-level page load a browser makes
 * (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`), so prefetches,
 * client-side navigations (RSC requests), feeds, images and API calls do not,
 * and nor do most bots (crawlers rarely send Fetch Metadata) or the ones that
 * name themselves. A visitor who then clicks around inside the site is one
 * visit, plus one per full page load: closer to "entries" than to pageviews.
 */

export const VISIT_PAGES = [
  "home",
  "societies",
  "society",
  "categories",
  "events",
  "event",
  "talks",
  "term_dates",
  "colleges",
  "finder",
  "guides",
  "info",
  "other",
] as const
export type VisitPage = (typeof VISIT_PAGES)[number]

export const VISIT_SOURCES = [
  "google",
  "bing",
  "other_search",
  "ai_assistant",
  "social",
  "cambridge",
  "internal",
  "direct",
  "other_site",
] as const
export type VisitSource = (typeof VISIT_SOURCES)[number]

export type VisitFacts = { page: VisitPage; source: VisitSource }

/** Never counted: the private areas (hard rule 3) and machinery. */
const UNCOUNTED = /^\/(dashboard|sign-in|api|relay|_next|monitoring)(\/|$)/

const INFO_PAGES = new Set(["/about", "/privacy", "/terms", "/request"])

/** The kind of page a path is (no key, slug or query survives). */
export function visitPage(pathname: string): VisitPage {
  const path = pathname.replace(/\/+$/, "") || "/"
  if (path === "/") return "home"
  if (path === "/societies") return "societies"
  if (path.startsWith("/societies/")) return "society"
  if (path === "/categories" || path.startsWith("/categories/") || path.startsWith("/for/"))
    return "categories"
  if (path === "/events") return "events"
  if (path.startsWith("/events/")) return "event"
  if (path === "/finder" || path.startsWith("/finder/") || path === "/talks/finder") return "finder"
  if (path === "/talks" || path.startsWith("/talks/")) return "talks"
  if (path === "/term-dates") return "term_dates"
  if (path === "/colleges") return "colleges"
  if (path === "/guides" || path.startsWith("/guides/")) return "guides"
  if (INFO_PAGES.has(path)) return "info"
  return "other"
}

const OTHER_SEARCH =
  /(^|\.)(duckduckgo\.com|ecosia\.org|search\.yahoo\.com|yandex\.[a-z.]+|baidu\.com|search\.brave\.com|startpage\.com|qwant\.com|kagi\.com)$/
const AI_ASSISTANTS =
  /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com)$/
const SOCIAL =
  /(^|\.)(instagram\.com|facebook\.com|fb\.com|linkedin\.com|lnkd\.in|x\.com|twitter\.com|t\.co|reddit\.com|whatsapp\.com|wa\.me|tiktok\.com|threads\.net|bsky\.app|linktr\.ee|discord\.com|t\.me)$/
const CAMBRIDGE = /(^|\.)(cam\.ac\.uk|cambridgesu\.co\.uk)$/

/** The kind of site a `Referer` names; `siteHost` is our own host. */
export function visitSource(referer: string | null | undefined, siteHost: string): VisitSource {
  if (!referer) return "direct"
  let host: string
  try {
    host = new URL(referer).hostname.toLowerCase()
  } catch {
    return "direct"
  }
  if (host === siteHost.toLowerCase() || host === `www.${siteHost.toLowerCase()}`) return "internal"
  // Gemini first: it lives under google.com.
  if (AI_ASSISTANTS.test(host)) return "ai_assistant"
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return "google"
  if (/(^|\.)bing\.com$/.test(host)) return "bing"
  if (OTHER_SEARCH.test(host)) return "other_search"
  if (SOCIAL.test(host)) return "social"
  if (CAMBRIDGE.test(host)) return "cambridge"
  return "other_site"
}

/**
 * The facts of one visit, or null when the request is not one (see the module
 * comment): not a GET, not a browser's top-level navigation, a prefetch, a
 * self-declared crawler or scraper, or a private or machinery path.
 */
export function visitFacts(request: {
  method: string
  pathname: string
  headers: Headers
  siteHost: string
}): VisitFacts | null {
  const { headers } = request
  if (request.method !== "GET") return null
  if (UNCOUNTED.test(request.pathname)) return null
  if (headers.get("sec-fetch-mode") !== "navigate") return null
  if (headers.get("sec-fetch-dest") !== "document") return null
  if (
    /prefetch|prerender/i.test(`${headers.get("sec-purpose") ?? ""}${headers.get("purpose") ?? ""}`)
  ) {
    return null
  }
  const userAgent = headers.get("user-agent")
  if (
    !userAgent ||
    isAiCrawler(userAgent) ||
    isScraper(userAgent) ||
    /bot|crawl|spider|slurp|headless/i.test(userAgent)
  ) {
    return null
  }
  return {
    page: visitPage(request.pathname),
    source: visitSource(headers.get("referer"), request.siteHost),
  }
}
