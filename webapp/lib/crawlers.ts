/**
 * AI crawlers and AI-training tokens kept off the talks pillar. /talks,
 * /talks/<key>, /talks/departments and the .ics feeds republish talks.cam
 * and department listings, whose own robots.txt keeps these agents out
 * (talks.cam names ClaudeBot, anthropic-ai, GPTBot and CCBot among others);
 * camsocs must not become the side door. Rules match by prefix, so "/talks"
 * covers "/talks.ics" and every page under /talks.
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
  "Applebot-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "Diffbot",
]
