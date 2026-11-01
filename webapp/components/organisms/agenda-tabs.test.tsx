import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { AgendaTabs } from "@/components/organisms/agenda-tabs"

let root: Root | undefined

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(node))
  return container
}

afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ""
})

const TABS = [
  {
    id: "events",
    label: "Events",
    accent: "events" as const,
    count: 3,
    link: { href: "/events", label: "The full calendar" },
    content: <p>events list</p>,
  },
  {
    id: "talks",
    label: "Talks",
    accent: "talks" as const,
    count: 5,
    link: { href: "/talks", label: "All talks" },
    content: <p>talks list</p>,
  },
]

function headerLink(container: HTMLElement) {
  return [...container.querySelectorAll("a")].find(
    (a) => a.textContent?.includes("The full calendar") || a.textContent?.includes("All talks"),
  )
}

describe("AgendaTabs", () => {
  test("the header link belongs to the open tab", async () => {
    const container = await render(<AgendaTabs heading={<h2>This week</h2>} tabs={TABS} />)
    expect(container.querySelector("h2")?.textContent).toBe("This week")
    let link = headerLink(container)
    expect(link?.getAttribute("href")).toBe("/events")
    expect(link?.className).toContain("text-events")

    const talksTab = [...container.querySelectorAll('[role="tab"]')].find((tab) =>
      tab.textContent?.includes("Talks"),
    ) as HTMLElement
    await act(async () => {
      talksTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    })
    link = headerLink(container)
    expect(link?.getAttribute("href")).toBe("/talks")
    expect(link?.textContent).toContain("All talks")
    expect(link?.className).toContain("text-talks")
  })

  test("a single tab still shows its link", async () => {
    const container = await render(<AgendaTabs tabs={[TABS[0]]} />)
    expect(headerLink(container)?.getAttribute("href")).toBe("/events")
    expect(container.querySelector('[role="tab"]')).toBeNull()
  })
})
