import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  documentTitle,
  MAX_DESCRIPTION_LENGTH,
  metaDescription,
  OWN_IMAGE_PATHS,
  pageMetadata,
  SHARE_IMAGE,
  siteVerification,
} from "./page-metadata"
import { SITE_DESCRIPTION, SITE_INTRO, SITE_NAME } from "./site"

test("a page's own title and description reach its share card, with the site's image", () => {
  const metadata = pageMetadata({
    title: "Chess Club",
    description: "Weekly club nights.",
    path: "/request",
  })
  expect(metadata.title).toBe("Chess Club")
  expect(metadata.alternates?.canonical).toBe("/request")
  expect(metadata.openGraph).toMatchObject({
    title: "Chess Club",
    description: "Weekly club nights.",
    url: "/request",
    siteName: SITE_NAME,
    locale: "en_GB",
    images: [SHARE_IMAGE],
  })
  // Next fills the Twitter card's image (with its alt) from Open Graph's.
  expect(metadata.twitter).toEqual({
    card: "summary_large_image",
    title: "Chess Club",
    description: "Weekly club nights.",
  })
})

test("the generic share image has a versioned URL, so previews refresh after a redesign", () => {
  expect(SHARE_IMAGE.url).toMatch(/^\/opengraph-image\?v=\S+$/)
})

describe("routes with their own share card (og-share-cards)", () => {
  test("societies' and events' pages name no Open Graph image", () => {
    for (const path of ["/societies/chess", "/events/evt-0123456789abcdef"]) {
      const metadata = pageMetadata({ title: "Chess Club", description: "x", path })
      expect(metadata.openGraph).not.toHaveProperty("images")
      expect(metadata.twitter).not.toHaveProperty("images")
    }
    expect(
      pageMetadata({ title: "x", description: "x", path: "/societies" }).openGraph,
    ).toHaveProperty("images")
    expect(
      pageMetadata({ title: "x", description: "x", path: "/x", ownImage: true }).openGraph,
    ).not.toHaveProperty("images")
  })

  test("each such path has its opengraph-image file", () => {
    const app = join(import.meta.dir, "..", "app", "(site)")
    expect(OWN_IMAGE_PATHS.map(String)).toEqual([
      String(/^\/societies\/[^/]+$/),
      String(/^\/events\/[^/]+$/),
    ])
    expect(existsSync(join(app, "societies", "[slug]", "opengraph-image.tsx"))).toBe(true)
    expect(existsSync(join(app, "events", "[key]", "opengraph-image.tsx"))).toBe(true)
  })
})

describe("titles (G2: at most 60 characters)", () => {
  test("keep the brand suffix while it fits", () => {
    expect(documentTitle("Cambridge University Chess Club")).toBe("Cambridge University Chess Club")
  })

  test("drop it when it would overflow", () => {
    const long = "Cambridge University Amateur Dramatic Club, Cambridge"
    expect(long.length + ` · ${SITE_NAME}`.length).toBeGreaterThan(60)
    expect(documentTitle(long)).toEqual({ absolute: long })
    expect(pageMetadata({ title: long, description: "x", path: "/x" }).title).toEqual({
      absolute: long,
    })
  })

  test("an absolute title stays absolute, and the share card gets the bare name", () => {
    const metadata = pageMetadata({
      title: { absolute: "CAMsocs – Cambridge student societies, events & talks" },
      description: "x",
      path: "/",
    })
    expect(metadata.title).toEqual({
      absolute: "CAMsocs – Cambridge student societies, events & talks",
    })
    expect(metadata.openGraph?.title).toBe("CAMsocs – Cambridge student societies, events & talks")
  })
})

describe("meta descriptions (meta-description-quality)", () => {
  const long =
    "The Chess Club meets every Tuesday in term for casual games, lessons for beginners and rated play. We run teams in the county league, a termly blitz tournament and the annual Varsity match against Oxford."

  test("short text passes through on one line", () => {
    expect(metaDescription("  Weekly club\n nights.  ")).toBe("Weekly club nights.")
  })

  test("long text ends at its last full sentence when that says enough", () => {
    const text = metaDescription(long)
    expect(text).toBe(
      "The Chess Club meets every Tuesday in term for casual games, lessons for beginners and rated play.",
    )
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })

  test("else it is cut at a word, with one ellipsis", () => {
    const text = metaDescription(long.replaceAll(".", ","))
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(text.endsWith("…")).toBe(true)
    expect(text).not.toMatch(/[,\s]…$/)
  })

  test("a source's own truncation ends at a sentence, or with a single ellipsis", () => {
    expect(
      metaDescription(
        "We are a friendly club for players of every level and meet weekly in college. Every term the club encourages...",
      ),
    ).toBe("We are a friendly club for players of every level and meet weekly in college.")
    expect(metaDescription("Chess for everyone, the club encourages...")).toBe(
      "Chess for everyone, the club encourages…",
    )
    expect(metaDescription("Chess for everyone…")).toBe("Chess for everyone…")
  })

  test("pageMetadata applies it everywhere the description goes", () => {
    const metadata = pageMetadata({ title: "Chess", description: long, path: "/x" })
    expect(String(metadata.description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
    expect(metadata.openGraph?.description).toBe(String(metadata.description))
    expect(metadata.twitter?.description).toBe(String(metadata.description))
  })

  test("the site's own description fits", () => {
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })

  test("the home hero says plainly what the site is, and whose it is not (home-metadata)", () => {
    expect(SITE_INTRO).toMatch(/^CAMsocs is an unofficial, independent directory of Cambridge /)
    for (const word of ["societies", "clubs", "events", "talks"]) expect(SITE_INTRO).toContain(word)
    // Not the societies' talks: talks.cam's public academic ones.
    expect(SITE_INTRO).toContain("public academic talks")
    // One quotable sentence, no University branding or claim of affiliation.
    expect(SITE_INTRO.match(/\. |\.$/g)).toHaveLength(1)
    expect(SITE_INTRO).not.toMatch(/University|official directory|affiliated/i)
    expect(SITE_INTRO.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
  })
})

test("verification tags render only for the variables that are set", () => {
  expect(siteVerification({})).toBeUndefined()
  expect(
    siteVerification({
      NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: " ",
      NEXT_PUBLIC_BING_SITE_VERIFICATION: "",
    }),
  ).toBeUndefined()
  expect(siteVerification({ NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: "g-token" })).toEqual({
    google: "g-token",
  })
  expect(siteVerification({ NEXT_PUBLIC_BING_SITE_VERIFICATION: "b-token" })).toEqual({
    other: { "msvalidate.01": "b-token" },
  })
})
