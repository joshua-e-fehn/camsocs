/**
 * Descriptions are stored as plain text or light markdown (SU profiles are
 * converted HTML, Camdram writes markdown). This reads the few markdown forms
 * that occur — paragraphs, line breaks, bullet and numbered lists, `**bold**`,
 * `*italic*`, `[text](url)` — plus bare http(s) URLs, into a small tree that
 * `components/molecules/rich-text.tsx` renders as React elements.
 *
 * Never HTML: nothing here produces markup, so a scraped page cannot inject
 * any. Links are only ever http(s); a `[text](javascript:…)` stays text.
 * Anything not recognised is shown as written.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }

export type Block =
  /** Lines of one paragraph (rendered with line breaks between them). */
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  /** A markdown heading line (`## Auditions`), shown as a bold line. */
  | { kind: "heading"; children: Inline[] }

const BULLET = /^\s*(?:[-*•–]|\d{1,3}[.)])\s+/
const ORDERED = /^\s*\d{1,3}[.)]\s+/
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/

// One alternative per form; the first that matches at a position wins.
//  1 link text, 2 link URL — [text](https://…)
//  3 **strong** / 4 __strong__
//  5 *em* (not inside a word, so `2*3*4` stays text)
//  6 a bare http(s) URL, without trailing punctuation
const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)([^*\n]+?)\*\*|__(?=\S)([^_\n]+?)__|(?<![\w*])\*(?=[^\s*])([^*\n]+?)\*(?![\w*])|(https?:\/\/[^\s<>"]+[^\s<>".,;:!?')\]])/g

/** Inline markdown of one line. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  const push = (part: string) => {
    if (part === "") return
    const previous = out[out.length - 1]
    if (previous?.kind === "text") previous.text += part
    else out.push({ kind: "text", text: part })
  }
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    push(text.slice(last, index))
    last = index + match[0].length
    const [, linkText, linkHref, strong1, strong2, em, bare] = match
    if (linkText !== undefined && linkHref !== undefined) {
      out.push({ kind: "link", href: linkHref, children: parseInline(linkText) })
    } else if (strong1 !== undefined || strong2 !== undefined) {
      out.push({ kind: "strong", children: parseInline(strong1 ?? strong2 ?? "") })
    } else if (em !== undefined) {
      out.push({ kind: "em", children: parseInline(em) })
    } else if (bare !== undefined) {
      out.push({ kind: "link", href: bare, children: [{ kind: "text", text: bare }] })
    }
  }
  push(text.slice(last))
  return out
}

/** A description as blocks: paragraphs split on blank lines; a paragraph whose
 * every line is a bullet (`-`, `*`, `•`, `1.`) is a list. */
export function parseRichText(text: string): Block[] {
  const blocks: Block[] = []
  const chunks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
  for (const chunk of chunks) {
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 1) {
      const heading = HEADING.exec(lines[0])
      if (heading?.[1]) {
        blocks.push({ kind: "heading", children: parseInline(heading[1]) })
        continue
      }
    }
    if (lines.every((line) => BULLET.test(line))) {
      blocks.push({
        kind: "list",
        ordered: lines.every((line) => ORDERED.test(line)),
        items: lines.map((line) => parseInline(line.replace(BULLET, ""))),
      })
      continue
    }
    blocks.push({ kind: "paragraph", lines: lines.map(parseInline) })
  }
  return blocks
}

/** The words of a tree, without markup — for a summary or a test. */
export function plainText(inlines: Inline[]): string {
  return inlines
    .map((node) => (node.kind === "text" ? node.text : plainText(node.children)))
    .join("")
}

/** How a bare URL reads in text: host and path, shortened ("forms.gle/dRGymNd…"). */
export function shortUrl(href: string, max = 40): string {
  try {
    const url = new URL(href)
    const text = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}${url.search}`
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  } catch {
    return href
  }
}
