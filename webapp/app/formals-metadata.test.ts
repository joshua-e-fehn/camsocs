import { describe, expect, test } from "bun:test"
import { COLLEGE_INFO } from "@/lib/colleges"
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "@/lib/page-metadata"
import { TITLE_SUFFIX } from "@/lib/site"
import { generateMetadata } from "./(site)/formals/[slug]/page"
import { metadata as formalsMetadata } from "./(site)/formals/page"
import { metadata as trackerMetadata } from "./(site)/formals/tracker/page"

/** The `<title>` as a browser shows it: the layout's suffix unless absolute. */
function shown(title: unknown): string {
  if (typeof title === "string") return `${title}${TITLE_SUFFIX}`
  if (title && typeof title === "object" && "absolute" in title) return String(title.absolute)
  throw new Error(`unexpected title ${JSON.stringify(title)}`)
}

/** Formals SEO audit 2026-11-19: every formals page's title fits 60
 * characters as shown, and its description 155, whole. */
describe("formals pages' titles and descriptions", () => {
  test("/formals and /formals/tracker", () => {
    for (const metadata of [formalsMetadata, trackerMetadata]) {
      expect(shown(metadata.title).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      const description = String(metadata.description)
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(description.endsWith("…")).toBe(false)
    }
  })

  test("every /formals/<slug>", async () => {
    for (const college of COLLEGE_INFO) {
      const metadata = await generateMetadata({ params: Promise.resolve({ slug: college.slug }) })
      expect(shown(metadata.title).length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      const description = String(metadata.description)
      expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH)
      expect(description.endsWith("…")).toBe(false)
    }
  })
})
