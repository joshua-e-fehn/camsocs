/**
 * Descriptions are stored as plain text or light markdown: SU profiles are
 * HTML converted by the pipeline (`pipeline/.../sources/markdown.py`), Camdram
 * and society sites write markdown, the bulk model writes plain text. This
 * reads that markdown into a small tree that `components/molecules/rich-text.tsx`
 * renders as React elements, and into plain text for meta descriptions and
 * cards.
 *
 * What it reads: paragraphs (every line break kept), headings (shown as a bold
 * line), bullet and numbered lists, `**strong**` / `__strong__`, `*em*` /
 * `_em_`, `[text](url)`, `<url>`, bare http(s) URLs, backslash escapes and
 * HTML entities. Emphasis is matched as CommonMark matches it (so
 * `***both***`, `**a *b***` and `O*ford` come out right), with two readings of
 * the converter's own output where CommonMark would show the asterisks: an
 * asterisk run opens before any non-space and closes after one
 * (`**Label:**Text`, a bold label whose space ended up outside it), and
 * `**A****B**` is two bold runs side by side.
 *
 * Never HTML. Nothing here produces markup: tags in the text are dropped (a
 * script or style element with its content), and only the words reach the
 * page, as React text. Links are only ever http(s) or a `mailto:` with one
 * plain address; any other target (`javascript:`, `data:`, relative paths)
 * keeps its words and loses the link. Images are never shown: their alt text
 * is.
 */

import { isEmail } from "./syntax"

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  /** `bare`: the text was the URL itself (`https://…`, `<https://…>`), shown shortened. */
  | { kind: "link"; href: string; children: Inline[]; bare?: boolean }
  /** A line break inside a paragraph or list item. */
  | { kind: "break" }

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  /** `start`: the first number of a numbered list, when it is not 1. */
  | { kind: "list"; ordered: boolean; start?: number; items: Inline[][] }
  /** A markdown heading line (`## Auditions`), shown as a bold line. */
  | { kind: "heading"; children: Inline[] }

// --- links -----------------------------------------------------------------------------------

/**
 * The `href` a link may have, or undefined: an absolute http(s) URL with a
 * host (as the URL parser reads it, so `java\tscript:` or ` javascript:` are
 * refused like `javascript:`), or `mailto:` one plain address (its query —
 * subject, body, more recipients — is dropped).
 */
export function safeHref(raw: string): string | undefined {
  const value = raw.trim()
  if (/^mailto:/i.test(value)) {
    let address: string
    try {
      address = decodeURIComponent(value.slice("mailto:".length).split("?")[0])
    } catch {
      return undefined
    }
    return isEmail(address) ? `mailto:${address}` : undefined
  }
  if (!/^https?:\/\//i.test(value)) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** How a bare URL reads in text: host and path, shortened ("forms.gle/dRGymNd…"). */
export function shortUrl(href: string, max = 40): string {
  if (href.startsWith("mailto:")) return href.slice("mailto:".length)
  try {
    const url = new URL(href)
    const text = `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}${url.search}`
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  } catch {
    return href
  }
}

// --- HTML in the text -------------------------------------------------------------------------

/** Elements whose content is code or chrome, never words to show. */
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|svg|math|template|noscript|textarea|select|title|head)\b[\s\S]*?<\/\1\s*>/gi
/** Tags that end a paragraph or start a line. */
const BLOCK_TAG =
  /<\/?(?:p|div|section|article|header|footer|aside|main|nav|blockquote|table|thead|tbody|tr|ul|ol|dl|dt|dd|h[1-6]|center|pre|figure|figcaption|form|fieldset)\b[^<>]*>/gi
const LINE_TAG = /<(?:br|hr)\b[^<>]*\/?>/gi
const LIST_ITEM_TAG = /<li\b[^<>]*>/gi
/** Any other tag of HTML's vocabulary: dropped, its words kept. Named, so a
 * text like "a <b and c> d" or "<https://…>" is not mistaken for one. */
const OTHER_TAG =
  /<\/?(?:a|abbr|b|bdi|bdo|big|button|caption|cite|code|col|colgroup|data|del|details|dfn|em|font|i|img|input|ins|kbd|label|legend|li|link|mark|meta|option|picture|q|s|samp|small|source|span|strike|strong|sub|summary|sup|td|th|time|tt|u|var|video|audio|wbr|base|body|html|frame|frameset|iframe|object|embed|script|style|svg|template|noscript|textarea|select|title|head)\b(?:\s[^<>]*)?\/?>/gi
const COMMENT = /<!--[\s\S]*?-->/g

/** Text with HTML tags taken out: never rendered, so only their words stay. */
function withoutHtml(text: string): string {
  if (!text.includes("<")) return text
  return text
    .replace(COMMENT, "")
    .replace(DROP_WITH_CONTENT, "")
    .replace(LINE_TAG, "\n")
    .replace(LIST_ITEM_TAG, "\n- ")
    .replace(BLOCK_TAG, "\n\n")
    .replace(OTHER_TAG, "")
}

// --- inline ----------------------------------------------------------------------------------

/** A run of `*` or `_` while emphasis is being matched (CommonMark §6.2). */
type Delimiter = {
  kind: "delimiter"
  char: "*" | "_"
  /** Characters still unmatched. */
  count: number
  /** The run's length as written, for the "multiple of 3" rule. */
  length: number
  canOpen: boolean
  canClose: boolean
}
type Token = Inline | Delimiter

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/
const PUNCTUATION = /[\p{P}\p{S}]/u
const WHITESPACE = /\s/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

const isWhitespace = (char: string | undefined) => char === undefined || WHITESPACE.test(char)
const isPunctuation = (char: string | undefined) => char !== undefined && PUNCTUATION.test(char)

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  pound: "£",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
}
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/

/**
 * Characters an address is made of. Written as a numeric entity they are
 * obfuscation (`ab123&#64;cam.ac.uk`), which is never decoded (AGENTS.md): the
 * server's address checks ran on the text as stored, so decoding here would
 * show what they never saw (review 2026-10-10). Such an entity is shown as
 * written.
 */
const ADDRESS_CHARACTER = /^[A-Za-z0-9@._+-]$/

/** The character an entity stands for, and its length; undefined if it is none. */
function entityAt(text: string, at: number): { char: string; length: number } | undefined {
  const match = ENTITY.exec(text.slice(at, at + 12))
  if (!match) return undefined
  const [whole, decimal, hex, name] = match
  if (name !== undefined) {
    const char = NAMED_ENTITIES[name]
    return char === undefined ? undefined : { char, length: whole.length }
  }
  const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16)
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
  const char = valid ? String.fromCodePoint(code) : "�"
  if (ADDRESS_CHARACTER.test(char)) return undefined
  return { char, length: whole.length }
}

/** A link's text may not run on forever looking for its `]`. */
const MAX_LABEL = 1000

/** `[label](destination "title")` starting at `at` (a `[`), or undefined. */
function linkAt(
  text: string,
  at: number,
): { label: string; dest: string; end: number } | undefined {
  let depth = 0
  let close = -1
  for (let i = at; i < text.length && i <= at + MAX_LABEL; i++) {
    const char = text[i]
    if (char === "\\") i++
    else if (char === "[") depth++
    else if (char === "]" && --depth === 0) {
      close = i
      break
    }
  }
  if (close < 0 || text[close + 1] !== "(") return undefined
  let i = close + 2
  const skipSpace = () => {
    while (i < text.length && /[ \t\n]/.test(text[i])) i++
  }
  skipSpace()
  let dest = ""
  if (text[i] === "<") {
    const end = text.indexOf(">", i)
    if (end < 0 || /[\n<]/.test(text.slice(i + 1, end))) return undefined
    dest = text.slice(i + 1, end)
    i = end + 1
  } else {
    const start = i
    let parens = 0
    for (; i < text.length; i++) {
      const char = text[i]
      if (char === "\\" && ASCII_PUNCTUATION.test(text[i + 1] ?? "")) i++
      else if (char <= " ") break
      else if (char === "(") parens++
      else if (char === ")") {
        if (parens === 0) break
        parens--
      }
    }
    dest = text.slice(start, i).replace(/\\([!-/:-@[-`{-~])/g, "$1")
  }
  skipSpace()
  const quote = text[i]
  if (quote === '"' || quote === "'" || quote === "(") {
    const end = text.indexOf(quote === "(" ? ")" : quote, i + 1)
    if (end < 0) return undefined
    i = end + 1
    skipSpace()
  }
  if (text[i] !== ")") return undefined
  return { label: text.slice(at + 1, close), dest, end: i + 1 }
}

const AUTOLINK = /^<((?:https?|mailto):[^\s<>]*)>/i
const BARE_URL = /^https?:\/\/[^\s<>]+/i

/** A bare URL's end, without the punctuation that closes the sentence around
 * it (GFM's rule: trailing `.,:;!?*_~'"`, and a `)` or `]` it does not open). */
function trimUrl(url: string): string {
  let out = url
  for (;;) {
    const last = out[out.length - 1]
    if (/[.,:;!?*_~'"]/.test(last)) out = out.slice(0, -1)
    else if (last === ")" && out.split("(").length < out.split(")").length) out = out.slice(0, -1)
    else if (last === "]" && out.split("[").length < out.split("]").length) out = out.slice(0, -1)
    else return out
  }
}

/** A run of `*` / `_` and what it may do, from the characters around it. */
function delimiters(text: string, start: number, end: number): Delimiter[] {
  const char = text[start] as "*" | "_"
  const before = text[start - 1]
  const after = text[end]
  const leftFlanking =
    !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before))
  const rightFlanking =
    !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after))
  const length = end - start
  // The converter writes two bold runs side by side as `**A****B**`: a run of
  // four inside text closes one and opens the next.
  if (char === "*" && length === 4 && !isWhitespace(before) && !isWhitespace(after)) {
    return [
      { kind: "delimiter", char, count: 2, length: 2, canOpen: false, canClose: true },
      { kind: "delimiter", char, count: 2, length: 2, canOpen: true, canClose: false },
    ]
  }
  // An asterisk run opens before any non-space and closes after one. CommonMark
  // also asks about punctuation, and would show the asterisks of the
  // converter's `**Label:**Text` (a bold label whose space went outside it).
  // Underscores keep CommonMark's rules, so `snake_case` is never emphasis.
  const canOpen =
    char === "*" ? !isWhitespace(after) : leftFlanking && (!rightFlanking || isPunctuation(before))
  const canClose =
    char === "*" ? !isWhitespace(before) : rightFlanking && (!leftFlanking || isPunctuation(after))
  return [{ kind: "delimiter", char, count: length, length, canOpen, canClose }]
}

/** Unmatched delimiters become text again; neighbouring texts are joined. */
function settle(tokens: Token[]): Inline[] {
  const out: Inline[] = []
  for (const token of tokens) {
    const node: Inline | undefined =
      token.kind === "delimiter"
        ? token.count > 0
          ? { kind: "text", text: token.char.repeat(token.count) }
          : undefined
        : token
    if (!node) continue
    const previous = out[out.length - 1]
    if (node.kind === "text" && previous?.kind === "text") previous.text += node.text
    else out.push(node.kind === "text" ? { ...node } : node)
  }
  return out
}

/** CommonMark's "process emphasis": each closer, left to right, takes the
 * nearest opener of its character that the rule of three allows; two
 * characters on each side make strong, one makes em. */
function emphasis(tokens: Token[]): Inline[] {
  const list = [...tokens]
  for (let c = 0; c < list.length; c++) {
    const closer = list[c]
    if (closer.kind !== "delimiter" || !closer.canClose || closer.count === 0) continue
    for (let o = c - 1; o >= 0; o--) {
      const opener = list[o]
      if (opener.kind !== "delimiter" || opener.char !== closer.char) continue
      if (!opener.canOpen || opener.count === 0) continue
      const ruleOfThree =
        (opener.canClose || closer.canOpen) &&
        (opener.length + closer.length) % 3 === 0 &&
        !(opener.length % 3 === 0 && closer.length % 3 === 0)
      if (ruleOfThree) continue
      const used = opener.count >= 2 && closer.count >= 2 ? 2 : 1
      opener.count -= used
      closer.count -= used
      const children = settle(list.slice(o + 1, c))
      list.splice(o + 1, c - o - 1, { kind: used === 2 ? "strong" : "em", children })
      // The closer now sits at o + 2; what is left of it looks for another opener.
      c = closer.count > 0 ? o + 1 : o + 2
      break
    }
  }
  return settle(list)
}

/** Inline markdown of a paragraph or list item; `\n` is a line break. Inside a
 * link's text (`links: false`) nothing becomes a link again. */
function inlines(text: string, links: boolean): Inline[] {
  const tokens: Token[] = []
  let buffer = ""
  const flush = () => {
    if (buffer) tokens.push({ kind: "text", text: buffer })
    buffer = ""
  }
  let i = 0
  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]
    if (char === "\\" && next !== undefined && (next === "\n" || ASCII_PUNCTUATION.test(next))) {
      if (next === "\n") {
        flush()
        tokens.push({ kind: "break" })
      } else buffer += next
      i += 2
      continue
    }
    if (char === "\n") {
      buffer = buffer.replace(/[ \t]+$/, "")
      flush()
      tokens.push({ kind: "break" })
      i++
      while (text[i] === " " || text[i] === "\t") i++
      continue
    }
    if (char === "*" || char === "_") {
      let end = i
      while (text[end] === char) end++
      flush()
      tokens.push(...delimiters(text, i, end))
      i = end
      continue
    }
    if (char === "`") {
      let end = i
      while (text[end] === "`") end++
      const fence = text.slice(i, end)
      const close = text.indexOf(fence, end)
      if (close >= 0 && text[close + fence.length] !== "`") {
        // A code span reads as its words, without the backticks.
        buffer += text.slice(end, close).replace(/^ ([\s\S]*) $/, "$1")
        i = close + fence.length
      } else {
        buffer += fence
        i = end
      }
      continue
    }
    if (char === "&") {
      const entity = entityAt(text, i)
      if (entity) {
        buffer += entity.char
        i += entity.length
        continue
      }
    }
    if (links) {
      const image = char === "!" && next === "["
      if (char === "[" || image) {
        const link = linkAt(text, image ? i + 1 : i)
        if (link) {
          flush()
          const children = inlines(link.label, false)
          const href = image ? undefined : safeHref(link.dest)
          if (href) tokens.push({ kind: "link", href, children })
          else tokens.push(...children)
          i = link.end
          continue
        }
      }
      if (char === "<") {
        const match = AUTOLINK.exec(text.slice(i, i + 2100))
        const href = match ? safeHref(match[1]) : undefined
        if (match && href) {
          flush()
          tokens.push({
            kind: "link",
            href,
            bare: true,
            children: [{ kind: "text", text: match[1] }],
          })
          i += match[0].length
          continue
        }
      }
      if ((char === "h" || char === "H") && !LETTER_OR_DIGIT.test(text[i - 1] ?? "")) {
        const match = BARE_URL.exec(text.slice(i, i + 2100))
        const url = match ? trimUrl(match[0]) : undefined
        const href = url ? safeHref(url) : undefined
        if (url && href) {
          flush()
          tokens.push({ kind: "link", href, bare: true, children: [{ kind: "text", text: url }] })
          i += url.length
          continue
        }
      }
    }
    buffer += char
    i++
  }
  flush()
  return emphasis(tokens)
}

/** Inline markdown of one piece of text (a line, a note). */
export function parseInline(text: string): Inline[] {
  return inlines(withoutHtml(text), true)
}

// --- blocks ----------------------------------------------------------------------------------

const BULLET = /^\s*[-*+•–]\s+(.*)$/
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/
const HEADING = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^\s{0,3}>\s?/
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/

/**
 * A description as blocks. A blank line ends a paragraph or list; a line
 * break inside one is kept. A run of lines that start with a bullet (`-`,
 * `*`, `+`, `•`, `–`) or a number (`1.`, `2)`) is a list, wherever it starts
 * — after a paragraph's first line too; an indented line continues the item
 * above it, any other line ends the list. `#` lines are headings; rules
 * (`---`), fences and quote markers (`>`) are not shown.
 */
export function parseRichText(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; start: number; items: string[] } | undefined

  const flushParagraph = () => {
    const children = inlines(paragraph.join("\n").trim(), true)
    if (children.length > 0) blocks.push({ kind: "paragraph", children })
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item) => inlines(item.trim(), true))
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      ...(list.ordered && list.start !== 1 ? { start: list.start } : {}),
      items,
    })
    list = undefined
  }
  const flush = () => {
    flushParagraph()
    flushList()
  }

  const lines = withoutHtml(text.replace(/\r\n?/g, "\n")).split("\n")
  for (const raw of lines) {
    if (raw.trim() === "" || FENCE.test(raw) || THEMATIC_BREAK.test(raw)) {
      flush()
      continue
    }
    const line = raw.replace(QUOTE, "")
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      const children = inlines((heading[1] ?? "").trim(), true)
      if (children.length > 0) blocks.push({ kind: "heading", children })
      continue
    }
    const ordered = ORDERED.exec(line)
    const bullet = ordered ? undefined : BULLET.exec(line)
    if (ordered || bullet) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      if (list && list.ordered !== isOrdered) flushList()
      list ??= { ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] }
      list.items.push(ordered ? ordered[2] : (bullet?.[1] ?? ""))
      continue
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += `\n${line.trim()}`
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flush()
  return blocks
}

// --- plain text ------------------------------------------------------------------------------

/** The words of a tree, without markup; a line break as `breakAs`. */
export function plainText(nodes: Inline[], breakAs = "\n"): string {
  return nodes
    .map((node) =>
      node.kind === "text"
        ? node.text
        : node.kind === "break"
          ? breakAs
          : plainText(node.children, breakAs) || (node.kind === "link" ? shortUrl(node.href) : ""),
    )
    .join("")
}

const ENDS_SENTENCE = /[.!?:;…]["'’”)]*$/

/** Pieces of text as one sentence-like run: a piece that does not end like a
 * sentence (a heading, a list item) gets a full stop. */
function asSentences(pieces: string[]): string {
  return pieces
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((piece, index, all) =>
      index < all.length - 1 && !ENDS_SENTENCE.test(piece) ? `${piece}.` : piece,
    )
    .join(" ")
}

/**
 * A description as one line of plain text, for a card, a short-description
 * line or a meta description: the words only, line breaks as spaces, blocks
 * (headings, list items) run together as sentences.
 */
export function plainLine(text: string): string {
  return asSentences(
    parseRichText(text).flatMap((block) =>
      block.kind === "list"
        ? block.items.map((item) => plainText(item, " "))
        : [plainText(block.children, " ")],
    ),
  )
}

/** `plainLine`, at most `max` characters: cut at a word and ended with "…". */
export function summary(text: string, max = 160): string {
  const line = plainLine(text)
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  const words = space > max * 0.6 ? cut.slice(0, space) : cut
  return `${words.replace(/[\s,;:.–—-]+$/, "")}…`
}
