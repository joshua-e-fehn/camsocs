/**
 * The site's one schema.org graph: every JSON-LD node that another page can
 * refer to gets a stable `@id` from here, so a society's Organization, its
 * Events and the site's WebSite and publisher join up across pages instead of
 * being re-described as strangers on each one (SEO audit 2026-11-02,
 * jsonld-graph-breadcrumbs).
 *
 * Ids are absolute URLs with a fragment naming the node, the convention
 * Google and Schema.org's own examples use. Never change one once published:
 * search engines key their understanding of the entity on it.
 */

import { SITE_URL } from "./site"

/** The CAMsocs WebSite node (on `/`). */
export const WEBSITE_ID = `${SITE_URL}/#website`

/** The person who runs CAMsocs, as publisher (on `/about`). */
export const PUBLISHER_ID = `${SITE_URL}/about#publisher`

/** A page's own WebPage node: its canonical URL. `path` is site-relative. */
export function pageId(path: string): string {
  return `${SITE_URL}${path === "/" ? "/" : path}`
}

/** A society's Organization node on its profile. */
export function organizationId(slug: string): string {
  return `${SITE_URL}/societies/${slug}#organization`
}

/** An event's Event node on its detail page. */
export function eventId(key: string): string {
  return `${SITE_URL}/events/${key}#event`
}

/** A talk's Event node on its detail page. */
export function talkId(key: string): string {
  return `${SITE_URL}/talks/${key}#event`
}

/** A BreadcrumbList for a page, from (name, site-relative path) pairs, the
 * last being the page itself. */
export function breadcrumbList(path: string, crumbs: { name: string; path: string }[]) {
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageId(path)}#breadcrumb`,
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: pageId(crumb.path),
    })),
  }
}

/** JSON for a `<script type="application/ld+json">`: `<` escaped so no text
 * in it can close the script. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}
