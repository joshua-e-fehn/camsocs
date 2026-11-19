import { describe, expect, test } from "bun:test"
import { BY_ENDOWMENT } from "@/lib/college-wealth"
import { collegeHubPath } from "@/lib/directory-hubs"
import { pageId } from "@/lib/structured-data"
import { WEALTH_TITLE, wealthJsonLd } from "./wealth-json-ld"

type Node = Record<string, unknown>

describe("/colleges/wealth JSON-LD", () => {
  const graph = wealthJsonLd()["@graph"] as Node[]
  const byType = (type: string) => graph.find((node) => node["@type"] === type)

  test("page, list, breadcrumb and dataset", () => {
    expect(graph.map((node) => node["@type"]).sort()).toEqual(
      ["BreadcrumbList", "CollectionPage", "Dataset", "ItemList"].sort(),
    )
  })

  test("the list is the 31 colleges in endowment order", () => {
    const list = byType("ItemList") as Node
    expect(list.numberOfItems).toBe(31)
    const items = list.itemListElement as Node[]
    expect(items).toHaveLength(31)
    expect(items[0].position).toBe(1)
    expect(items[0].url).toBe(pageId(collegeHubPath(BY_ENDOWMENT[0].college)))
    expect(BY_ENDOWMENT[0].slug).toBe("trinity-college")
  })

  test("the dataset has a licence and belongs to the page", () => {
    const page = byType("CollectionPage") as Node
    const dataset = byType("Dataset") as Node
    expect(typeof dataset.license).toBe("string")
    expect(dataset.isPartOf).toEqual({ "@id": page["@id"] })
    expect(page.name).toBe(WEALTH_TITLE)
  })
})
