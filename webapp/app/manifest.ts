import type { MetadataRoute } from "next"
import { SITE_NAME, THEME_COLOR } from "@/lib/site"

/**
 * `/manifest.webmanifest` (SEO audit 2026-11-02, manifest-security-txt-hsts):
 * the name and icons a phone uses when the site is added to a home screen.
 * A website, not an app: it opens in the browser.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME}: Cambridge societies and events`,
    short_name: SITE_NAME,
    description:
      "Cambridge student societies, sports clubs and their events, in one place. Unofficial.",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    lang: "en-GB",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon.png", type: "image/png", sizes: "180x180" },
    ],
  }
}
