import { describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { CollegeWealthTable } from "@/components/organisms/college-wealth-table"
import { COLLEGE_WEALTH, UNIVERSITY_ENDOWMENT, wealthTable } from "@/lib/college-wealth"
import { collegeHubPath } from "@/lib/directory-hubs"

function render(withUniversityData = false): Document {
  const html = renderToString(
    <CollegeWealthTable
      table={wealthTable(
        COLLEGE_WEALTH,
        collegeHubPath,
        withUniversityData ? UNIVERSITY_ENDOWMENT : null,
      )}
    />,
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

describe("CollegeWealthTable: the University checkbox", () => {
  const LABEL = "Include the University of Cambridge (not a college)"

  test("no checkbox without the University's figures", () => {
    expect(render().body.textContent).not.toContain(LABEL)
  })

  test("off by default: the server's HTML has the colleges alone", () => {
    const doc = render(true)
    expect(doc.body.textContent).toContain(LABEL)
    expect(doc.querySelector("[role=checkbox]")?.getAttribute("aria-checked")).toBe("false")
    expect(doc.querySelectorAll("tbody tr")).toHaveLength(31)
    expect(doc.querySelector("#university-of-cambridge")).toBeNull()
    expect(doc.querySelector('a[href="#university"]')?.textContent).toBe(
      "About the University’s endowment",
    )
  })

  test("ticking it adds the University, unranked, with its marker and source", async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <CollegeWealthTable
          table={wealthTable(COLLEGE_WEALTH, collegeHubPath, UNIVERSITY_ENDOWMENT)}
        />,
      )
    })
    const checkbox = host.querySelector<HTMLButtonElement>("[role=checkbox]")
    expect(checkbox).not.toBeNull()
    await act(async () => checkbox?.click())

    expect(checkbox?.getAttribute("aria-checked")).toBe("true")
    const rows = host.querySelectorAll("tbody tr")
    expect(rows).toHaveLength(32)
    const uni = host.querySelector("#university-of-cambridge")
    // Largest endowment, so first in order; the colleges' ranks start at Trinity.
    expect(rows[0]).toBe(uni as Element)
    expect(uni?.getAttribute("data-kind")).toBe("university")
    expect(uni?.querySelector("td")?.textContent).toContain("Not ranked: not a college")
    expect(uni?.textContent).toContain("University of Cambridge")
    expect(uni?.textContent).toContain("University")
    expect(uni?.textContent).toContain("£4.14bn")
    expect(uni?.querySelector("svg.lucide-landmark")).not.toBeNull()
    expect(uni?.querySelector("img")).toBeNull()
    expect(uni?.querySelector(`a[href="${UNIVERSITY_ENDOWMENT.sourceUrl}"]`)).not.toBeNull()
    expect(rows[1].querySelector("td")?.textContent).toBe("1")
    expect(rows[1].textContent).toContain("Trinity")
    expect(host.textContent).toContain("The University’s bar is cut off")
    expect(host.textContent).toContain("no rank number")
    const live = [...host.querySelectorAll("[aria-live=polite]")].map((n) => n.textContent)
    expect(live).toContain("University of Cambridge added to the ranking, without a rank number.")

    // Per student it has no figure: last, and no bar to call cut off.
    const perStudent = [...host.querySelectorAll<HTMLButtonElement>("thead button")].find((b) =>
      b.textContent?.includes("Per student"),
    )
    expect(perStudent).toBeDefined()
    await act(async () => perStudent?.click())
    expect(host.querySelectorAll("tbody tr")[31]).toBe(
      host.querySelector("#university-of-cambridge") as Element,
    )
    expect(host.textContent).not.toContain("The University’s bar is cut off")
    expect(host.textContent).not.toContain("Infinity")

    await act(async () => checkbox?.click())
    expect(host.querySelectorAll("tbody tr")).toHaveLength(31)
    expect(host.querySelector("#university-of-cambridge")).toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })
})
