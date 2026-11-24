import { describe, expect, test } from "bun:test"
import { renderToString } from "react-dom/server"
import { LocationsView } from "@/components/organisms/broker-overview"

// Synthetic numbers and invented titles only.

const COVERAGE = {
  from: 0,
  to: 14 * 86_400_000,
  upcoming: 200,
  resolved: 194,
  unknown: 6,
  byPrecision: { exact: 150, building: 30, area: 4, online: 10, unknown: 2, missing: 4 },
  unresolvedShare: 0.03,
  truncated: false,
  target: 0.02,
  unknownItems: [
    {
      kind: "event" as const,
      key: `evt-${"a".repeat(40)}`,
      title: "Invented social",
      note: "no venue given",
    },
    { kind: "talk" as const, key: "talk-05f9cb992668bbf0c8dc", title: "Invented talk" },
  ],
}

function html(coverage: Parameters<typeof LocationsView>[0]["coverage"]): string {
  return renderToString(<LocationsView coverage={coverage} />).replaceAll("<!-- -->", "")
}

describe("the Locations card", () => {
  test("the share against the target, a bar per precision and the unknown items", () => {
    const out = html(COVERAGE)
    expect(out).toContain("Locations")
    expect(out).toContain("3%")
    expect(out).toContain("above target")
    expect(out).toContain("Not resolved yet")
    expect(out).toContain("Building")
    expect(out).toContain(`href="/events/evt-${"a".repeat(40)}"`)
    expect(out).toContain('href="/talks/talk-05f9cb992668bbf0c8dc"')
    expect(out).toContain("no venue given")
    expect(out).toContain("The first 2 of 6")
  })

  test("on target with nothing unknown, and while loading", () => {
    const clean = html({
      ...COVERAGE,
      unknown: 0,
      unresolvedShare: 0,
      byPrecision: { ...COVERAGE.byPrecision, unknown: 0, missing: 0 },
      unknownItems: [],
    })
    expect(clean).toContain("on target")
    expect(clean).toContain("Every upcoming item has a place.")
    expect(html(undefined)).not.toContain("Still unknown")
  })
})
