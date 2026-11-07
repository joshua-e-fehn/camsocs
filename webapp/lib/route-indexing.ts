/**
 * How every public page route reaches search engines (indexing guard,
 * 2026-11-07): which sitemap lists it, or why none does, and for a single
 * page, which page links it. `lib/route-indexing.test.ts` reads the
 * `app/(site)` tree and fails when a `page.tsx` is missing here, so a new
 * page cannot ship without a decision about its indexing: on 7 Nov the new
 * /colleges and /guides pages and several older ones (/terms, /categories)
 * were still unknown to Google.
 *
 * Adding a page:
 *  - indexable, one URL: `{ sitemap: "pages.xml", linkedFrom }` and the
 *    path in `PAGE_PATHS` (lib/sitemap.ts; the test checks both ways), and
 *    a link to it from the footer (components/organisms/site-footer.tsx) or
 *    from the page named in `linkedFrom`;
 *  - indexable, one URL per row: the sitemap file whose route lists the rows
 *    (`societies.xml`, `events.xml`);
 *  - not for search: `{ excluded: "<why>" }` (and noindex on the page, or a
 *    robots.txt rule).
 *
 * Keys are route patterns as the `app/(site)` tree spells them, without
 * route groups: `/societies/[slug]`.
 */

export type RouteIndexing =
  | { sitemap: "pages.xml"; linkedFrom: "footer" | `page:${string}` | "header" }
  | { sitemap: "societies.xml" | "events.xml" }
  | { excluded: string }

export const ROUTE_INDEXING: Record<string, RouteIndexing> = {
  "/": { sitemap: "pages.xml", linkedFrom: "header" },
  "/about": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/categories": { sitemap: "societies.xml" },
  "/categories/[category]": { sitemap: "societies.xml" },
  "/colleges": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/for/beginners": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/for/postgraduates": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/for/international-students": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/events": { sitemap: "pages.xml", linkedFrom: "header" },
  "/events/[key]": { sitemap: "events.xml" },
  "/guides": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/guides/join-a-society": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/guides/start-a-society": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/guides/formal-hall": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/may-balls": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/rowing": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/varsity": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/university-sport": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/theatre": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/postgraduates": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/guides/glossary": { sitemap: "pages.xml", linkedFrom: "page:/guides" },
  "/privacy": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/request": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/societies": { sitemap: "pages.xml", linkedFrom: "header" },
  "/societies/[slug]": { sitemap: "societies.xml" },
  "/talks": { sitemap: "pages.xml", linkedFrom: "header" },
  "/talks/[key]": {
    excluded:
      "talks.cam content: classic search may find talk pages, but no sitemap lists them (G1)",
  },
  "/talks/departments": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/talks/events/[key]": {
    excluded: "a talks.cam-derived event's page: never in a sitemap (G1)",
  },
  "/term-dates": { sitemap: "pages.xml", linkedFrom: "footer" },
  "/terms": { sitemap: "pages.xml", linkedFrom: "footer" },
}

/** A `page.tsx` file's route, from its path under `app/(site)`: route
 * groups `(…)` dropped, `/` for the root. */
export function routeOfPageFile(relative: string): string {
  const segments = relative
    .split("/")
    .slice(0, -1)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
  return `/${segments.join("/")}`
}
