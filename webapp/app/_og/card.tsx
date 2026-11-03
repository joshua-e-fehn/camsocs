import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"
import type { CardText } from "@/lib/og-card"

/**
 * The share cards, in the "River & ink" identity (DESIGN.md): the sky band
 * with the wordmark, a black serif headline and the apricot rule, and a
 * footer line on white. Our own crest only — no University arms or wording,
 * the project is unofficial (AGENTS.md). Colours are the tokens of
 * app/globals.css in hex, because an image has no CSS variables; the crest
 * is public/crest.svg. `_og` is a private folder: no route.
 *
 * Young Serif (SIL OFL 1.1, `fonts/OFL.txt`) is vendored as `fonts/` and
 * read from disk: fetching it from Google Fonts subset to the text drawn
 * sent every card's event title, host and venue to a third party (review of
 * the SEO audit 2026-11-02, og-card-third-party). If it cannot be read the
 * image still renders, in the default face.
 */

export const CARD_SIZE = { width: 1200, height: 630 }

const PAPER = "#FFFFFF"
const INK = "#111111"
const MUTED = "#545B5E"
const SKY = "#E8F2F6"
const SKY_LINE = "#D2E4EB"
const APRICOT = "#F29E4C"

const WORDMARK = "CAMsocs"
const FOOTNOTE = "Unofficial · every fact sourced"

/** A logo request may take this long: a stalled one must not hang a render. */
const FETCH_TIMEOUT_MS = 5_000

/** The largest logo embedded; a bigger file is left out. */
const MAX_LOGO_BYTES = 1_000_000

/** Formats the renderer draws reliably (no WebP or SVG from storage). */
const LOGO_TYPES = new Set(["image/png", "image/jpeg"])

/** A font file's bytes, or null when it cannot be read (the card then
 * falls back to the default face). */
export async function readFont(path: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(path)
    // A copy, not the pooled Buffer's whole backing store.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  } catch {
    return null
  }
}

let youngSerifFont: Promise<ArrayBuffer | null> | undefined

/** Young Serif, read once per instance; a failed read is not remembered, so
 * a passing error (EMFILE under load) costs one card its face, not the rest
 * of the instance's. The path is spelled out from `process.cwd()` as the
 * crest's is, so the build's file tracing puts the font in each share-card
 * function (as public/crest.svg). */
export function youngSerif(): Promise<ArrayBuffer | null> {
  youngSerifFont ??= readFont(
    join(process.cwd(), "app", "_og", "fonts", "YoungSerif-Regular.ttf"),
  ).then((font) => {
    if (!font) youngSerifFont = undefined
    return font
  })
  return youngSerifFont
}

/** A society's stored logo as a data URI, or null when it cannot be drawn
 * (missing, too big, an unsupported format, or unreachable). */
export async function logoDataUri(url: string | undefined): Promise<string | null> {
  if (!url) return null
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? ""
    if (!response.ok || !LOGO_TYPES.has(type)) return null
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_LOGO_BYTES) return null
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`
  } catch {
    return null
  }
}

async function crestDataUri(): Promise<string> {
  const crest = await readFile(join(process.cwd(), "public", "crest.svg"), "utf8")
  return `data:image/svg+xml;base64,${Buffer.from(crest).toString("base64")}`
}

/** The headline's size: smaller for a longer one, so it fits in three lines. */
function headlineSize(text: string, lines?: number): number {
  if (lines !== undefined) return 68
  if (text.length <= 30) return 72
  if (text.length <= 55) return 60
  return 50
}

export async function renderCard({
  text,
  headlineLines,
  logo,
  footLeft,
  cacheControl,
}: {
  text: CardText
  /** Draw the headline as these lines (the generic card's fixed break). */
  headlineLines?: readonly string[]
  /** A data URI drawn instead of the crest. */
  logo?: string | null
  footLeft: string
  /** Sent with the image; Next's default for a metadata image is a year. */
  cacheControl?: string
}): Promise<ImageResponse> {
  const lines = headlineLines ?? [text.headline]
  const [serif, crest] = await Promise.all([
    youngSerif(),
    logo ? Promise.resolve(null) : crestDataUri(),
  ])
  const fonts = serif
    ? [{ name: "Young Serif", data: serif, style: "normal" as const, weight: 400 as const }]
    : []
  const serifFamily = serif ? "Young Serif" : "serif"
  const size = headlineSize(text.headline, headlineLines?.length)

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: PAPER,
        color: INK,
      }}
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "space-between",
          // The generic card's two lines were set to fill the width beside the crest.
          gap: headlineLines ? 0 : 40,
          padding: "56px 80px",
          background: SKY,
          borderBottom: `2px solid ${SKY_LINE}`,
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: 28, flexShrink: 1, minWidth: 0 }}
        >
          <div
            style={{ display: "flex", fontSize: 40, fontFamily: serifFamily, letterSpacing: -0.5 }}
          >
            {WORDMARK}
          </div>
          {text.eyebrow && (
            <div style={{ display: "flex", fontSize: 28, color: MUTED }}>{text.eyebrow}</div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: size,
              lineHeight: 1.08,
              letterSpacing: headlineLines ? -2 : -1.5,
              fontFamily: serifFamily,
            }}
          >
            {lines.map((line) => (
              <div key={line} style={{ display: "flex" }}>
                {line}
              </div>
            ))}
          </div>
          {text.detail && (
            <div style={{ display: "flex", fontSize: 28, color: MUTED }}>{text.detail}</div>
          )}
          <div style={{ display: "flex", width: 120, height: 7, background: APRICOT }} />
        </div>
        {logo ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 260,
              height: 260,
              flexShrink: 0,
              borderRadius: 56,
              background: PAPER,
              border: `2px solid ${SKY_LINE}`,
            }}
          >
            {/* biome-ignore lint/performance/noImgElement: next/og draws plain <img> only. */}
            <img src={logo} width={200} height={200} alt="" style={{ objectFit: "contain" }} />
          </div>
        ) : (
          // biome-ignore lint/performance/noImgElement: next/og draws plain <img> only.
          <img src={crest ?? ""} width={232} height={260} alt="" style={{ flexShrink: 0 }} />
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "26px 80px 30px",
          fontSize: 26,
          color: MUTED,
        }}
      >
        <div style={{ display: "flex", color: INK }}>{footLeft}</div>
        <div style={{ display: "flex" }}>{FOOTNOTE}</div>
      </div>
    </div>,
    {
      ...CARD_SIZE,
      fonts,
      ...(cacheControl ? { headers: { "cache-control": cacheControl } } : {}),
    },
  )
}

/** The generic card (app/opengraph-image.tsx), also what a listing that may
 * not be drawn gets. */
export const GENERIC_HEADLINE = ["Everything on in", "Cambridge, in one place."] as const

export function renderGenericCard(cacheControl?: string): Promise<ImageResponse> {
  return renderCard({
    text: { headline: GENERIC_HEADLINE.join(" ") },
    headlineLines: GENERIC_HEADLINE,
    footLeft: "Events · Talks · Societies",
    cacheControl,
  })
}

/** A listing's card may change with its data: a day at the CDN, then
 * served stale while it refreshes. */
export const LISTING_CARD_CACHE =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
