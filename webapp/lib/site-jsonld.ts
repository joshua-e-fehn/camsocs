/**
 * What CAMsocs is, and who runs it, as schema.org (SEO audit 2026-11-02,
 * site-entity-jsonld): the WebSite node on `/`, and the About page with its
 * publisher on `/about`. Both join the rest of the graph by the stable ids of
 * lib/structured-data.ts.
 *
 * A lowercase brand on a new domain is easily misnamed, or taken for a
 * University resource; these nodes say plainly that CAMsocs is one person's
 * independent project. Never add `parentOrganization`, `memberOf` or
 * `affiliation` naming the University, a college or Cambridge SU (AGENTS.md:
 * unofficial, no affiliation implied).
 */

import {
  CONTACT_EMAIL,
  CONTROLLER_NAME,
  DISCLAIMER,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site"
import { PUBLISHER_ID, pageId, WEBSITE_ID } from "./structured-data"

/** The publisher as a person: the privacy notice's controller is an
 * individual, not an organisation (lib/site.ts `CONTROLLER_NAME`). */
function publisher() {
  return {
    "@type": "Person",
    "@id": PUBLISHER_ID,
    name: CONTROLLER_NAME,
    url: pageId("/about"),
    ...(CONTACT_EMAIL ? { email: CONTACT_EMAIL } : {}),
  }
}

/** `/`: the site, its publisher, and the society search it offers
 * (`/societies?q=`, what the hero's search box submits). */
export function websiteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: pageId("/"),
        name: SITE_NAME,
        // No alternateName: the domain listed there invited Google to show
        // "camsocs.uk" as the site name instead of CAMsocs (2026-11-07).
        description: SITE_DESCRIPTION,
        inLanguage: "en-GB",
        publisher: { "@id": PUBLISHER_ID },
        publishingPrinciples: pageId("/about"),
        // Intentionally a robots-disallowed slice (`/societies?q=` is a crawler
        // trap, bot policy 2026-11-03): the action describes the site's search
        // for readers and assistants; no crawler needs to fetch it (Google
        // retired the sitelinks search box).
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${SITE_URL}/societies?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
      publisher(),
    ],
  }
}

/** `/about`: the page, about the site, with the publisher in full and the
 * non-affiliation statement in its description. */
export function aboutPageJsonLd(description: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "AboutPage",
        "@id": pageId("/about"),
        url: pageId("/about"),
        name: `About ${SITE_NAME}`,
        description: `${description} ${DISCLAIMER}`,
        inLanguage: "en-GB",
        isPartOf: { "@id": WEBSITE_ID },
        about: { "@id": WEBSITE_ID },
        author: { "@id": PUBLISHER_ID },
      },
      {
        ...publisher(),
        description: `Runs ${SITE_NAME} as a personal project. ${DISCLAIMER}`,
      },
    ],
  }
}
