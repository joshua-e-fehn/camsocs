import { describe, expect, test } from "bun:test"
import { CONTROLLER_NAME, DISCLAIMER, SITE_URL } from "./site"
import { aboutPageJsonLd, websiteJsonLd } from "./site-jsonld"
import { jsonLdScript, PUBLISHER_ID, WEBSITE_ID } from "./structured-data"

type Node = Record<string, unknown>
const graph = (data: Record<string, unknown>) => data["@graph"] as Node[]
const byType = (data: Record<string, unknown>, type: string) =>
  graph(data).find((node) => node["@type"] === type) as Node

describe("the WebSite node on /", () => {
  const data = websiteJsonLd()
  const site = byType(data, "WebSite")

  test("names camsocs at its stable id, with its publisher", () => {
    expect(data["@context"]).toBe("https://schema.org")
    expect(site).toMatchObject({
      "@id": WEBSITE_ID,
      url: `${SITE_URL}/`,
      name: "camsocs",
      inLanguage: "en-GB",
      publisher: { "@id": PUBLISHER_ID },
    })
    expect(byType(data, "Person")).toMatchObject({ "@id": PUBLISHER_ID, name: CONTROLLER_NAME })
  })

  test("its search goes to the society directory's own query parameter", () => {
    expect(site.potentialAction).toMatchObject({
      "@type": "SearchAction",
      target: { urlTemplate: `${SITE_URL}/societies?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    })
  })
})

describe("the About page", () => {
  const data = aboutPageJsonLd("How camsocs works.")

  test("is about the site and says it is unofficial", () => {
    const page = byType(data, "AboutPage")
    expect(page).toMatchObject({
      "@id": `${SITE_URL}/about`,
      isPartOf: { "@id": WEBSITE_ID },
      about: { "@id": WEBSITE_ID },
      author: { "@id": PUBLISHER_ID },
    })
    expect(page.description).toContain(DISCLAIMER)
    expect(byType(data, "Person").description).toContain(DISCLAIMER)
  })
})

test("no node claims an affiliation with the University, a college or the SU", () => {
  for (const data of [websiteJsonLd(), aboutPageJsonLd("x")]) {
    const json = jsonLdScript(data)
    for (const key of ["parentOrganization", "memberOf", "affiliation", "sponsor", "funder"]) {
      expect(json).not.toContain(`"${key}"`)
    }
  }
})
