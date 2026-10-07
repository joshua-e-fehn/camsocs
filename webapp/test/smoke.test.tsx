import { describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"

/**
 * Proves the DOM harness (test/setup.ts) works: a real shadcn component renders
 * into happy-dom through React 19. If this fails, every future component test
 * would fail for a harness reason rather than its own.
 */
describe("DOM harness", () => {
  test("renders a component into the document", async () => {
    const container = document.createElement("div")
    document.body.append(container)
    // React warns outside an act environment; this flag is how tests opt in.
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

    const root = createRoot(container)
    await act(async () => {
      root.render(<Button>Find a society</Button>)
    })

    const button = container.querySelector("button")
    expect(button?.textContent).toBe("Find a society")
    await act(async () => root.unmount())
  })
})
