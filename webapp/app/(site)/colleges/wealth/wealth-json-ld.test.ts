import { describe, expect, test } from "bun:test"
import { resolveWealthYear } from "@/lib/college-finances"
import { WEALTH_CHECKED_ON, WEALTH_PUBLISHED_ON } from "@/lib/college-wealth"
import {
  faqText,
  staticWealthView,
  VERIFIED_WEALTH,
  type WealthView,
  wealthDescription,
  wealthFaqs,
  wealthTitle,
  wealthView,
} from "@/lib/college-wealth-view"
import { REGISTER_META, registerYearHistory } from "@/lib/college-wealth-view.testing"
import { collegeHubPath } from "@/lib/directory-hubs"
import { pageId } from "@/lib/structured-data"
import { WEALTH_CSV_PATH, wealthJsonLd } from "./wealth-json-ld"

type Node = Record<string, unknown>

function graphOf(view: WealthView) {
  const graph = wealthJsonLd(view)["@graph"] as Node[]
  return (type: string) => graph.find((node) => node["@type"] === type) as Node
}

describe("/colleges/wealth JSON-LD", () => {
  const view = staticWealthView()
  const graph = wealthJsonLd(view)["@graph"] as Node[]
  const byType = graphOf(view)

  test("page, list, breadcrumb, dataset and questions", () => {
    expect(graph.map((node) => node["@type"]).sort()).toEqual(
      ["BreadcrumbList", "CollectionPage", "Dataset", "FAQPage", "ItemList"].sort(),
    )
  })

  test("the list is the 31 colleges in endowment order, each with its figure", () => {
    const list = byType("ItemList")
    expect(list.numberOfItems).toBe(31)
    expect(list.itemListOrder).toBe("https://schema.org/ItemListOrderDescending")
    const items = list.itemListElement as Node[]
    expect(items).toHaveLength(31)
    expect(items[0].position).toBe(1)
    expect(items[0].name).toBe("Trinity College: £2.70bn")
    expect(items[0].url).toBe(pageId(collegeHubPath(view.byEndowment[0].college)))
  })

  test("the page and the dataset carry the same dates as the visible line", () => {
    const page = byType("CollectionPage")
    const dataset = byType("Dataset")
    expect(page.name).toBe(wealthTitle(view))
    expect(page.description).toBe(wealthDescription(view))
    expect(page.dateModified).toBe(WEALTH_CHECKED_ON)
    expect(dataset.dateModified).toBe(WEALTH_CHECKED_ON)
    expect(view.updatedOn).toBe(WEALTH_CHECKED_ON)
    expect(page.datePublished).toBe(WEALTH_PUBLISHED_ON)
    expect(dataset.datePublished).toBe(WEALTH_PUBLISHED_ON)
  })

  test("the dataset: licence, version, coverage and its CSV", () => {
    const page = byType("CollectionPage")
    const dataset = byType("Dataset")
    expect(typeof dataset.license).toBe("string")
    expect(dataset.isPartOf).toEqual({ "@id": page["@id"] })
    expect(dataset.version).toBe("2024-25")
    expect(dataset.temporalCoverage).toBe("2024-07-01/2025-07-31")
    expect(dataset.spatialCoverage).toEqual({ "@type": "Place", name: "Cambridge, United Kingdom" })
    expect(dataset.distribution).toEqual([
      expect.objectContaining({
        "@type": "DataDownload",
        encodingFormat: "text/csv",
        contentUrl: pageId(WEALTH_CSV_PATH),
      }),
    ])
  })

  test("the FAQPage is the page's questions, word for word", () => {
    const faq = byType("FAQPage")
    const questions = faq.mainEntity as Node[]
    const faqs = wealthFaqs(view)
    expect(questions).toHaveLength(faqs.length)
    faqs.forEach((entry, index) => {
      expect(questions[index].name).toBe(entry.question)
      expect((questions[index].acceptedAnswer as Node).text).toBe(faqText(entry.answer))
    })
  })

  test("a register year moves the version, dates and sources", () => {
    const later = wealthView(
      resolveWealthYear(VERIFIED_WEALTH, registerYearHistory({ complete: true })),
      REGISTER_META,
    )
    const dataset = graphOf(later)("Dataset")
    expect(dataset.version).toBe("2025-26")
    expect(dataset.dateModified).toBe("2027-05-20")
    expect((dataset.isBasedOn as string[])[0]).toMatch(/^https:\/\/register-of-charities\./)
  })
})
