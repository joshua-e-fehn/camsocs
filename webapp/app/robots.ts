import type { MetadataRoute } from "next"
import { AI_CRAWLERS, SCRAPERS } from "@/lib/crawlers"
import { SITE_URL } from "@/lib/site"

/** Paths no crawler needs: the private broker area, the auth endpoints, the
 * sign-in page and the analytics relay (lib/relay.ts; they hold nothing for
 * a crawler). */
const PRIVATE = ["/dashboard", "/api/", "/sign-in", "/relay"]

/**
 * Crawler traps (bot policy 2026-11-03): the parameter views of the dynamic
 * pages, an unbounded crawl space (every date, week count, view, preset and
 * filter combination is a fresh server render). Their canonical pages stay
 * crawlable, with Google's longest-match rule (an Allow wins a tie):
 *  - `/events` and one society's calendar, `/events?org=<slug>` alone
 *    (lib/url-state.ts `eventsIndexing`; `org` serialises after every key
 *    but `external`, `university` and `event`, so a later `&` is a slice);
 *  - `/societies` and its pages, `/societies?page=N` (lib/directory-hubs.ts
 *    `directorySeo`; a one-category or one-college view canonicalises to its
 *    hub, `/categories/<slug>` or `/societies/<college>`, crawlable as is);
 *  - `/talks`, `/talks?dept=<slug>` and `/talks?school=<school>` alone
 *    (lib/talks-url-state.ts `talksIndexing`);
 *  - `/request` and `/talks/departments` bare (their parameter views
 *    canonicalise to them).
 * Event pages stay discoverable through the sitemap (sitemaps/events.xml),
 * society profiles and the canonical calendars. Next's RSC fetches of these
 * pages (`?_rsc=`) are disallowed with them: a crawler never needs one to
 * render a page, whose HTML carries everything.
 */
const TRAPS = [
  "/events?",
  "/events?org=*&",
  "/events/*/ics",
  "/societies?",
  "/societies?page=*&",
  "/request?",
  "/talks?",
  "/talks?dept=*&",
  "/talks?school=*&",
  "/talks/departments?",
]
const TRAP_ALLOWS = ["/events?org=", "/societies?page=", "/talks?dept=", "/talks?school="]

/**
 * Who may crawl what (bot policy 2026-11-03, lib/crawlers.ts):
 *  - everyone else (`*`, search engines included): everything public but the
 *    traps;
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
      { userAgent: "*", allow: TRAP_ALLOWS, disallow: [...PRIVATE, ...TRAPS] },
      {
        userAgent: [...AI_CRAWLERS],
        allow: TRAP_ALLOWS.filter((path) => !path.startsWith("/talks")),
        disallow: [...PRIVATE, "/talks", ...TRAPS.filter((path) => !path.startsWith("/talks"))],
      },
      { userAgent: [...SCRAPERS], disallow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
