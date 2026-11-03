/**
 * What robots.txt keeps every crawler off (app/robots.ts), and the `rel` a
 * link to such a URL carries (bot policy 2026-11-03).
 *
 * The parameter views of the dynamic pages are crawler traps: every date,
 * week count, view, preset and filter combination is a fresh server render,
 * an unbounded crawl space (GPTBot and ClaudeBot walking the calendar's
 * links used most of the Fluid CPU allowance on 1 Nov). Their canonical
 * pages stay crawlable, under Google's longest-match rule (an Allow wins a
 * tie):
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

/** Paths no crawler needs: the private broker area, the auth endpoints, the
 * sign-in page and the analytics relay (lib/relay.ts; they hold nothing for
 * a crawler). */
export const PRIVATE_PATHS: readonly string[] = ["/dashboard", "/api/", "/sign-in", "/relay"]

/** The trap patterns robots.txt disallows (Google's syntax: `*` is any run). */
export const TRAP_DISALLOWS: readonly string[] = [
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

/** The canonical parameter views inside the traps, allowed again. */
export const TRAP_ALLOWS: readonly string[] = [
  "/events?org=",
  "/societies?page=",
  "/talks?dept=",
  "/talks?school=",
]

/** Whether a robots.txt path pattern matches a URL path (with its query), as
 * Google reads one: a prefix, where `*` is any run of characters and a final
 * `$` anchors the end. */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$")
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path)
}

/** A robots.txt group's verdict on a path, by Google's rules: the longest
 * matching pattern wins, an Allow wins a tie, and no match allows. */
export function robotsGroupAllows(
  group: { allow?: string | readonly string[]; disallow?: string | readonly string[] },
  path: string,
): boolean {
  let best = { length: -1, allow: true }
  for (const [list, allow] of [
    [group.disallow, false],
    [group.allow, true],
  ] as const) {
    for (const pattern of [list ?? []].flat()) {
      if (robotsPatternMatches(pattern, path) && pattern.length >= best.length) {
        best = { length: pattern.length, allow }
      }
    }
  }
  return best.allow
}

/** The `*` group: what robots.txt asks every crawler. */
export const EVERYONE = {
  allow: TRAP_ALLOWS,
  disallow: [...PRIVATE_PATHS, ...TRAP_DISALLOWS],
} as const

/**
 * `rel="nofollow"` for a site-relative link robots.txt disallows (a trap
 * view, a preset request form, the sign-in page), else nothing. The link
 * stays a real link for readers (and for a crawler that ignores robots.txt,
 * a hint not to spend its fetch); a canonical view such as
 * `/events?org=<slug>` or `/societies?page=2` stays followed.
 */
export function crawlerTrapRel(href: string): "nofollow" | undefined {
  if (!href.startsWith("/")) return undefined
  return robotsGroupAllows(EVERYONE, href) ? undefined : "nofollow"
}

/** A link's `href` with its `rel` (`<Link {...linkProps(href)}>`). */
export function linkProps(href: string): { href: string; rel?: "nofollow" } {
  const rel = crawlerTrapRel(href)
  return rel ? { href, rel } : { href }
}
