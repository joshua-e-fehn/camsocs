import { ImageResponse } from "next/og"
import { SHARE_IMAGE_ALT } from "@/lib/site"

/**
 * The share image for every page, in the "Backs & limestone" identity: the
 * italic wordmark and a serif line on limestone paper, the river along the
 * bottom and the three pillar colours. No crest, arms or University wording —
 * the project is unofficial (AGENTS.md). Colours are the light tokens of
 * app/globals.css in hex, because an image has no CSS variables.
 *
 * Newsreader is fetched from Google Fonts (TTF, subset to the text drawn);
 * if that fails the image still renders, in the default face.
 */
export const alt = SHARE_IMAGE_ALT
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const PAPER = "#F7F4EC"
const INK = "#16231F"
const MUTED = "#5B6660"
const SAGE = "#2E6A55"
const BRICK = "#A8432C"
const INDIGO = "#34407A"
const BACKS = "#A9CDBB"

const HEADLINE = ["Every society, event and talk", "in Cambridge,"] as const
const HEADLINE_ITALIC = "sourced."
const WORDMARK = "camsocs"
const PILLARS = [
  ["Societies", SAGE],
  ["Events", BRICK],
  ["Talks", INDIGO],
] as const
const FOOTNOTE = "Unofficial · every fact sourced"

/** Each font request may take this long; the image is built at `next build`,
 * where a stalled request must not hang the build. */
const FONT_TIMEOUT_MS = 5_000

async function newsreader(italic: boolean, text: string): Promise<ArrayBuffer | null> {
  try {
    const family = `Newsreader:ital,opsz,wght@${italic ? 1 : 0},72,400`
    const cssResponse = await fetch(
      `https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`,
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
  const [roman, italic] = await Promise.all([
    newsreader(false, [...HEADLINE, ...PILLARS.map(([label]) => label), FOOTNOTE].join(" ")),
    newsreader(true, `${HEADLINE_ITALIC}${WORDMARK}`),
  ])
  const fonts = [
    ...(roman
      ? [{ name: "Newsreader", data: roman, style: "normal" as const, weight: 400 as const }]
      : []),
    ...(italic
      ? [{ name: "Newsreader", data: italic, style: "italic" as const, weight: 400 as const }]
      : []),
  ]

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px 56px",
        background: PAPER,
        color: INK,
        fontFamily: fonts.length > 0 ? "Newsreader" : "serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <svg width="54" height="32" viewBox="0 0 20 12" aria-hidden="true">
          <path
            d="M1 8.5 C 4 2, 7 2, 10 6 S 16 10.5, 19 3.5"
            fill="none"
            stroke={SAGE}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <div style={{ fontSize: 60, fontStyle: "italic", letterSpacing: -1 }}>{WORDMARK}</div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          fontSize: 78,
          lineHeight: 1.04,
          letterSpacing: -2,
        }}
      >
        <div style={{ display: "flex" }}>{HEADLINE[0]}</div>
        <div style={{ display: "flex", gap: 20 }}>
          {HEADLINE[1]}
          <span style={{ fontStyle: "italic", color: SAGE }}>{HEADLINE_ITALIC}</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        <svg width="1040" height="40" viewBox="0 0 1200 40" aria-hidden="true">
          <path
            d="M0 26 C 90 8, 170 40, 280 26 S 460 6, 560 18 S 700 40, 800 30 S 960 4, 1060 16 S 1160 30, 1200 22"
            fill="none"
            stroke={BACKS}
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
        <div style={{ display: "flex", alignItems: "center", gap: 28, fontSize: 26, color: MUTED }}>
          {PILLARS.map(([label, colour]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, background: colour }} />
              {label}
            </div>
          ))}
          <div style={{ marginLeft: "auto" }}>{FOOTNOTE}</div>
        </div>
      </div>
    </div>,
    { ...size, fonts },
  )
}
