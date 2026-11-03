import type { MetadataRoute } from "next"
import { EVERYONE, PRIVATE_PATHS, TRAP_ALLOWS, TRAP_DISALLOWS } from "@/lib/crawl-traps"
import { AI_CRAWLERS, SCRAPERS } from "@/lib/crawlers"
import { SITE_URL } from "@/lib/site"

/**
 * Who may crawl what (bot policy 2026-11-03, lib/crawlers.ts):
 *  - everyone (`*`, search engines included): everything public but the
 *    parameter traps (lib/crawl-traps.ts, which also gives links to them
 *    `rel="nofollow"`);
 *  - AI agents (T1 search, T2 user-triggered, T3 training; GPTBot and
 *    ClaudeBot are back after the 1 Nov CPU incident, kept on edge-cached
 *    pages by the Vercel firewall): the same, and never the talks pillar
 *    (owner decision G1);
 *  - T4 SEO-tool and commercial scrapers: nothing.
 * A crawler that matches a named group ignores the `*` group, so the AI
 * group repeats the private paths and the traps. No `Allow: /`: everything
 * not disallowed is allowed, and a parser that takes the first matching line
 * (not Google's longest match) would read it as allowing every trap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: [...EVERYONE.allow], disallow: [...EVERYONE.disallow] },
      {
        userAgent: [...AI_CRAWLERS],
        allow: TRAP_ALLOWS.filter((path) => !path.startsWith("/talks")),
        disallow: [
          ...PRIVATE_PATHS,
          "/talks",
          ...TRAP_DISALLOWS.filter((path) => !path.startsWith("/talks")),
        ],
      },
      { userAgent: [...SCRAPERS], disallow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
