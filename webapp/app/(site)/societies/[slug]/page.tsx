import { fetchQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import { TrackView } from "@/components/molecules/track-view"
import { OrgProfile } from "@/components/organisms/org-profile"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { DAY_MS, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { pageMetadata } from "@/lib/page-metadata"
import { plainLine, summary } from "@/lib/rich-text"
import { camSignInOpen } from "@/lib/sign-in-options"
import { SITE_NAME, SITE_URL } from "@/lib/site"
import { isOrgSlug } from "@/lib/url-state"

type Props = { params: Promise<{ slug: string }> }

/** One fetch per request, shared by the metadata and the page. With the
 * viewer's token: the upcoming events include Cambridge-only ones for a
 * verified @cam.ac.uk visitor. */
const loadOrg = cache(async (slug: string) => {
  if (!isOrgSlug(slug)) return null
  return await fetchQuery(api.orgs.getBySlug, { slug }, { token: await getToken() })
})

/** A listing in one plain sentence or two, for search results, share cards
 * and JSON-LD: its short description, else the start of its description
 * (markdown stripped, lib/rich-text.ts), else undefined. */
function plainDescription(org: { shortDescription?: string; description?: string }) {
  const short = org.shortDescription ? plainLine(org.shortDescription) : ""
  if (short) return short
  const long = org.description ? summary(org.description, 160) : ""
  return long || undefined
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadOrg((await params).slug)
  // proxy.ts has already answered an unknown slug with a real 404
  // (lib/missing-listing.ts). This is the fallback — a listing hidden since
  // that check, or a check that failed — and after loading.tsx has streamed
  // its status stays 200, marked noindex (Next docs, loading.md "Status Codes").
  if (!page) notFound()
  const { org } = page
  const description =
    plainDescription(org) ?? `${org.name}: what it does, how to join and how to get in touch.`
  return pageMetadata({ title: org.name, description, path: `/societies/${org.slug}` })
}

/** How many Cambridge-only upcoming events this viewer cannot see. Null when
 * the count is unavailable — the page must not fail over a hint. */
async function hiddenEventCount(orgKey: string, token: string | undefined) {
  const from = londonMidnight(londonIsoDate(Date.now()))
  try {
    const { camOnly } = await fetchQuery(
      api.events.restrictedCount,
      { from, to: from + 180 * DAY_MS, orgKey },
      { token },
    )
    return camOnly
  } catch {
    return null
  }
}

/** Related listings for the profile; empty when they cannot be read — the
 * page must not fail over a list of suggestions. */
async function relatedOrgs(slug: string) {
  try {
    return await fetchQuery(api.orgs.related, { slug, limit: 6 })
  } catch {
    return []
  }
}

export default async function SocietyPage({ params }: Props) {
  const page = await loadOrg((await params).slug)
  if (!page) notFound()
  const token = await getToken()
  const [colleges, camSignIn, hiddenCount, related] = await Promise.all([
    fetchQuery(api.orgs.colleges, {}),
    camSignInOpen(),
    hiddenEventCount(page.org.key, token),
    relatedOrgs(page.org.slug),
  ])
  // The count's prompt is a sign-in link: none while the link is off, as on
  // /events (ENG-35).
  const hiddenEvents = camSignIn ? hiddenCount : null
  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))

  const { org } = page
  // schema.org Organization from public facts only (no personal data).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    alternateName: org.aliases.length > 0 ? org.aliases : undefined,
    description: plainDescription(org),
    url: org.website,
    logo: org.logo?.url,
    sameAs: org.socials.map((social) => social.url),
    mainEntityOfPage: `${SITE_URL}/societies/${org.slug}`,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
  }

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD; `<` is escaped below
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <TrackView event="society_viewed" props={{ orgKey: org.key, categories: org.categories }} />
      <OrgProfile
        page={page}
        collegeNames={collegeNames}
        hiddenEvents={hiddenEvents}
        related={related}
      />
    </>
  )
}
