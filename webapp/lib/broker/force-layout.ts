/**
 * A small, deterministic force-directed layout (Fruchterman–Reingold with a
 * pull toward the centre) for the broker's relationship graph. Hand-written
 * instead of a dependency: the graph is a few hundred nodes at most (the
 * explorer caps it), O(n²) per iteration is fine at that size, and it keeps
 * the bundle and the lockfile untouched.
 *
 * Deterministic — nodes start on a circle in the given order — so the same
 * graph always draws the same way, and the tests can pin it.
 */

export type LayoutEdge = { source: string; target: string }
export type Point = { x: number; y: number }

export function forceLayout(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  options: { width: number; height: number; iterations?: number; padding?: number },
): Map<string, Point> {
  const { width, height, padding = 24 } = options
  const n = ids.length
  const positions = new Map<string, Point>()
  if (n === 0) return positions
  const cx = width / 2
  const cy = height / 2
  if (n === 1) {
    positions.set(ids[0], { x: cx, y: cy })
    return positions
  }

  const index = new Map(ids.map((id, i) => [id, i]))
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const radius = Math.min(width, height) / 2 - padding
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n
    xs[i] = cx + radius * Math.cos(angle)
    ys[i] = cy + radius * Math.sin(angle)
  }
  const links = edges
    .map((edge) => [index.get(edge.source), index.get(edge.target)] as const)
    .filter((pair): pair is readonly [number, number] => {
      const [a, b] = pair
      return a !== undefined && b !== undefined && a !== b
    })

  const area = (width - 2 * padding) * (height - 2 * padding)
  const k = Math.sqrt(area / n)
  const iterations = options.iterations ?? (n > 200 ? 150 : 300)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  let temperature = Math.min(width, height) / 10

  for (let step = 0; step < iterations; step++) {
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = xs[i] - xs[j]
        let ddy = ys[i] - ys[j]
        let dist = Math.hypot(ddx, ddy)
        if (dist < 0.01) {
          // Coincident: nudge apart along a fixed, index-derived direction.
          ddx = 0.01 * ((i % 7) - 3 || 1)
          ddy = 0.01 * ((j % 5) - 2 || 1)
          dist = Math.hypot(ddx, ddy)
        }
        const force = (k * k) / dist
        const fx = (ddx / dist) * force
        const fy = (ddy / dist) * force
        dx[i] += fx
        dy[i] += fy
        dx[j] -= fx
        dy[j] -= fy
      }
    }
    for (const [a, b] of links) {
      const ddx = xs[a] - xs[b]
      const ddy = ys[a] - ys[b]
      const dist = Math.max(Math.hypot(ddx, ddy), 0.01)
      const force = (dist * dist) / k
      const fx = (ddx / dist) * force
      const fy = (ddy / dist) * force
      dx[a] -= fx
      dy[a] -= fy
      dx[b] += fx
      dy[b] += fy
    }
    for (let i = 0; i < n; i++) {
      // Gravity keeps disconnected pieces on the canvas.
      dx[i] += (cx - xs[i]) * 0.05 * (k / 10)
      dy[i] += (cy - ys[i]) * 0.05 * (k / 10)
      const length = Math.hypot(dx[i], dy[i])
      if (length > 0) {
        const move = Math.min(length, temperature)
        xs[i] += (dx[i] / length) * move
        ys[i] += (dy[i] / length) * move
      }
      xs[i] = Math.min(width - padding, Math.max(padding, xs[i]))
      ys[i] = Math.min(height - padding, Math.max(padding, ys[i]))
    }
    temperature *= 0.97
  }

  for (let i = 0; i < n; i++) positions.set(ids[i], { x: xs[i], y: ys[i] })
  return positions
}
