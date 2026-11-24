import type { MapStatus } from "./map-day"

/**
 * Pins drawn close together on /map merged into one cluster bubble
 * (docs/locations-and-map.md §0.6): at a zoom, pins whose screen positions are
 * within `radius` px join the cluster of the busiest pin near them (greedy,
 * over a grid of `radius`-sized cells, so it stays linear). Positions are
 * MapLibre's world pixels (512 px tiles, Web Mercator), so the result depends
 * on the zoom alone, not on where the camera is: panning never regroups.
 * Pure, so the canvas and the tests share it.
 */

/** Screen distance, in px, under which pins merge (a 28 px mark and a gap). */
export const CLUSTER_RADIUS_PX = 36

/** What clustering needs of a pin. */
export type ClusterablePin = {
  id: string
  lat: number
  lng: number
  /** How many items the pin stands for. */
  count: number
  kind: "event" | "talk"
  status: MapStatus
}

/** One marker on the canvas: a lone pin or several merged. */
export type PinCluster<T extends ClusterablePin> = {
  /** The pin's own id when alone; else `cluster:` and the members' ids. */
  id: string
  members: T[]
  /** Where it is drawn: its seed's position (the busiest member). Seeds are
   * more than `radius` apart, so markers never pile up again. */
  lat: number
  lng: number
}

const TILE = 512

/** A position in world pixels at `zoom` (MapLibre's Web Mercator, 512 px tiles). */
export function worldPixel(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const size = TILE * 2 ** zoom
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999)
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  }
}

/**
 * The markers for `pins` at `zoom`. The busiest pin not yet taken (most items,
 * then on now, then input order) takes every untaken pin within `radius` px of
 * it. Clusters come out in the input order of their first member, and each
 * keeps its members in input order.
 */
export function clusterPins<T extends ClusterablePin>(
  pins: readonly T[],
  zoom: number,
  radius: number = CLUSTER_RADIUS_PX,
): PinCluster<T>[] {
  const points = pins.map((pin, index) => ({ pin, index, ...worldPixel(pin.lat, pin.lng, zoom) }))
  const cell = (value: number) => Math.floor(value / radius)
  const grid = new Map<string, typeof points>()
  for (const point of points) {
    const id = `${cell(point.x)}:${cell(point.y)}`
    const bucket = grid.get(id)
    if (bucket) bucket.push(point)
    else grid.set(id, [point])
  }
  const rank = (status: MapStatus) => (status === "now" ? 2 : status === "upcoming" ? 1 : 0)
  const seeds = [...points].sort(
    (a, b) =>
      b.pin.count - a.pin.count || rank(b.pin.status) - rank(a.pin.status) || a.index - b.index,
  )
  const taken = new Set<number>()
  const groups: { seed: (typeof points)[number]; group: typeof points }[] = []
  for (const seed of seeds) {
    if (taken.has(seed.index)) continue
    const group = [seed]
    taken.add(seed.index)
    const cx = cell(seed.x)
    const cy = cell(seed.y)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const point of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (taken.has(point.index)) continue
          if (Math.hypot(point.x - seed.x, point.y - seed.y) > radius) continue
          group.push(point)
          taken.add(point.index)
        }
      }
    }
    group.sort((a, b) => a.index - b.index)
    groups.push({ seed, group })
  }
  groups.sort((a, b) => a.group[0].index - b.group[0].index)
  return groups.map(({ seed, group }) => {
    const members = group.map((point) => point.pin)
    return {
      id:
        members.length === 1
          ? members[0].id
          : `cluster:${members
              .map((pin) => pin.id)
              .sort()
              .join("+")}`,
      members,
      lat: seed.pin.lat,
      lng: seed.pin.lng,
    }
  })
}

/** Whether every member stands on one spot (zooming in cannot part them). */
export function sameSpot(members: readonly Pick<ClusterablePin, "lat" | "lng">[]): boolean {
  const [first, ...rest] = members
  return rest.every(
    (pin) => Math.abs(pin.lat - first.lat) < 1e-6 && Math.abs(pin.lng - first.lng) < 1e-6,
  )
}

/** How a cluster is drawn and named: the pins' own rules over all members. */
export type ClusterLook = {
  /** Items across every member. */
  count: number
  /** Talks only: ink; any event: teal (as a pin). */
  kind: "event" | "talk"
  /** Now if any is on now; past once all are over; else upcoming. */
  status: MapStatus
  /** "7 items at 4 places, 2 on now, zoom in". */
  label: string
}

/**
 * The look and accessible name of a cluster of `members`. `action` is what
 * activating it does: zoom in, or (members that zooming cannot part) show
 * their items in the list.
 */
export function clusterLook(
  members: readonly ClusterablePin[],
  action: "zoom" | "list",
): ClusterLook {
  const count = members.reduce((sum, pin) => sum + pin.count, 0)
  const statuses = members.map((pin) => pin.status)
  const status: MapStatus = statuses.includes("now")
    ? "now"
    : statuses.every((value) => value === "past")
      ? "past"
      : "upcoming"
  const onNow = members.filter((pin) => pin.status === "now").length
  const state =
    status === "now"
      ? `, ${onNow === 1 ? "one place" : `${onNow} places`} on now`
      : status === "past"
        ? ", all ended"
        : ""
  return {
    count,
    kind: members.every((pin) => pin.kind === "talk") ? "talk" : "event",
    status,
    label: `${count} ${count === 1 ? "item" : "items"} at ${members.length} places${state}, ${
      action === "zoom" ? "zoom in" : "show them in the list"
    }`,
  }
}
