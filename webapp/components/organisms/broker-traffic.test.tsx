import { describe, expect, test } from "bun:test"
import type { FunctionReturnType } from "convex/server"
import { renderToString } from "react-dom/server"
import { TrafficView } from "@/components/organisms/broker-traffic"
import type { api } from "@/convex/_generated/api"

type Traffic = NonNullable<FunctionReturnType<typeof api.broker.overview.traffic>>

const NOW = Date.UTC(2026, 10, 7, 12)

/** Synthetic numbers only. */
function snapshot(
  serverVisits?: Traffic["posthog"]["data"] extends infer D
    ? D extends { serverVisits?: infer S }
      ? S
      : never
    : never,
): Traffic {
  return {
    computedAt: NOW,
    posthog: {
      status: "ok",
      checkedAt: NOW,
      fetchedAt: NOW,
      data: {
        windowDays: 30,
        visitors: 5,
        visitors7d: 3,
        pageviews: 20,
        pageviews7d: 9,
        sessions: 6,
        daily: [{ day: "2026-11-07", visitors: 3, pageviews: 9 }],
        referrers: [],
        pages: [],
        ...(serverVisits ? { serverVisits } : {}),
      },
    },
    searchConsole: { status: "not_configured", checkedAt: NOW },
  } as Traffic
}

describe("TrafficView: the server's page-load count", () => {
  test("shows every visitor's page loads, by kind of source and page", () => {
    const html = renderToString(
      <TrafficView
        traffic={snapshot({
          visits: 412,
          visits7d: 120,
          daily: [{ day: "2026-11-07", visits: 31 }],
          sources: [
            { source: "google", visits: 300, visits7d: 90 },
            { source: "direct", visits: 112, visits7d: 30 },
          ],
          pages: [{ page: "society", visits: 200, visits7d: 60 }],
        })}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(html).toContain("Page loads, 30 days")
    expect(html).toContain("412")
    expect(html).toContain("Page loads, every visitor")
    expect(html).toContain("Google")
    expect(html).toContain("Direct / no referrer")
  })

  test("a snapshot from before the count says when it starts", () => {
    const html = renderToString(
      <TrafficView traffic={snapshot()} onRefresh={() => {}} refreshing={false} />,
    )
    expect(html).toContain("No server count yet")
  })
})
