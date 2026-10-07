import { fetchQuery } from "convex/nextjs"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import { OrgProfile } from "@/components/organisms/org-profile"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { DAY_MS, londonIsoDate, londonMidnight } from "@/lib/calendar"
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadOrg((await params).slug)
  // An unknown slug renders the not-found page. The status stays 200 once
  // loading.tsx has streamed, and Next marks the page noindex instead
  // (Next docs, loading.md "Status Codes").
  if (!page) notFound()
  const { org } = page
  const description =
    org.shortDescription ?? `${org.name}: what it does, how to join and how to get in touch.`
  return {
    title: org.name,
    description,
    alternates: { canonical: `/societies/${org.slug}` },
    openGraph: { title: org.name, description, url: `/societies/${org.slug}` },
  }
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

export default async function SocietyPage({ params }: Props) {
  const page = await loadOrg((await params).slug)
  if (!page) notFound()
  const token = await getToken()
  const [colleges, hiddenEvents] = await Promise.all([
    fetchQuery(api.orgs.colleges, {}),
    hiddenEventCount(page.org.key, token),
  ])
  const collegeNames = Object.fromEntries(colleges.map((college) => [college.key, college.name]))

  const { org } = page
  // schema.org Organization from public facts only (no personal data).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    alternateName: org.aliases.length > 0 ? org.aliases : undefined,
    description: org.shortDescription,
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
      <OrgProfile page={page} collegeNames={collegeNames} hiddenEvents={hiddenEvents} />
    </>
  )
}
