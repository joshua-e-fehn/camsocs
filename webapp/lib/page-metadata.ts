import type { Metadata } from "next"
import { MAX_TITLE_LENGTH, SHARE_IMAGE_ALT, SITE_NAME, TITLE_SUFFIX } from "./site"

export { MAX_TITLE_LENGTH }

/**
 * Bump when the generic share card (app/opengraph-image.tsx) changes: link
 * previews (WhatsApp, Slack, LinkedIn) cache an image by its URL, so a new
 * design needs a new one (SEO audit 2026-11-02, og-share-cards). The route
 * ignores the query.
 */
export const SHARE_IMAGE_VERSION = "2026-11-02"

/** The share image of every page without its own (app/opengraph-image.tsx). */
export const SHARE_IMAGE = {
  url: `/opengraph-image?v=${SHARE_IMAGE_VERSION}`,
  width: 1200,
  height: 630,
  alt: SHARE_IMAGE_ALT,
} as const

/**
 * Pages whose route segment draws its own share card (an `opengraph-image`
 * file): a society's profile and an event's page (og-share-cards). Next uses
 * that file only when the page's metadata names no Open Graph image, so
 * `pageMetadata` leaves the generic one out for these paths. A test holds
 * the list and the files together.
 */
export const OWN_IMAGE_PATHS: readonly RegExp[] = [/^\/societies\/[^/]+$/, /^\/events\/[^/]+$/]

/** The longest meta description worth sending: search results cut at about
 * 155–160 characters, mid-word (SEO audit, meta-description-quality). */
export const MAX_DESCRIPTION_LENGTH = 155

/** Where a cut-short description may end a sentence and still say enough. */
const MIN_SENTENCE_CUT = 70

/**
 * A title for `metadata.title`: as is, so the layout adds " · CAMsocs",
 * while that fits in `MAX_TITLE_LENGTH`; else `absolute`, the name alone:
 * the name matters more than the brand in a cut-off result (G2). A title too
 * long even alone stays whole: the caller picks a shorter form first where
 * it has one (lib/directory-profile.ts `societyTitle`).
 */
export function fitTitle(title: string): string | { absolute: string } {
  return title.length + TITLE_SUFFIX.length > MAX_TITLE_LENGTH ? { absolute: title } : title
}

/** A page's `<title>`: `fitTitle` for a plain name; `{ absolute }` as is. */
export function documentTitle(title: string | { absolute: string }): Metadata["title"] {
  return typeof title === "string" ? fitTitle(title) : title
}

/**
 * A meta description of at most `max` characters, on one line.
 *
 *  - Longer text is cut at a word and ends with "…".
 *  - Text a source already cut short ("the club encourages...") ends at its
 *    last full sentence when that still says enough, rather than with a
 *    dangling half-sentence and a double ellipsis.
 */
export function metaDescription(text: string, max = MAX_DESCRIPTION_LENGTH): string {
  const line = text.replace(/\s+/g, " ").trim()
  const truncated = /(?:\.{3}|…)$/.test(line)
  if (!truncated && line.length <= max) return line
  // The last full sentence that fits, when it says enough on its own.
  const head = line.slice(0, max + 1)
  let sentenceEnd = -1
  for (const match of head.matchAll(/[.!?](?=\s)/g)) sentenceEnd = match.index
  if (sentenceEnd + 1 >= MIN_SENTENCE_CUT) return line.slice(0, sentenceEnd + 1)
  // Else cut at a word, with one ellipsis.
  const body = truncated ? line.replace(/(?:\.{3}|…)$/, "").trimEnd() : line
  const space = body.length < max ? -1 : body.slice(0, max - 1).lastIndexOf(" ")
  const words =
    body.length < max ? body : space > max * 0.6 ? body.slice(0, space) : body.slice(0, max - 1)
  return `${words.replace(/[\s,;:.–—-]+$/, "")}…`
}

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
 *
 * The Twitter card names no image: Next fills it from Open Graph's, which is
 * also how a route's own `opengraph-image` reaches it.
 */
export function pageMetadata({
  title,
  description,
  path,
  ownImage = OWN_IMAGE_PATHS.some((pattern) => pattern.test(path)),
}: {
  /** The page's name; `{ absolute }` skips the " · CAMsocs" suffix. */
  title: string | { absolute: string }
  description: string
  /** Site-relative, e.g. `/societies/chess`. */
  path: string
  /** The route draws its own share card (an `opengraph-image` file in its
   * segment); by default, whether `path` is one of `OWN_IMAGE_PATHS`. */
  ownImage?: boolean
}): Metadata {
  const name = typeof title === "string" ? title : title.absolute
  const text = metaDescription(description)
  return {
    title: documentTitle(title),
    description: text,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "en_GB",
      title: name,
      description: text,
      url: path,
      ...(ownImage ? {} : { images: [SHARE_IMAGE] }),
    },
    twitter: { card: "summary_large_image", title: name, description: text },
  }
}

/**
 * Search Console and Bing Webmaster Tools verification tags (SEO audit
 * 2026-11-02, search-console-bing-indexnow; owner decision G14). The owner
 * verifies by DNS; these optional variables are the fallback for a property
 * that wants a meta tag. Unset or blank, nothing is rendered.
 */
export function siteVerification(
  env: Readonly<Record<string, string | undefined>> = {
    NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
    NEXT_PUBLIC_BING_SITE_VERIFICATION: process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION,
  },
): Metadata["verification"] {
  const google = env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION?.trim()
  const bing = env.NEXT_PUBLIC_BING_SITE_VERIFICATION?.trim()
  if (!google && !bing) return undefined
  return {
    ...(google ? { google } : {}),
    // Bing's tag is `<meta name="msvalidate.01" content="…">`.
    ...(bing ? { other: { "msvalidate.01": bing } } : {}),
  }
}
