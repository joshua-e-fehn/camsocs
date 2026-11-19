import { renderCard } from "@/app/_og/card"
import { COLLEGE_INFO } from "@/lib/colleges"
import { nightCounts } from "@/lib/formal-facts"
import { formalsCard } from "@/lib/og-card"

/**
 * /formals' own share card (formals SEO audit 2026-11-19): the page is
 * shared in college group chats, where the generic card says nothing about
 * formals. Static: the counts per night come from lib/data/colleges.json, so
 * the card changes only with a deploy. Our own crest only, never the
 * University's (app/_og/card.tsx). lib/page-metadata.ts `OWN_IMAGE_PATHS`
 * leaves the page's Open Graph image to this.
 */
export const alt = "How many Cambridge colleges hold formal hall each night, on a CAMsocs card"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function Image() {
  return renderCard({
    text: formalsCard(nightCounts(COLLEGE_INFO), COLLEGE_INFO.length),
    footLeft: "Formals",
  })
}
