import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RichText } from "@/components/molecules/rich-text"

/** What a description becomes on the page: the markup React writes. */
const render = (text: string) => renderToStaticMarkup(<RichText text={text} />)

describe("RichText", () => {
  test("renders markdown as elements, with no markers left", () => {
    const html = render(
      "### [***Get your membership here***](http://www.german-society.org/member/)\n\nFounded in 1908.\nWe meet weekly.\n\n- **Talks**\n- Socials\n\n3. third",
    )
    expect(html).toContain(
      '<a href="http://www.german-society.org/member/" target="_blank" rel="noopener noreferrer nofollow"',
    )
    expect(html).toContain("<em><strong")
    expect(html).toContain("Founded in 1908.<br/>We meet weekly.")
    expect(html).toContain('<ul class="flex list-disc')
    expect(html).toContain('<ol start="3"')
    expect(html).not.toMatch(/\*|###|\]\(/)
  })

  test("every link opens in a new tab without referrer or ranking", () => {
    const html = render(
      "[site](https://cuchess.org) https://forms.gle/dRGymNdTovSaJuEc8 [mail](mailto:hello@cuchess.org)",
    )
    const anchors = html.match(/<a [^>]*>/g) ?? []
    expect(anchors).toHaveLength(3)
    for (const anchor of anchors) {
      expect(anchor).toContain('target="_blank"')
      expect(anchor).toContain('rel="noopener noreferrer nofollow"')
    }
    // A bare URL reads as host and path.
    expect(html).toContain(">forms.gle/dRGymNdTovSaJuEc8<")
    expect(html).toContain('href="mailto:hello@cuchess.org"')
  })

  test("XSS vectors render as inert text", () => {
    const vectors = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      "[click](javascript:alert(1))",
      "[click](JaVaScRiPt:alert(1))",
      "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "<javascript:alert(1)>",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      '<svg onload="alert(1)"><circle/></svg>',
      '[x](https://ok.example"onmouseover="alert(1))',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      "<style>body{display:none}</style>",
    ]
    for (const vector of vectors) {
      const html = render(vector)
      expect(html).not.toMatch(/<(script|img|iframe|svg|style)\b/i)
      expect(html).not.toMatch(/\son[a-z]+=/i)
      expect(html).not.toMatch(/href="(?!https?:\/\/|mailto:)/i)
      for (const href of html.match(/href="[^"]*"/g) ?? []) {
        expect(href).toMatch(/^href="(https?:\/\/|mailto:)/)
        expect(href).not.toMatch(/javascript|data:/i)
      }
    }
    // An escaped tag is shown as the text it is, escaped by React.
    expect(render("&lt;script&gt;alert(1)&lt;/script&gt;")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    )
  })
})
