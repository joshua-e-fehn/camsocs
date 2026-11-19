import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { CollegeWealthFact } from "@/components/molecules/college-wealth-fact"
import { resolveWealthYear } from "@/lib/college-finances"
import {
  hubWealthFact,
  registerCheckText,
  staticWealthView,
  VERIFIED_WEALTH,
  type WealthView,
  wealthLede,
  wealthView,
} from "@/lib/college-wealth-view"
import { REGISTER_META, registerYearHistory } from "@/lib/college-wealth-view.testing"
import { CollegeWealthArticle } from "./wealth-article"

/** The page as the server renders it, for a view (no Convex needed). */
function render(view: WealthView): Document {
  const html = renderToString(<CollegeWealthArticle view={view} />).replaceAll("<!-- -->", "")
  const doc = document.implementation.createHTMLDocument("t")
  doc.body.innerHTML = html
  return doc
}

const text = (doc: Document) => doc.body.textContent ?? ""

describe("/colleges/wealth (server render, verified year)", () => {
  const view = staticWealthView()
  const doc = render(view)

  test("one H1, the answer first, the updated date", () => {
    const h1 = doc.querySelectorAll("h1")
    expect(h1).toHaveLength(1)
    expect(h1[0].textContent).toBe("Cambridge colleges ranked by endowment, richest to poorest")
    const lede = doc.querySelector("header p.text-lg")
    expect(lede?.textContent).toStartWith(wealthLede(view))
    const time = doc.querySelector("header time")
    expect(time?.getAttribute("datetime")).toBe(view.updatedOn)
    expect(time?.textContent).toBe(
      "Updated 19 Nov 2026 · 2024-25 accounts, the latest year every college has filed",
    )
  })

  test("the H2s answer the searches", () => {
    const h2 = [...doc.querySelectorAll("h2")].map((node) => node.textContent)
    expect(h2).toEqual([
      "The richest Cambridge colleges",
      "All 31 colleges ranked",
      "The poorest Cambridge colleges",
      "Endowment per student",
      "Why is Trinity so rich?",
      "Endowment vs net assets",
      "How college endowments have changed",
      "How we measured this",
      "What the numbers don’t say",
      "Questions",
    ])
  })

  test("the one-read disclaimer is gone; the register cross-check is there", () => {
    expect(text(doc)).not.toMatch(/read once|read a second time/)
    expect(text(doc)).toContain(registerCheckText())
    expect(text(doc)).toContain("Open Government Licence v3.0")
  })

  test("every ranking row has its college's slug as id, which the lists link", () => {
    const rows = doc.querySelectorAll("tbody tr[id]")
    expect(rows.length).toBeGreaterThanOrEqual(31)
    expect(doc.getElementById("trinity-college")?.tagName).toBe("TR")
    const topTen = doc.querySelectorAll("#richest ~ ol li a, section[aria-labelledby=richest] ol a")
    expect(topTen[0]?.getAttribute("href")).toBe("#trinity-college")
  })

  test("the trend table is rendered on the server, with a caption", () => {
    const caption = [...doc.querySelectorAll("caption")].map((node) => node.textContent)
    expect(
      caption.some((line) => line?.startsWith("Each college’s endowment by financial year")),
    ).toBe(true)
  })

  test("the JSON-LD script parses and holds the FAQ", () => {
    const script = doc.querySelector('script[type="application/ld+json"]')
    const data = JSON.parse(script?.textContent ?? "{}") as { "@graph": { "@type": string }[] }
    expect(data["@graph"].map((node) => node["@type"])).toContain("FAQPage")
  })

  test("the CSV is linked; no unworked value leaks", () => {
    expect(doc.querySelector('a[href="/colleges/wealth.csv"]')).not.toBeNull()
    expect(text(doc)).not.toMatch(/undefined|NaN|\[object/)
  })
})

describe("/colleges/wealth (a later register year)", () => {
  const view = wealthView(
    resolveWealthYear(VERIFIED_WEALTH, registerYearHistory({ complete: true })),
    REGISTER_META,
  )
  const doc = render(view)

  test("the year and the source change; the register rows link the register", () => {
    expect(doc.querySelector("header time")?.textContent).toContain("2025-26 figures")
    expect(text(doc)).toContain("not yet read from the accounts")
    const sources = [...doc.querySelectorAll("tbody a[href^='https://register-of-charities']")]
    expect(sources.length).toBeGreaterThanOrEqual(31)
    expect(text(doc)).not.toMatch(/undefined|NaN|\[object/)
  })
})

describe("the college hub's wealth line", () => {
  test("links its row in the ranking", () => {
    const fact = hubWealthFact(staticWealthView(), "trinity-college")
    if (!fact) throw new Error("no fact")
    const html = renderToString(<CollegeWealthFact fact={fact} />).replaceAll("<!-- -->", "")
    expect(html).toContain('href="/colleges/wealth#trinity-college"')
    expect(html).toContain("Endowment £2.70bn (1st of 31, 2024-25)")
    expect(html).toContain("Trinity’s endowment, ranked")
  })
})
