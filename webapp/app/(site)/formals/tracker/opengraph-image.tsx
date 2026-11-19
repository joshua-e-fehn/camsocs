import { renderCard } from "@/app/_og/card"
import { COLLEGE_INFO } from "@/lib/colleges"
import { formalTrackerCard } from "@/lib/og-card"

/**
 * The formal tracker's own share card (formals SEO audit 2026-11-19): the
 * challenge and the number of colleges. Static, our own crest only
 * (app/_og/card.tsx); lib/page-metadata.ts `OWN_IMAGE_PATHS` leaves the
 * page's Open Graph image to this.
 */
export const alt = "The every-college formal challenge on a CAMsocs card"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function Image() {
  return renderCard({ text: formalTrackerCard(COLLEGE_INFO.length), footLeft: "Formals" })
}
