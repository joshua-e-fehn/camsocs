import type { MetadataRoute } from "next"
import {
  EVERYONE,
  PRIVATE_PATHS,
  TRAINING_DISALLOWS,
  TRAP_ALLOWS,
  TRAP_DISALLOWS,
} from "@/lib/crawl-traps"
import { AI_SEARCH_CRAWLERS, AI_TRAINING_CRAWLERS, AI_USER_AGENTS, SCRAPERS } from "@/lib/crawlers"
import { SITE_URL } from "@/lib/site"

/**
 * Who may crawl what (bot policy 2026-11-03, lib/crawlers.ts):
 *  - everyone (`*`, search engines included): everything public but the
 *    parameter traps (lib/crawl-traps.ts, which also gives links to them
 *    `rel="nofollow"`);
 *  - T1 AI search and T2 user-triggered agents: the same, and never the
 *    talks pillar (owner decision G1);
 *  - T3 training crawlers (GPTBot and ClaudeBot are back after the 1 Nov CPU
 *    incident): the edge-cached public pages only, never the talks pillar,
 *    the pages rendered per request or a URL with a query, the same set the
 *    Vercel firewall denies them (`TRAINING_DISALLOWS`);
 *  - T4 SEO-tool and commercial scrapers: nothing.
 * A crawler that matches a named group ignores the `*` group, so the AI
 * groups repeat the private paths. No `Allow: /`: everything not disallowed
 * is allowed. Google and Bing take the longest match (RFC 9309); a parser
 * that takes the first matching line instead still reads the remaining
 * canonical Allows (`/events?org=`, `/societies?page=`, `/talks?dept=`,
 * `/talks?school=`) as allowing their `…&…` slices, since Next writes every
 * Allow before the Disallows. Accepted: the T3 group has no Allow, and the
 * firewall holds the line there.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: [...EVERYONE.allow], disallow: [...EVERYONE.disallow] },
      {
        userAgent: [...AI_SEARCH_CRAWLERS, ...AI_USER_AGENTS],
        allow: TRAP_ALLOWS.filter((path) => !path.startsWith("/talks")),
        disallow: [
          ...PRIVATE_PATHS,
          "/talks",
          ...TRAP_DISALLOWS.filter((path) => !path.startsWith("/talks")),
        ],
      },
      { userAgent: [...AI_TRAINING_CRAWLERS], disallow: [...TRAINING_DISALLOWS] },
      { userAgent: [...SCRAPERS], disallow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
