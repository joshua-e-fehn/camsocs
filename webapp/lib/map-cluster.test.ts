import { describe, expect, test } from "bun:test"
import {
  CLUSTER_RADIUS_PX,
  type ClusterablePin,
  clusterLook,
  clusterPins,
  sameSpot,
  worldPixel,
} from "./map-cluster"

// Invented pins around the centre of Cambridge.
function pin(id: string, lat: number, lng: number, over: Partial<ClusterablePin> = {}) {
  return { id, lat, lng, count: 1, kind: "event" as const, status: "upcoming" as const, ...over }
}

/** `metres` east of a point at 52.2° N, in degrees of longitude. */
const east = (metres: number) => metres / (111_320 * Math.cos((52.2 * Math.PI) / 180))

describe("worldPixel", () => {
  test("is MapLibre's world: 512 px at zoom 0, doubling each zoom", () => {
    expect(worldPixel(0, 0, 0)).toEqual({ x: 256, y: 256 })
    expect(worldPixel(0, 180, 1).x).toBe(1024)
    const a = worldPixel(52.2, 0.12, 15)
    const b = worldPixel(52.2, 0.12, 16)
    expect(b.x / a.x).toBeCloseTo(2, 10)
    expect(b.y).toBeLessThan((512 * 2 ** 16) / 2) // north of the equator: the top half
  })
})

describe("clusterPins", () => {
  test("pins far apart stay alone, with their own ids", () => {
    const pins = [pin("a", 52.2, 0.12), pin("b", 52.21, 0.1)]
    const clusters = clusterPins(pins, 15)
    expect(clusters.map((c) => c.id)).toEqual(["a", "b"])
    expect(clusters[0].members).toEqual([pins[0]])
  })

  test("pins within the radius merge, and part again as the map zooms in", () => {
    // 40 m apart: ~36 px at zoom 15.3 at this latitude, so merged at 14, apart at 17.
    const pins = [pin("a", 52.2, 0.12), pin("b", 52.2, 0.12 + east(40))]
    const merged = clusterPins(pins, 14)
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe("cluster:a+b")
    expect(merged[0].members.map((p) => p.id)).toEqual(["a", "b"])
    // Drawn at its seed: the busiest member, else the first.
    expect([merged[0].lat, merged[0].lng]).toEqual([52.2, 0.12])
    const busier = clusterPins([pins[0], { ...pins[1], count: 2 }], 14)
    expect(busier[0].lng).toBe(pins[1].lng)
    expect(clusterPins(pins, 17)).toHaveLength(2)
  })

  test("the radius is in screen px", () => {
    const pins = [pin("a", 52.2, 0.12), pin("b", 52.2, 0.12 + east(40))]
    const dx = worldPixel(52.2, 0.12 + east(40), 15).x - worldPixel(52.2, 0.12, 15).x
    expect(clusterPins(pins, 15, dx + 0.01)).toHaveLength(1)
    expect(clusterPins(pins, 15, dx - 0.01)).toHaveLength(2)
  })

  test("the busiest pin seeds its cluster; a chain does not merge end to end", () => {
    // a — b — c, 30 px apart each: b (busiest) takes a and c.
    const degreesPerPx = 1e-3 / (worldPixel(52.2, 0.121, 16).x - worldPixel(52.2, 0.12, 16).x)
    const step = 30 * degreesPerPx
    const chain = [
      pin("a", 52.2, 0.12),
      pin("b", 52.2, 0.12 + step, { count: 3 }),
      pin("c", 52.2, 0.12 + 2 * step),
      pin("d", 52.2, 0.12 + 3 * step),
    ]
    const clusters = clusterPins(chain, 16)
    expect(clusters.map((c) => c.members.map((p) => p.id))).toEqual([["a", "b", "c"], ["d"]])
  })

  test("a city-centre day of many pins becomes a few markers", () => {
    const pins = Array.from({ length: 85 }, (_, i) =>
      // ~550 m by ~550 m: the centre of town.
      pin(`p${i}`, 52.203 + ((i * 37) % 100) * 5e-5, 0.115 + ((i * 53) % 100) * 8e-5),
    )
    const clusters = clusterPins(pins, 13.6)
    expect(clusters.length).toBeLessThan(20)
    // Every pin is in exactly one cluster.
    expect(clusters.flatMap((c) => c.members.map((p) => p.id)).sort()).toEqual(
      pins.map((p) => p.id).sort(),
    )
    // No two markers are drawn within the radius of each other.
    const at = clusters.map((c) => worldPixel(c.lat, c.lng, 13.6))
    for (const [i, a] of at.entries()) {
      for (const b of at.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(CLUSTER_RADIUS_PX)
      }
    }
    expect(clusterPins(pins, 18.5).length).toBeGreaterThan(clusters.length)
  })

  test("no pins, no clusters", () => {
    expect(clusterPins([], 15)).toEqual([])
    expect(CLUSTER_RADIUS_PX).toBe(36)
  })
})

describe("sameSpot", () => {
  test("only members on one point", () => {
    expect(sameSpot([pin("a", 52.2, 0.12), pin("b", 52.2, 0.12)])).toBe(true)
    expect(sameSpot([pin("a", 52.2, 0.12), pin("b", 52.2, 0.1201)])).toBe(false)
  })
})

describe("clusterLook", () => {
  test("counts every item and says where and what activating it does", () => {
    const look = clusterLook(
      [
        pin("a", 0, 0, { count: 3 }),
        pin("b", 0, 0, { count: 2 }),
        pin("c", 0, 0, { count: 2 }),
        pin("d", 0, 0),
      ],
      "zoom",
    )
    expect(look).toEqual({
      count: 8,
      kind: "event",
      status: "upcoming",
      label: "8 items at 4 places, zoom in",
    })
  })

  test("talks only: ink; any event: teal", () => {
    expect(
      clusterLook([pin("a", 0, 0, { kind: "talk" }), pin("b", 0, 0, { kind: "talk" })], "zoom")
        .kind,
    ).toBe("talk")
    expect(clusterLook([pin("a", 0, 0, { kind: "talk" }), pin("b", 0, 0)], "zoom").kind).toBe(
      "event",
    )
  })

  test("any on now: Now; all over: past, grey", () => {
    const now = clusterLook(
      [pin("a", 0, 0, { status: "now" }), pin("b", 0, 0, { status: "past" })],
      "list",
    )
    expect(now.status).toBe("now")
    expect(now.label).toBe("2 items at 2 places, one place on now, show them in the list")
    const past = clusterLook(
      [pin("a", 0, 0, { status: "past" }), pin("b", 0, 0, { status: "past" })],
      "zoom",
    )
    expect(past.status).toBe("past")
    expect(past.label).toBe("2 items at 2 places, all ended, zoom in")
    expect(clusterLook([pin("a", 0, 0, { status: "past" }), pin("b", 0, 0)], "zoom").status).toBe(
      "upcoming",
    )
  })
})
