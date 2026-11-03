import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SiteFooter } from "@/components/organisms/site-footer"

/** The footer is on every page, so its links are what a crawler fetches most
 * (SEO audit 2026-11-02, request-param-urls). */
const html = renderToStaticMarkup(<SiteFooter clock={null} />)
const links = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map(([tag, href]) => ({
  href,
  nofollow: /rel="[^"]*nofollow/.test(tag),
}))

test("the request form is linked bare and crawlable", () => {
  expect(links).toContainEqual({ href: "/request", nofollow: false })
})

test("its preset variants, the same page under its canonical, are nofollow", () => {
  const presets = links.filter((link) => link.href.startsWith("/request?"))
  expect(presets.length).toBeGreaterThan(0)
  for (const link of presets) expect(link.nofollow).toBe(true)
})

test("the term dates page is linked", () => {
  expect(links).toContainEqual({ href: "/term-dates", nofollow: false })
})
