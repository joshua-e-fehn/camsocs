import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"
import { SHARE_IMAGE_ALT } from "@/lib/site"

/**
 * The share image for every page, in the "River & ink" identity: the crest
 * and wordmark, a black serif headline on white, and the one sky band. Our own
 * crest only — no University arms or wording, the project is unofficial
 * (AGENTS.md). Colours are the tokens of app/globals.css in hex, because an
 * image has no CSS variables; the crest is public/crest.svg.
 *
 * Young Serif is fetched from Google Fonts (TTF, subset to the text drawn);
 * if that fails the image still renders, in the default face.
 */
export const alt = SHARE_IMAGE_ALT
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const PAPER = "#FFFFFF"
const INK = "#111111"
const MUTED = "#545B5E"
const SKY = "#E8F2F6"
const SKY_LINE = "#D2E4EB"
const APRICOT = "#F29E4C"

const WORDMARK = "camsocs"
const HEADLINE = ["Everything on in", "Cambridge, in one place."] as const
const PILLARS = "Events · Talks · Societies"
const FOOTNOTE = "Unofficial · every fact sourced"

/** Each font request may take this long; the image is built at `next build`,
 * where a stalled request must not hang the build. */
const FONT_TIMEOUT_MS = 5_000

async function youngSerif(text: string): Promise<ArrayBuffer | null> {
  try {
    const cssResponse = await fetch(
      `https://fonts.googleapis.com/css2?family=Young+Serif&text=${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) },
    )
    if (!cssResponse.ok) return null
    const css = await cssResponse.text()
    const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1]
    if (!url) return null
    // An error page handed to the renderer as a font would throw, not fall back.
    const fontResponse = await fetch(url, { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) })
    if (!fontResponse.ok) return null
    return await fontResponse.arrayBuffer()
  } catch {
    return null
  }
}

export default async function OpengraphImage() {
  const [serif, crest] = await Promise.all([
    youngSerif([WORDMARK, ...HEADLINE, PILLARS, FOOTNOTE].join(" ")),
    readFile(join(process.cwd(), "public", "crest.svg"), "utf8"),
  ])
  const fonts = serif
    ? [{ name: "Young Serif", data: serif, style: "normal" as const, weight: 400 as const }]
    : []
  const crestSrc = `data:image/svg+xml;base64,${Buffer.from(crest).toString("base64")}`

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
          padding: "56px 80px",
          background: SKY,
          borderBottom: `2px solid ${SKY_LINE}`,
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: 34, flexShrink: 1, minWidth: 0 }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 44,
              fontFamily: serif ? "Young Serif" : "serif",
              letterSpacing: -0.5,
            }}
          >
            {WORDMARK}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 68,
              lineHeight: 1.05,
              letterSpacing: -2,
              fontFamily: serif ? "Young Serif" : "serif",
            }}
          >
            <div style={{ display: "flex" }}>{HEADLINE[0]}</div>
            <div style={{ display: "flex" }}>{HEADLINE[1]}</div>
          </div>
          <div style={{ display: "flex", width: 120, height: 7, background: APRICOT }} />
        </div>
        {/* biome-ignore lint/performance/noImgElement: next/og draws plain <img> only. */}
        <img src={crestSrc} width={232} height={260} alt="" style={{ flexShrink: 0 }} />
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
        <div style={{ display: "flex", color: INK }}>{PILLARS}</div>
        <div style={{ display: "flex" }}>{FOOTNOTE}</div>
      </div>
    </div>,
    { ...size, fonts },
  )
}
