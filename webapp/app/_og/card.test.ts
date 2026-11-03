import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readFont, renderCard, youngSerif } from "./card"

// Review of the SEO audit 2026-11-02 (og-card-third-party): Young Serif is
// read from the vendored file, so no card's text leaves for a font service.

const FONTS = join(import.meta.dir, "fonts")
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("the share card's font", () => {
  test("is the vendored TrueType file, with its licence beside it", async () => {
    const font = await readFont(join(FONTS, "YoungSerif-Regular.ttf"))
    expect(font).not.toBeNull()
    // sfnt version 1.0: a TrueType font, which the renderer reads (not WOFF2).
    expect([...new Uint8Array(font as ArrayBuffer, 0, 4)]).toEqual([0, 1, 0, 0])
    expect(readFileSync(join(FONTS, "OFL.txt"), "utf8")).toContain("SIL Open Font License")
  })

  test("the cards read it from the path the build traces (webapp/ is the working directory)", async () => {
    const font = await youngSerif()
    expect(font?.byteLength).toBe(readFileSync(join(FONTS, "YoungSerif-Regular.ttf")).byteLength)
  })

  test("a file that cannot be read is null, so the card falls back", async () => {
    expect(await readFont(join(FONTS, "missing.ttf"))).toBeNull()
  })

  test("a card renders with no request at all (crest, no logo)", async () => {
    const requested: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      // The renderer loads its own WebAssembly from a data: URL; nothing else goes.
      if (url.startsWith("data:")) return realFetch(input, init)
      requested.push(url)
      throw new Error("no network in this test")
    }) as typeof fetch
    // A synthetic event; the text is what used to travel as `text=`.
    const response = await renderCard({
      text: { eyebrow: "Invented Society", headline: "Synthetic marker night", detail: "A hall" },
      footLeft: "camsocs.uk",
    })
    const png = new Uint8Array(await response.arrayBuffer())
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(requested).toEqual([])
  })
})
