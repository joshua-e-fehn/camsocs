import { fetchQuery } from "convex/nextjs"
import { LISTING_CARD_CACHE, logoDataUri, renderCard, renderGenericCard } from "@/app/_og/card"
import { api } from "@/convex/_generated/api"
import { societyCard } from "@/lib/og-card"
import { isOrgSlug } from "@/lib/url-state"

/**
 * A society's own share card (SEO audit 2026-11-02, og-share-cards): its
 * kinds, its name and its logo (our stored copy) where the renderer can draw
 * it, else the crest. Links to societies spread through WhatsApp, Instagram
 * DMs and Slack, where the card is the preview. An unknown or unreadable
 * listing gets the generic card. Read anonymously, like the page's public
 * facts; lib/page-metadata.ts leaves the page's Open Graph image to this.
 */
export const alt = "A society's name, kinds and logo on a camsocs card"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  try {
    const page = isOrgSlug(slug) ? await fetchQuery(api.orgs.getBySlug, { slug }) : null
    if (!page) return await renderGenericCard(LISTING_CARD_CACHE)
    return await renderCard({
      text: societyCard(page.org),
      logo: await logoDataUri(page.org.logo?.url),
      footLeft: "Societies and clubs",
      cacheControl: LISTING_CARD_CACHE,
    })
  } catch (error) {
    // A share card is decoration: Convex down means the generic one.
    console.error("society share card failed; the generic card instead", error)
    return renderGenericCard(LISTING_CARD_CACHE)
  }
}
