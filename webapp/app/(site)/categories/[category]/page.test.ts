import { describe, expect, test } from "bun:test"
import { categoryFromSlug, categoryHubPaths } from "@/lib/directory-hubs"
import { dynamicParams, generateStaticParams } from "./page"

/**
 * Every category hub is built with the site and no other slug is a page
 * (re-check 2026-11-03, not-found-template): an unknown category is an
 * unmatched URL, which Next answers with app/not-found.tsx's static 404 in
 * the site frame, as for any other mistyped address.
 */
describe("the category hubs' static params", () => {
  test("one per category, each the slug of its hub path", () => {
    const slugs = generateStaticParams().map(({ category }) => category)
    expect(slugs.map((slug) => `/categories/${slug}`)).toEqual(categoryHubPaths())
    for (const slug of slugs) expect(categoryFromSlug(slug)).toBeDefined()
  })

  test("no other slug renders the page", () => {
    expect(dynamicParams).toBe(false)
  })
})
