/**
 * AI crawlers and AI-training tokens kept off the talks pillar. /talks,
 * /talks/<key>, /talks/departments, /talks/events and the .ics feeds
 * republish talks.cam and department listings, whose own robots.txt keeps
 * these agents out (talks.cam names ClaudeBot, anthropic-ai, GPTBot and CCBot
 * among others); camsocs must not become the side door (owner decision G1,
 * lib/talks-boundary.ts). Rules match by prefix, so "/talks" covers
 * "/talks.ics" and every page under /talks.
 *
 * AI-specific agents only (owner decision G6): answer engines, AI fetchers
 * and AI-training crawlers, each by the token its operator documents. General
 * search crawlers (Googlebot, Bingbot, Applebot, GoogleOther, PetalBot) are
 * not here: classic search may index the talks.
 */
export const AI_CRAWLERS: readonly string[] = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Google-CloudVertexBot",
  "Applebot-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "meta-externalfetcher",
  // Meta documents FacebookBot as crawling to train its speech-recognition
  // language models: AI training, unlike facebookexternalhit (link previews).
  "FacebookBot",
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "DuckAssistBot",
  "MistralAI-User",
  "YouBot",
  "AI2Bot",
  "Ai2Bot-Dolma",
  "Timpibot",
  "ImagesiftBot",
  "omgili",
  "omgilibot",
]

/** Whether a user agent string names one of the AI agents (a case-insensitive
 * substring, as the agents' own documentation gives their tokens). A
 * robots.txt-only token such as Google-Extended never matches a request. */
export function isAiCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  const ua = userAgent.toLowerCase()
  return AI_CRAWLERS.some((token) => ua.includes(token.toLowerCase()))
}

/** The talks pillar's paths, as robots.txt's "/talks" prefix rule reads them. */
export function isTalksPath(pathname: string): boolean {
  return pathname.startsWith("/talks")
}

/**
 * Whether the proxy refuses this request with a 403: an AI agent asking for
 * the talks pillar. robots.txt asks them to stay out, but user-triggered
 * fetchers (ChatGPT-User, Perplexity-User…) do not all read it, and talks.cam
 * keeps them out. Enforced in proxy.ts, which on Vercel runs before the edge
 * cache, so a cached `/talks.ics` is refused too.
 */
export function refusesAiAgent(pathname: string, userAgent: string | null | undefined): boolean {
  return isTalksPath(pathname) && isAiCrawler(userAgent)
}
