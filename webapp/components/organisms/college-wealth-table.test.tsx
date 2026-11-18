import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { CollegeWealthTable } from "@/components/organisms/college-wealth-table"
import { COLLEGE_WEALTH, wealthTable } from "@/lib/college-wealth"
import { collegeHubPath } from "@/lib/directory-hubs"

function render(): Document {
  const html = renderToString(
    <CollegeWealthTable table={wealthTable(COLLEGE_WEALTH, collegeHubPath)} />,
  )
  const doc = document.implementation.createHTMLDocument("t")
  doc.body.innerHTML = html
  return doc
}

describe("CollegeWealthTable (server render)", () => {
  test("sorted by endowment, Trinity first, all 31 rows", () => {
    const doc = render()
    const sorted = doc.querySelectorAll("th[aria-sort]")
    expect(sorted).toHaveLength(1)
    expect(sorted[0].getAttribute("aria-sort")).toBe("descending")
    expect(sorted[0].textContent).toContain("Endowment")
    const rows = doc.querySelectorAll("tbody tr")
    expect(rows).toHaveLength(31)
    expect(rows[0].textContent).toContain("Trinity")
  })

  test("rank header has a spoken name, and sorting is announced", () => {
    const doc = render()
    const first = doc.querySelector("thead th")
    expect(first?.querySelector(".sr-only")?.textContent).toBe("Rank")
    expect(doc.querySelector("[aria-live=polite]")?.textContent).toContain("Ranked by endowment")
  })

  test("the header sticks and the cut-off note is there", () => {
    const doc = render()
    expect(doc.querySelector("thead")?.className).toContain("[&_th]:sticky")
    expect(doc.body.textContent).toContain("Trinity’s bar is cut off")
  })

  test("the phone summary leaves out the sorted figure", () => {
    const doc = render()
    const summary = doc.querySelector("tbody tr p")?.textContent ?? ""
    expect(summary).not.toContain("endowment")
    expect(summary).toContain("net assets")
    expect(summary).toContain("income")
  })
})
