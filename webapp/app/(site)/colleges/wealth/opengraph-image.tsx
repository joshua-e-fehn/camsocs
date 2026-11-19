import { unstable_rethrow } from "next/navigation"
import { ImageResponse } from "next/og"
import { CARD_SIZE, CARD_STYLE, LISTING_CARD_CACHE, youngSerif } from "@/app/_og/card"
import { formatGbp } from "@/lib/college-wealth"
import { loadWealthView } from "@/lib/college-wealth-data"
import { sharePct, staticWealthView, type WealthView } from "@/lib/college-wealth-view"

/**
 * /colleges/wealth's share card (SEO plan P1 item 11): the year and the ten
 * largest endowments as bars to one scale, so Trinity's dwarfing the rest is
 * the picture a WhatsApp or Slack preview shows. From the page's own view
 * (lib/college-wealth-view.ts); the verified year when Convex cannot be
 * read. No crests: the University's arms never, and the names carry it.
 * lib/page-metadata.ts leaves this page's Open Graph image to this file
 * (OWN_IMAGE_PATHS).
 */
export const alt =
  "The richest Cambridge colleges: the ten largest college endowments as a bar chart"
export const size = CARD_SIZE
export const contentType = "image/png"

const { PAPER, INK, MUTED, SKY, SKY_LINE, APRICOT, WORDMARK, FOOTNOTE } = CARD_STYLE
/** `--brand` (app/globals.css) in hex: an image has no CSS variables. */
const BAR = "#1D7A7A"

export default async function Image() {
  let view: WealthView
  try {
    view = await loadWealthView()
  } catch (error) {
    // Next signals "this render is dynamic" by throwing; that must pass.
    unstable_rethrow(error)
    view = staticWealthView()
  }
  const serif = await youngSerif()
  const family = serif ? "Young Serif" : "serif"
  const top = view.byEndowment.slice(0, 10)
  const max = top[0].endowmentGbp
  const richest = view.totals.richest
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
          alignItems: "flex-end",
          justifyContent: "space-between",
          padding: "28px 64px 20px",
          background: SKY,
          borderBottom: `2px solid ${SKY_LINE}`,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 30, fontFamily: family }}>{WORDMARK}</div>
          <div style={{ display: "flex", fontSize: 52, fontFamily: family, letterSpacing: -1 }}>
            Richest Cambridge colleges {view.financialYear}
          </div>
        </div>
        <div style={{ display: "flex", width: 120, height: 7, background: APRICOT }} />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "space-between",
          padding: "18px 64px 8px",
        }}
      >
        {top.map((row) => (
          <div
            key={row.slug}
            style={{ display: "flex", alignItems: "center", gap: 16, height: 32 }}
          >
            <div style={{ display: "flex", width: 210, fontSize: 22, justifyContent: "flex-end" }}>
              {row.college.shortName}
            </div>
            <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 12 }}>
              <div
                style={{
                  display: "flex",
                  height: 22,
                  width: `${Math.max(0.6, (row.endowmentGbp / max) * 78)}%`,
                  background: BAR,
                  borderRadius: 4,
                }}
              />
              <div style={{ display: "flex", fontSize: 22, color: MUTED }}>
                {formatGbp(row.endowmentGbp)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "10px 64px 22px",
          borderTop: `2px solid ${SKY_LINE}`,
          fontSize: 24,
          color: MUTED,
        }}
      >
        <div style={{ display: "flex", color: INK }}>
          {`${richest.college.shortName} ${formatGbp(richest.endowmentGbp)} · ${sharePct(view)} of all ${view.rows.length}`}
        </div>
        <div style={{ display: "flex" }}>{FOOTNOTE}</div>
      </div>
    </div>,
    {
      ...CARD_SIZE,
      fonts: serif ? [{ name: "Young Serif", data: serif, style: "normal", weight: 400 }] : [],
      headers: { "cache-control": LISTING_CARD_CACHE },
    },
  )
}
