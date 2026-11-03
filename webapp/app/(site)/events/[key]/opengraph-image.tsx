import { fetchQuery } from "convex/nextjs"
import { LISTING_CARD_CACHE, renderCard, renderGenericCard } from "@/app/_og/card"
import { api } from "@/convex/_generated/api"
import { eventCard } from "@/lib/og-card"
import { isEventKey } from "@/lib/url-state"

/**
 * An event's own share card (SEO audit 2026-11-02, og-share-cards): when,
 * what, who and where. Read anonymously, so a Cambridge-only event is never
 * drawn, and an event with any talks.cam content gets the generic card
 * (lib/og-card.ts `eventCard`; owner decision G1: no talks.cam-derived text
 * outside /talks, an image included). lib/page-metadata.ts leaves the page's
 * Open Graph image to this.
 */
export const alt = "An event's date, title, host and venue on a camsocs card"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  try {
    const event = isEventKey(key) ? await fetchQuery(api.events.get, { key }) : null
    const text = event ? eventCard(event) : null
    if (!text) return await renderGenericCard(LISTING_CARD_CACHE)
    return await renderCard({ text, footLeft: "Events", cacheControl: LISTING_CARD_CACHE })
  } catch (error) {
    console.error("event share card failed; the generic card instead", error)
    return renderGenericCard(LISTING_CARD_CACHE)
  }
}
