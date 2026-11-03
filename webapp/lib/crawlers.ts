/**
 * The crawler policy (bot policy 2026-11-03, owner-approved steps 1 and 2),
 * by tier. Each agent is named by the token its operator documents.
 *
 *  - T0 crawler control files (/robots.txt, /llms.txt) are reachable by
 *    everyone (ops/vercel/control-files-bypass.json).
 *  - T1 AI search and index crawlers and T2 user-triggered AI fetchers may
 *    read every canonical public page.
 *  - T3 AI training crawlers may too (step 2: GPTBot and ClaudeBot left the
 *    site-wide block of 2026-11-01), but the Vercel firewall keeps them on
 *    edge-cached pages (ops/vercel/training-crawlers.json): their hammering
 *    of /events, whose calendar parameter URLs are an unbounded crawl space,
 *    used most of the Fluid CPU allowance on 1 Nov.
 *  - None of T1-T3 may read the talks pillar. /talks, /talks/<key>,
 *    /talks/departments, /talks/events and the .ics feeds republish
 *    talks.cam and department listings, whose own robots.txt keeps these
 *    agents out (talks.cam names ClaudeBot, anthropic-ai, GPTBot and CCBot
 *    among others); camsocs must not become the side door (owner decision
 *    G1, lib/talks-boundary.ts). Rules match by prefix, so "/talks" covers
 *    "/talks.ics" and every page under /talks.
 *  - T4 SEO-tool and commercial scrapers may read nothing (robots.txt
 *    `Disallow: /`, and the firewall denies them).
 *
 * General search crawlers (Googlebot, Bingbot, Applebot, GoogleOther) are in
 * no list: they keep the `*` group (owner decision G6), talks included.
 */

/** T1: AI search and answer-engine indexers. */
export const AI_SEARCH_CRAWLERS: readonly string[] = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "PerplexityBot",
  // Meta AI's search index; meta-externalagent is the training crawler.
  "meta-webindexer",
  "Amzn-SearchBot",
  "MistralAI-Index",
  "DuckAssistBot",
  "YouBot",
]

/** T2: fetchers acting on one user's request (they may not all read
 * robots.txt, hence the proxy's 403 on /talks). */
export const AI_USER_AGENTS: readonly string[] = [
  "ChatGPT-User",
  "Claude-User",
  "Perplexity-User",
  "Amzn-User",
  "MistralAI-User",
  "meta-externalfetcher",
  "cohere-ai",
  // Fetches a site for a Vertex AI customer's agent.
  "Google-CloudVertexBot",
]

/** T3: AI-training crawlers and opt-out tokens. Google-Extended and
 * Applebot-Extended are robots.txt-only tokens: no request carries them. */
export const AI_TRAINING_CRAWLERS: readonly string[] = [
  "GPTBot",
  "ClaudeBot",
  // Anthropic's retired tokens, still honoured as opt-outs.
  "anthropic-ai",
  "Claude-Web",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  // Meta documents FacebookBot as crawling to train its speech-recognition
  // language models: AI training, unlike facebookexternalhit (link previews).
  "FacebookBot",
  "cohere-training-data-crawler",
  "MistralAI-Training",
  "AI2Bot",
  "Ai2Bot-Dolma",
  "Timpibot",
  "omgili",
  "omgilibot",
]

/** T1-T3: every AI agent, the group robots.txt keeps off /talks and the
 * proxy refuses there. */
export const AI_CRAWLERS: readonly string[] = [
  ...AI_SEARCH_CRAWLERS,
  ...AI_USER_AGENTS,
  ...AI_TRAINING_CRAWLERS,
]

/** T4: SEO-tool and commercial scrapers, kept off the whole site. Bytespider,
 * Diffbot and ImagesiftBot (AI-adjacent, but bulk data resellers that ignore
 * crawl budgets) moved here from the AI list (bot policy 2026-11-03). */
export const SCRAPERS: readonly string[] = [
  "AhrefsBot",
  "SemrushBot",
  "DotBot",
  "MJ12bot",
  "DataForSeoBot",
  "Dataprovider.com",
  "BLEXBot",
  "Barkrowler",
  "PetalBot",
  "ImagesiftBot",
  "Diffbot",
  "Bytespider",
]

function matchesAny(tokens: readonly string[], userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  const ua = userAgent.toLowerCase()
  return tokens.some((token) => ua.includes(token.toLowerCase()))
}

/** Whether a user agent string names one of the AI agents (a case-insensitive
 * substring, as the agents' own documentation gives their tokens). A
 * robots.txt-only token such as Google-Extended never matches a request. */
export function isAiCrawler(userAgent: string | null | undefined): boolean {
  return matchesAny(AI_CRAWLERS, userAgent)
}

/** Whether a user agent string names one of the T4 scrapers. */
export function isScraper(userAgent: string | null | undefined): boolean {
  return matchesAny(SCRAPERS, userAgent)
}

/** The talks pillar's paths, as robots.txt's "/talks" prefix rule reads them. */
export function isTalksPath(pathname: string): boolean {
  return pathname.startsWith("/talks")
}

/**
 * Whether the proxy refuses this request with a 403: an AI agent (or a T4
 * scraper, which may read nothing) asking for the talks pillar. robots.txt
 * asks them to stay out, but user-triggered fetchers (ChatGPT-User,
 * Perplexity-User…) do not all read it, and talks.cam keeps them out.
 * Enforced in proxy.ts, which on Vercel runs before the edge cache, so a
 * cached `/talks.ics` is refused too.
 */
export function refusesAiAgent(pathname: string, userAgent: string | null | undefined): boolean {
  return isTalksPath(pathname) && (isAiCrawler(userAgent) || isScraper(userAgent))
}
