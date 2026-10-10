import { describe, expect, test } from "bun:test"
import {
  type Inline,
  parseInline,
  parseRichText,
  plainLine,
  plainText,
  safeHref,
  shortUrl,
  summary,
} from "./rich-text"

const text = (value: string): Inline => ({ kind: "text", text: value })
const strong = (...children: Inline[]): Inline => ({ kind: "strong", children })
const em = (...children: Inline[]): Inline => ({ kind: "em", children })

/** Every link target anywhere in a tree. */
function hrefs(nodes: Inline[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "link"
      ? [node.href, ...hrefs(node.children)]
      : node.kind === "strong" || node.kind === "em"
        ? hrefs(node.children)
        : [],
  )
}

describe("parseInline", () => {
  test("bold, italic and links become nodes; the rest stays text", () => {
    expect(parseInline("**MAGPIE** (working title) is *short*")).toEqual([
      strong(text("MAGPIE")),
      text(" (working title) is "),
      em(text("short")),
    ])
    expect(parseInline("see [our site](https://cuadc.org/join) now")).toEqual([
      text("see "),
      { kind: "link", href: "https://cuadc.org/join", children: [text("our site")] },
      text(" now"),
    ])
    expect(parseInline("__strong__ and _em_")).toEqual([
      strong(text("strong")),
      text(" and "),
      em(text("em")),
    ])
  })

  test("three asterisks are bold and italic, not a stray asterisk around bold", () => {
    // The German Society's SU profile: a bold-italic link heading.
    expect(parseInline("***Get your German Society Membership here***")).toEqual([
      em(strong(text("Get your German Society Membership here"))),
    ])
    expect(
      parseInline(
        "[***Get your German Society Membership here***](http://www.german-society.org/member/)",
      ),
    ).toEqual([
      {
        kind: "link",
        href: "http://www.german-society.org/member/",
        children: [em(strong(text("Get your German Society Membership here")))],
      },
    ])
    expect(parseInline("**Founder & *Immediate Past President***")).toEqual([
      strong(text("Founder & "), em(text("Immediate Past President"))),
    ])
  })

  test("two bold runs written side by side stay two bold runs", () => {
    expect(parseInline("**Committee****(2026–27)**")).toEqual([
      strong(text("Committee")),
      strong(text("(2026–27)")),
    ])
    expect(parseInline("**Positions are open.****For details, ask us.**")).toEqual([
      strong(text("Positions are open.")),
      strong(text("For details, ask us.")),
    ])
  })

  test("emphasis around a link and right next to words", () => {
    expect(parseInline("**[website](https://x.org/)**")).toEqual([
      strong({ kind: "link", href: "https://x.org/", children: [text("website")] }),
    ])
    expect(parseInline("**Academic Training:**Research and **FAQ:**https://x.org/faq")).toEqual([
      strong(text("Academic Training:")),
      text("Research and "),
      strong(text("FAQ:")),
      {
        kind: "link",
        href: "https://x.org/faq",
        bare: true,
        children: [text("https://x.org/faq")],
      },
    ])
    expect(parseInline("the *CJHB*will follow")).toEqual([
      text("the "),
      em(text("CJHB")),
      text("will follow"),
    ])
  })

  test("asterisks that open or close nothing stay as written", () => {
    expect(plainText(parseInline("against O*ford"))).toBe("against O*ford")
    expect(plainText(parseInline("5 * 3 = 15 and * alone"))).toBe("5 * 3 = 15 and * alone")
    expect(parseInline("f**k").every((node) => node.kind === "text")).toBe(true)
    expect(plainText(parseInline("*** NB: do not sign up here ***"))).toBe(
      "*** NB: do not sign up here ***",
    )
    expect(plainText(parseInline("snake_case_name and a_b"))).toBe("snake_case_name and a_b")
  })

  test("backslash escapes and entities are characters", () => {
    expect(parseInline("\\*not em\\* &amp; 5 &lt; 6 &#8217; &#x2014; &bogus;")).toEqual([
      text("*not em* & 5 < 6 ’ — &bogus;"),
    ])
  })

  test("an address written with entities is never decoded", () => {
    // Obfuscation: the server's address checks never saw "ab123@cam.ac.uk".
    expect(plainText(parseInline("ab123&#64;cam.ac.uk and j&#x40;example&#46;org"))).toBe(
      "ab123&#64;cam.ac.uk and j&#x40;example&#46;org",
    )
    expect(plainText(parseInline("&#97;&#98;&#99;"))).toBe("&#97;&#98;&#99;")
    // Punctuation and typography still decode.
    expect(plainText(parseInline("it&#39;s &#38; &#8212;"))).toBe("it's & —")
  })

  test("bare and angle-bracket URLs are links, without trailing punctuation", () => {
    expect(parseInline("Check out our website: https://cueims.soc.srcf.net/.")).toEqual([
      text("Check out our website: "),
      {
        kind: "link",
        href: "https://cueims.soc.srcf.net/",
        bare: true,
        children: [text("https://cueims.soc.srcf.net/")],
      },
      text("."),
    ])
    expect(hrefs(parseInline("(see https://en.wikipedia.org/wiki/Bumps_(rowing))"))).toEqual([
      "https://en.wikipedia.org/wiki/Bumps_(rowing)",
    ])
    expect(hrefs(parseInline("(form: https://forms.gle/abc)"))).toEqual(["https://forms.gle/abc"])
    expect(hrefs(parseInline("<https://camsocs.vercel.app/about>"))).toEqual([
      "https://camsocs.vercel.app/about",
    ])
    // Underscores in a URL are never emphasis.
    expect(
      hrefs(parseInline("https://docs.google.com/forms/d/e/1F_aq/viewform?usp=sf_link and _x_")),
    ).toEqual(["https://docs.google.com/forms/d/e/1F_aq/viewform?usp=sf_link"])
  })

  test("a mailto link with one plain address is kept", () => {
    expect(parseInline("[email us](mailto:hello@cuchess.org?subject=Hi)")).toEqual([
      { kind: "link", href: "mailto:hello@cuchess.org", children: [text("email us")] },
    ])
  })

  test("withheld markers and bracketed words are kept as written", () => {
    expect(parseInline("Join our WhatsApp: [chat invite link withheld].")).toEqual([
      text("Join our WhatsApp: [chat invite link withheld]."),
    ])
    expect(parseInline("Write to [address removed] (the secretary)")).toEqual([
      text("Write to [address removed] (the secretary)"),
    ])
  })

  test("HTML tags are dropped, their words kept", () => {
    expect(plainText(parseInline("<b>Homerton Amateur Theatrical Society</b> is"))).toBe(
      "Homerton Amateur Theatrical Society is",
    )
    expect(plainText(parseInline("x < y and y > z, <3, a<b"))).toBe("x < y and y > z, <3, a<b")
  })

  test("images show their alt text, never the image", () => {
    expect(parseInline("![Our poster](https://x.org/p.png) here")).toEqual([
      text("Our poster here"),
    ])
  })
})

describe("sanitisation: nothing but http(s) and mailto ever becomes a link", () => {
  const vectors = [
    "[click](javascript:alert(1))",
    "[click](JAVASCRIPT:alert(1))",
    "[click]( javascript:alert(1))",
    "[click](java\tscript:alert(1))",
    "[click](javascript&colon;alert(1))",
    "[click](&#106;avascript:alert(1))",
    "[click](<javascript:alert(1)>)",
    "[click](vbscript:msgbox(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[click](//evil.example/x)",
    "[click](/relative/path)",
    "[click](file:///etc/passwd)",
    "[click](mailto:javascript:alert(1)@x)",
    "[click](mailto:[address removed])",
    "<javascript:alert(1)>",
    "<data:text/html,<script>alert(1)</script>>",
    "javascript:alert(1)",
    "ftp://example.org/file",
    "![x](javascript:alert(1))",
    '<a href="javascript:alert(1)">click</a>',
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>after",
    '<iframe src="https://evil.example"></iframe>',
    '[click](https://ok.example" onmouseover="alert(1))',
  ]

  for (const vector of vectors) {
    test(JSON.stringify(vector), () => {
      const blocks = parseRichText(vector)
      const nodes = blocks.flatMap((block) =>
        block.kind === "list" ? block.items.flat() : block.children,
      )
      for (const href of hrefs(nodes)) {
        expect(href).toMatch(/^(https?:\/\/[^\s"<>]+|mailto:[^\s"<>]+@[^\s"<>]+)$/)
      }
      const words = plainText(nodes)
      expect(words).not.toMatch(/<script|<img|<iframe|onerror=/i)
      expect(hrefs(nodes).join(" ")).not.toMatch(/javascript|vbscript|data:/i)
    })
  }

  test("safeHref", () => {
    expect(safeHref("https://cuadc.org/join")).toBe("https://cuadc.org/join")
    expect(safeHref("  HTTP://Example.ORG")).toBe("http://example.org/")
    expect(safeHref("mailto:hello@cuchess.org")).toBe("mailto:hello@cuchess.org")
    expect(safeHref("mailto:hello%40cuchess.org")).toBe("mailto:hello@cuchess.org")
    for (const bad of [
      "javascript:alert(1)",
      "java\nscript:alert(1)",
      "https://",
      "mailto:",
      "mailto:a@b",
      "mailto:%E0%A4%A",
      "tel:+441223000000",
      "",
    ]) {
      expect(safeHref(bad)).toBeUndefined()
    }
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
      children: [text("First line"), { kind: "break" }, text("second line")],
    })
    expect(blocks[2]).toEqual({
      kind: "list",
      ordered: false,
      items: [[text("one")], [strong(text("two"))]],
    })
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true })
    expect(blocks[3]).not.toHaveProperty("start")
  })

  test("a list right after a paragraph's first line is still a list", () => {
    const blocks = parseRichText(
      "Membership includes:\n- Use of club equipment\n- Coaching\nSign up below.",
    )
    expect(blocks).toEqual([
      { kind: "paragraph", children: [text("Membership includes:")] },
      {
        kind: "list",
        ordered: false,
        items: [[text("Use of club equipment")], [text("Coaching")]],
      },
      { kind: "paragraph", children: [text("Sign up below.")] },
    ])
  })

  test("bullets of every kind, nested items and numbered lists that start late", () => {
    const blocks = parseRichText(
      "* **Cultural Events:** celebrations\n• Talks\n– Socials\n  - Formals\n\n3. third\n4. fourth",
    )
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false })
    expect(blocks[0].kind === "list" && blocks[0].items.length).toBe(4)
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true, start: 3 })
  })

  test("an indented line continues the item above it", () => {
    expect(parseRichText("- Mondays\n  7pm, Old Divinity School")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[text("Mondays"), { kind: "break" }, text("7pm, Old Divinity School")]],
      },
    ])
  })

  test("emphasis may span a line break inside a paragraph", () => {
    expect(parseRichText("**Join us\nevery week**")).toEqual([
      {
        kind: "paragraph",
        children: [strong(text("Join us"), { kind: "break" }, text("every week"))],
      },
    ])
  })

  test("rules, fences, quote markers and empty headings are not shown", () => {
    expect(parseRichText("---\n\n> quoted words\n\n```\ncode\n```\n\n#\n\n*****")).toEqual([
      { kind: "paragraph", children: [text("quoted words")] },
      { kind: "paragraph", children: [text("code")] },
    ])
  })

  test("a hashtag is not a heading", () => {
    expect(parseRichText("#feelgooddogood")).toEqual([
      { kind: "paragraph", children: [text("#feelgooddogood")] },
    ])
  })

  test("HTML block tags become paragraph and line breaks", () => {
    expect(parseRichText("<p>One<br>two</p><p>Three</p>")).toEqual([
      { kind: "paragraph", children: [text("One"), { kind: "break" }, text("two")] },
      { kind: "paragraph", children: [text("Three")] },
    ])
  })

  test("blank input gives nothing", () => {
    expect(parseRichText("  \n\n ")).toEqual([])
  })

  test("long unclosed brackets do not stall the parser", () => {
    const started = performance.now()
    parseRichText(`${"[".repeat(20_000)}x ${"*".repeat(5_000)} y`)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("plain text for cards and meta descriptions", () => {
  const german =
    "### [***Get your German Society Membership here***](http://www.german-society.org/member/)\n\nFounded in 1908, our Society looks back on over 100 years of Anglo-German friendship. We\nseek to create a platform for all students."

  test("plainLine drops the markup and runs the blocks together as sentences", () => {
    expect(plainLine(german)).toBe(
      "Get your German Society Membership here. Founded in 1908, our Society looks back on over 100 years of Anglo-German friendship. We seek to create a platform for all students.",
    )
    expect(plainLine("Benefits:\n- **Coaching**\n- Kit\n\nJoin [here](https://x.org).")).toBe(
      "Benefits: Coaching. Kit. Join here.",
    )
    expect(plainLine("<b>HATS</b> funds drama &amp; more")).toBe("HATS funds drama & more")
    expect(plainLine("Sign up: https://forms.gle/abc")).toBe("Sign up: https://forms.gle/abc")
  })

  test("summary cuts at a word and ends with an ellipsis", () => {
    const cut = summary(german, 80)
    expect(cut.length).toBeLessThanOrEqual(80)
    expect(cut).toBe("Get your German Society Membership here. Founded in 1908, our Society looks…")
    expect(summary("Short and *sweet*.", 160)).toBe("Short and sweet.")
  })
})

test("shortUrl shows host and path, shortened", () => {
  expect(shortUrl("https://www.cuadc.org/get-involved/membership/")).toBe(
    "cuadc.org/get-involved/membership/",
  )
  expect(shortUrl("https://forms.gle/dRGymNdTovSaJuEc8", 18)).toBe("forms.gle/dRGymNd…")
  expect(shortUrl("mailto:hello@cuchess.org")).toBe("hello@cuchess.org")
  expect(shortUrl("not a url")).toBe("not a url")
})
