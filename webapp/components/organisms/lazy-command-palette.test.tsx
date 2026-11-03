import { afterEach, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { openPalette, type PaletteRequest } from "@/lib/palette"

/**
 * The palette's code is loaded on first use, not with the page
 * (mobile-lcp-js-weight), and the request that loaded it still opens it as
 * asked. The real palette needs Convex; a stand-in shows what it was given.
 */
const loaded: (PaletteRequest | undefined)[] = []
mock.module("@/components/organisms/command-palette", () => ({
  CommandPalette: ({ initialRequest }: { initialRequest?: PaletteRequest }) => {
    loaded.push(initialRequest)
    return <div data-testid="palette">{JSON.stringify(initialRequest)}</div>
  },
}))

const { LazyCommandPalette } = await import("@/components/organisms/lazy-command-palette")

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  loaded.length = 0
  document.body.innerHTML = ""
})

async function mount() {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(<LazyCommandPalette />))
  return container
}

/** Lets the dynamic import resolve and React render what it loaded. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

test("renders nothing until asked", async () => {
  const container = await mount()
  await settle()
  expect(container.querySelector("[data-testid=palette]")).toBeNull()
})

test("an open request loads the palette and hands it the request", async () => {
  const container = await mount()
  await act(async () => openPalette({ query: "chess", scope: "societies" }))
  await settle()
  expect(container.querySelector("[data-testid=palette]")?.textContent).toBe(
    JSON.stringify({ query: "chess", scope: "societies" }),
  )
})

test("⌘K loads it too, and the browser's own shortcut is prevented", async () => {
  const container = await mount()
  const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })
  await act(async () => window.dispatchEvent(event))
  await settle()
  expect(event.defaultPrevented).toBe(true)
  expect(container.querySelector("[data-testid=palette]")?.textContent).toBe("{}")
})
