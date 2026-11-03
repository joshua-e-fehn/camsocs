import { renderGenericCard } from "@/app/_og/card"
import { SHARE_IMAGE_ALT } from "@/lib/site"

/**
 * The share image of every page without its own (app/_og/card.tsx draws
 * it): the wordmark, "Everything on in Cambridge, in one place." and the
 * crest. Bump SHARE_IMAGE_VERSION (lib/page-metadata.ts) when it changes.
 */
export const alt = SHARE_IMAGE_ALT
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return renderGenericCard()
}
