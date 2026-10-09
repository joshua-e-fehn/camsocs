import type { Metadata } from "next"
import { SHARE_IMAGE_ALT, SITE_NAME } from "./site"

/** The share image every page uses (app/opengraph-image.tsx). */
export const SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: SHARE_IMAGE_ALT,
} as const

/**
 * A page's metadata: its title and description, the same as its Open Graph
 * and Twitter card, and its canonical path (absolute through the layout's
 * `metadataBase`).
 *
 * Every page that has its own title goes through this, because Next merges
 * metadata one top-level key at a time: a page that sets `openGraph` at all
 * replaces the layout's whole object — site name, locale and the share image
 * included — and a page that does not set it shares with every link the home
 * page's title and description.
 */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string
  description: string
  /** Site-relative, e.g. `/societies/chess`. */
  path: string
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_GB",
      title,
      description,
      url: path,
      images: [SHARE_IMAGE],
    },
    twitter: { card: "summary_large_image", title, description, images: [SHARE_IMAGE.url] },
  }
}
