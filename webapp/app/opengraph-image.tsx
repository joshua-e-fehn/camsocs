import { ImageResponse } from "next/og"
import { SHARE_IMAGE_ALT, SITE_TAGLINE } from "@/lib/site"

/**
 * The share image for every page: the camsocs wordmark and tagline on the
 * site's dark mauve. No crest, arms or University wording — the project is
 * unofficial (AGENTS.md). Colours approximate the `.dark` tokens of
 * app/globals.css in hex, because an image has no CSS variables.
 */
export const alt = SHARE_IMAGE_ALT
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const BACKGROUND = "#1c1720"
const FOREGROUND = "#fafafa"
const MUTED = "#b3a9b8"

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        background: BACKGROUND,
        color: FOREGROUND,
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            width: 72,
            height: 72,
            gap: 6,
            padding: 12,
            borderRadius: 16,
            background: FOREGROUND,
          }}
        >
          {[1, 0.55, 0.55, 1].map((opacity, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: four fixed squares
              key={index}
              style={{ width: 21, height: 21, borderRadius: 4, background: BACKGROUND, opacity }}
            />
          ))}
        </div>
        <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2 }}>camsocs</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 52, fontWeight: 600, lineHeight: 1.15, maxWidth: 960 }}>
          {`${SITE_TAGLINE}.`}
        </div>
        <div style={{ fontSize: 28, color: MUTED }}>
          Every fact sourced · unofficial and independent
        </div>
      </div>
    </div>,
    size,
  )
}
