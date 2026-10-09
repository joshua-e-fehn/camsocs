import { describe, expect, test } from "bun:test"
import { parseInline, parseRichText, plainText, shortUrl } from "./rich-text"

describe("parseInline", () => {
  test("bold, italic and links become nodes; the rest stays text", () => {
    expect(parseInline("**MAGPIE** (working title) is *short*")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "MAGPIE" }] },
      { kind: "text", text: " (working title) is " },
      { kind: "em", children: [{ kind: "text", text: "short" }] },
    ])
    expect(parseInline("see [our site](https://cuadc.org/join) now")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "https://cuadc.org/join",
        children: [{ kind: "text", text: "our site" }],
      },
      { kind: "text", text: " now" },
    ])
  })

  test("bare http(s) URLs are links, without trailing punctuation", () => {
    const nodes = parseInline("Check out our website: https://cueims.soc.srcf.net/.")
    expect(nodes).toEqual([
      { kind: "text", text: "Check out our website: " },
      {
        kind: "link",
        href: "https://cueims.soc.srcf.net/",
        children: [{ kind: "text", text: "https://cueims.soc.srcf.net/" }],
      },
      { kind: "text", text: "." },
    ])
  })

  test("never links anything but http(s)", () => {
    for (const text of [
      "[click](javascript:alert(1))",
      "[mail](mailto:someone@example.org)",
      "ftp://example.org/file",
      "data:text/html,<b>x</b>",
    ]) {
      expect(parseInline(text).some((node) => node.kind === "link")).toBe(false)
      expect(plainText(parseInline(text))).toBe(text)
    }
  })

  test("asterisks inside words and lone ones stay text", () => {
    expect(plainText(parseInline("2*3*4 and * alone"))).toBe("2*3*4 and * alone")
    expect(parseInline("2*3*4").every((node) => node.kind === "text")).toBe(true)
  })

  test("withheld markers are kept as written", () => {
    expect(parseInline("Join our WhatsApp: [chat invite link withheld].")).toEqual([
      { kind: "text", text: "Join our WhatsApp: [chat invite link withheld]." },
    ])
  })
})

describe("parseRichText", () => {
  test("paragraphs, line breaks, lists and headings", () => {
    const blocks = parseRichText(
      "## Auditions\n\nFirst line\nsecond line\n\n- one\n- **two**\n\n1. a\n2. b",
    )
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list"])
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      lines: [[{ kind: "text", text: "First line" }], [{ kind: "text", text: "second line" }]],
    })
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false })
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true })
  })

  test("blank input gives nothing", () => {
    expect(parseRichText("  \n\n ")).toEqual([])
  })
})

test("shortUrl shows host and path, shortened", () => {
  expect(shortUrl("https://www.cuadc.org/get-involved/membership/")).toBe(
    "cuadc.org/get-involved/membership/",
  )
  expect(shortUrl("https://forms.gle/dRGymNdTovSaJuEc8", 18)).toBe("forms.gle/dRGymNd…")
  expect(shortUrl("not a url")).toBe("not a url")
})
