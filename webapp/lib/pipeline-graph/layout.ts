import {
  type GraphNode,
  type Lane,
  PHASES,
  PILLAR_LABELS,
  PILLARS,
  type PipelineGraph,
  type SelectorNode,
  type StageNode,
  stageNodes,
} from "./graph"

/**
 * The deterministic layout of `/dashboard/pipeline` (spec §5B, decision D10):
 * our own arithmetic, no elkjs or dagre, so the same graph always draws the
 * same picture.
 *
 * - **Columns are phases**: a stage's x is its phase's column × `COLUMN_W`
 *   (plus half the gutter), so seed → harvest → … → report reads left to right.
 * - **Bands are lanes**, one per campus × pillar, grouped by pillar
 *   (societies, events, talks, shared) and, inside a pillar, the campus's own
 *   lanes before the engine's. A stage's y is its band's top plus its index
 *   among the band's stages of the same phase. Pillars are never merged.
 * - **Staging directories and sinks are port nodes** stacked under the stage
 *   that owns them: a directory under its first writer (registry order), a
 *   sink (a Convex route) under the first stage that posts to or reads from
 *   it. Each is drawn once; every other writer, reader or poster reaches it
 *   by a routed edge.
 * - **Edges are orthogonal** and run only through the free space: vertical
 *   segments in the gutters between columns, horizontal ones in the channel
 *   below a row. No edge crosses a node.
 * - **Selectors are buses** (`@org_lookup`, `@event_index`,
 *   `@all_observations`), each drawn once as a bar above the topmost band that
 *   uses it, with a drop down a gutter to each reader.
 */

export const COLUMN_W = 280
export const NODE_W = 220
export const NODE_H = 84
/** The free channel kept below a row's tallest cell (half above, half below). */
export const CHANNEL_H = 28
/** A row with no ports: the node plus its channel. */
export const ROW_H = NODE_H + CHANNEL_H
/** A port node (a staging directory or a sink) under its stage. */
export const PORT_H = 26
export const PORT_GAP = 6
/** Ports sit this far right of their stage's left edge; the stub runs in the gap. */
export const PORT_INDENT = 16
export const PORT_W = NODE_W - PORT_INDENT
export const PHASE_HEADER_H = 40
export const BAND_HEADER_H = 32
/** One bus track (label + bar). */
export const BUS_H = 30
export const BAND_PAD = 12
export const BAND_GAP = 16
/** A bus is at least this wide, so its label has a bar under it. */
export const MIN_BUS_W = 160

const GUTTER = COLUMN_W - NODE_W

export type Point = { x: number; y: number }

export type LaidOutPhase = { key: string; label: string; x: number; width: number }

export type LaidOutLane = {
  id: string
  lane: Lane
  label: string
  y: number
  height: number
  width: number
  /** Bus tracks at the top of the band. */
  tracks: number
  rows: number
}

export type LaidOutStage = {
  /** The graph node id (`stage:<campus>:<name>`). */
  id: string
  stage: StageNode
  column: number
  laneId: string
  row: number
  x: number
  y: number
}

export type PortNode = Extract<GraphNode, { kind: "staging" | "sink" }>

export type LaidOutPort = {
  /** The graph node id (`dir:<campus>:<name>` or `sink:<campus>:<name>`). */
  id: string
  node: PortNode
  /** The stage it is drawn under. */
  owner: string
  /** Its index under the owner. */
  index: number
  x: number
  y: number
  width: number
  height: number
}

export type LaidOutBus = {
  id: string
  selector: SelectorNode
  laneId: string
  track: number
  /** Left end of the bar and its width. */
  x: number
  width: number
  /** The bar's centre line. */
  y: number
  readers: string[]
  writers: string[]
}

/**
 * - `attach`: a stage to a port drawn under it (or a sink it reads from, back
 *   up to it);
 * - `writes` / `posts` / `reads`: routed edges to and from another stage's port;
 * - `requires`: a stage waits for another;
 * - `bus-read` / `bus-write`: drops to and from a selector bus.
 */
export type EdgeKind =
  | "attach"
  | "writes"
  | "posts"
  | "reads"
  | "requires"
  | "bus-read"
  | "bus-write"

export type LaidOutEdge = {
  id: string
  kind: EdgeKind
  /** Graph node ids: stages, ports or a bus. */
  from: string
  to: string
  points: Point[]
}

export type PipelineLayout = {
  phases: LaidOutPhase[]
  lanes: LaidOutLane[]
  stages: LaidOutStage[]
  ports: LaidOutPort[]
  buses: LaidOutBus[]
  edges: LaidOutEdge[]
  width: number
  height: number
}

const PHASE_LABELS: Record<string, string> = {
  seed: "Seed",
  harvest: "Harvest",
  resolve: "Resolve",
  enrich: "Enrich",
  classify: "Classify",
  events: "Events",
  inbox: "Inbox",
  load: "Load",
  talks: "Talks",
  report: "Report",
}

/** Bands in drawing order: by pillar, then the campus's lanes, then the engine's. */
export function orderLanes(graph: PipelineGraph): Lane[] {
  const pillarIndex = (lane: Lane) => {
    const index = graph.pillars.indexOf(lane.pillar)
    return index === -1 ? PILLARS.indexOf(lane.pillar) + graph.pillars.length : index
  }
  return [...graph.lanes].sort(
    (a, b) =>
      pillarIndex(a) - pillarIndex(b) ||
      Number(a.campus === null) - Number(b.campus === null) ||
      (a.campus ?? "").localeCompare(b.campus ?? ""),
  )
}

/** "Societies · Cambridge", "Events · engine". */
export function laneLabel(lane: Lane, graph: Pick<PipelineGraph, "campus">): string {
  const who =
    lane.campus === null
      ? "engine"
      : lane.campus === graph.campus.id
        ? graph.campus.name
        : lane.campus
  return `${PILLAR_LABELS[lane.pillar]} · ${who}`
}

/** An SVG path through `points`. */
export function pathOf(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
}

/** Drops repeated points, and middle points on a straight line. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    const before = out[out.length - 2]
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))
    ) {
      out[out.length - 1] = p
      continue
    }
    out.push(p)
  }
  return out
}

/** The ports each stage owns, in edge order: directories, then sinks. */
function assignPorts(graph: PipelineGraph, stages: readonly StageNode[]) {
  const orderOf = new Map(stages.map((stage) => [stage.id, stage.order]))
  const ports = graph.nodes.filter((n): n is PortNode => n.kind === "staging" || n.kind === "sink")
  const owners = new Map<string, string>()
  for (const port of ports) {
    // Directories belong to their first writer; sinks to the first stage that
    // touches them. A directory nobody writes (read only) goes to its first reader.
    const touching = graph.edges
      .filter(
        (e) =>
          (e.from === port.id && orderOf.has(e.to) && e.kind === "reads") ||
          (e.to === port.id && orderOf.has(e.from) && (e.kind === "writes" || e.kind === "posts")),
      )
      .map((e) => ({ stage: e.from === port.id ? e.to : e.from, writes: e.to === port.id }))
    const pool =
      port.kind === "staging" && touching.some((t) => t.writes)
        ? touching.filter((t) => t.writes)
        : touching
    const owner = pool
      .map((t) => t.stage)
      .sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0))[0]
    if (owner) owners.set(port.id, owner)
  }
  const byOwner = new Map<string, PortNode[]>()
  // Directories first, then sinks, each in the graph's own node order.
  for (const kind of ["staging", "sink"] as const) {
    for (const port of ports) {
      const owner = owners.get(port.id)
      if (port.kind !== kind || !owner) continue
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), port])
    }
  }
  return byOwner
}

/** A stage's cell: the node plus the ports stacked under it. */
function cellHeight(ports: number): number {
  return NODE_H + ports * (PORT_H + PORT_GAP)
}

export function layoutPipeline(graph: PipelineGraph): PipelineLayout {
  const columnOf = (phase: string) => {
    const known = graph.phases.find((p) => p.key === phase)
    const order = known ? known.order : PHASES.indexOf(phase as (typeof PHASES)[number])
    if (order < 0) throw new Error(`pipeline graph: unknown phase ${phase}`)
    return order
  }
  const columns = Math.max(graph.phases.length, PHASES.length)
  const width = columns * COLUMN_W

  const phases: LaidOutPhase[] = [...graph.phases]
    .sort((a, b) => a.order - b.order)
    .map((phase) => ({
      key: phase.key,
      label: PHASE_LABELS[phase.key] ?? phase.key,
      x: phase.order * COLUMN_W + GUTTER / 2,
      width: NODE_W,
    }))

  const stages = stageNodes(graph).sort((a, b) => a.order - b.order)
  const lanes = orderLanes(graph)
  const laneIds = new Set(lanes.map((lane) => lane.id))
  for (const stage of stages) {
    if (!laneIds.has(stage.lane)) {
      throw new Error(`pipeline graph: stage ${stage.name} is in unknown lane ${stage.lane}`)
    }
  }
  // Only bands that hold a stage are drawn.
  const usedLanes = lanes.filter((lane) => stages.some((stage) => stage.lane === lane.id))
  const bandIndex = new Map(usedLanes.map((lane, index) => [lane.id, index]))

  const byOwner = assignPorts(graph, stages)
  const portsOf = (stageId: string) => byOwner.get(stageId) ?? []

  // Each stage's row: its index among its band's stages of the same phase.
  const rowOf = new Map<string, number>()
  const cellCount = new Map<string, number>()
  for (const stage of stages) {
    const cell = `${stage.lane}|${stage.phase}`
    const row = cellCount.get(cell) ?? 0
    rowOf.set(stage.id, row)
    cellCount.set(cell, row + 1)
  }
  /** Each band's row heights: the row's tallest cell plus the channel. */
  const rowHeights = new Map<string, number[]>()
  for (const lane of usedLanes) {
    const inLane = stages.filter((s) => s.lane === lane.id)
    const rows = Math.max(1, ...inLane.map((s) => (rowOf.get(s.id) ?? 0) + 1))
    const heights = Array.from({ length: rows }, () => ROW_H)
    for (const stage of inLane) {
      const row = rowOf.get(stage.id) ?? 0
      heights[row] = Math.max(heights[row], cellHeight(portsOf(stage.id).length) + CHANNEL_H)
    }
    rowHeights.set(lane.id, heights)
  }

  // Buses: the selectors, each on a track of the topmost band that uses it.
  const stageById = new Map(stages.map((stage) => [stage.id, stage]))
  const selectors = graph.nodes.filter((n): n is SelectorNode => n.kind === "selector")
  const busPlans: {
    selector: SelectorNode
    readers: string[]
    writers: string[]
    laneId: string
    track: number
  }[] = []
  const tracksIn = new Map<string, number>()
  for (const selector of selectors) {
    const readers = graph.edges
      .filter((e) => e.kind === "reads" && e.from === selector.id && stageById.has(e.to))
      .map((e) => e.to)
    const writers = graph.edges
      .filter((e) => e.kind === "writes" && e.to === selector.id && stageById.has(e.from))
      .map((e) => e.from)
    const users = [...readers, ...writers]
    if (users.length === 0) continue
    const top = users
      .map((id) => stageById.get(id)?.lane ?? "")
      .sort((a, b) => (bandIndex.get(a) ?? 0) - (bandIndex.get(b) ?? 0))[0]
    const track = tracksIn.get(top) ?? 0
    tracksIn.set(top, track + 1)
    busPlans.push({ selector, readers, writers, laneId: top, track })
  }

  // Bands, top to bottom.
  const laidLanes: LaidOutLane[] = []
  let y = PHASE_HEADER_H
  for (const lane of usedLanes) {
    const tracks = tracksIn.get(lane.id) ?? 0
    const heights = rowHeights.get(lane.id) ?? [ROW_H]
    const rowsHeight = heights.reduce((sum, h) => sum + h, 0)
    const height = BAND_HEADER_H + tracks * BUS_H + rowsHeight + BAND_PAD
    laidLanes.push({
      id: lane.id,
      lane,
      label: laneLabel(lane, graph),
      y,
      height,
      width,
      tracks,
      rows: heights.length,
    })
    y += height + BAND_GAP
  }
  const height = y - BAND_GAP + BAND_PAD
  const laneById = new Map(laidLanes.map((lane) => [lane.id, lane]))
  /** The top of a band's `row` (the bus tracks sit above row 0). */
  const rowTop = (laneId: string, row: number) => {
    const lane = laneById.get(laneId)
    const heights = rowHeights.get(laneId) ?? []
    const above = heights.slice(0, row).reduce((sum, h) => sum + h, 0)
    return (lane ? lane.y + BAND_HEADER_H + lane.tracks * BUS_H : 0) + above
  }
  /** The channel under a row: its bottom edge, half a channel below its tallest cell. */
  const channelUnder = (laneId: string, row: number) =>
    rowTop(laneId, row) + (rowHeights.get(laneId)?.[row] ?? ROW_H)

  const laidStages: LaidOutStage[] = stages.map((stage) => {
    const column = columnOf(stage.phase)
    const row = rowOf.get(stage.id) ?? 0
    return {
      id: stage.id,
      stage,
      column,
      laneId: stage.lane,
      row,
      x: column * COLUMN_W + GUTTER / 2,
      y: rowTop(stage.lane, row) + CHANNEL_H / 2,
    }
  })
  const placed = new Map(laidStages.map((stage) => [stage.id, stage]))

  const laidPorts: LaidOutPort[] = laidStages.flatMap((owner) =>
    portsOf(owner.id).map((node, index) => ({
      id: node.id,
      node,
      owner: owner.id,
      index,
      x: owner.x + PORT_INDENT,
      y: owner.y + NODE_H + PORT_GAP + index * (PORT_H + PORT_GAP),
      width: PORT_W,
      height: PORT_H,
    })),
  )
  const portById = new Map(laidPorts.map((port) => [port.id, port]))

  /** The gutter centre left of a column (its right gutter is column + 1). */
  const gutter = (column: number) => column * COLUMN_W
  const midY = (box: { y: number; height?: number }, h = NODE_H) => box.y + (box.height ?? h) / 2

  /** Where an edge leaves or enters a box, and the row it sits in. */
  type End = { right: Point; left: Point; column: number; laneId: string; row: number }
  const endOf = (id: string): End | null => {
    const stage = placed.get(id)
    if (stage) {
      const y0 = midY(stage)
      return {
        right: { x: stage.x + NODE_W, y: y0 },
        left: { x: stage.x, y: y0 },
        column: stage.column,
        laneId: stage.laneId,
        row: stage.row,
      }
    }
    const port = portById.get(id)
    const owner = port ? placed.get(port.owner) : undefined
    if (!port || !owner) return null
    const y0 = midY(port)
    return {
      right: { x: port.x + port.width, y: y0 },
      left: { x: port.x, y: y0 },
      column: owner.column,
      laneId: owner.laneId,
      row: owner.row,
    }
  }

  /** Source's right side → target's left side through gutters and the channel. */
  const route = (source: End, target: End): Point[] => {
    const start = source.right
    const end = target.left
    const gs = gutter(source.column + 1)
    const gt = gutter(target.column)
    if (gs === gt) {
      return simplify([start, { x: gs, y: start.y }, { x: gs, y: end.y }, end])
    }
    // Along the channel under the source's row, then down (or up) the target's gutter.
    const channel = channelUnder(source.laneId, source.row)
    return simplify([
      start,
      { x: gs, y: start.y },
      { x: gs, y: channel },
      { x: gt, y: channel },
      { x: gt, y: end.y },
      end,
    ])
  }

  const edges: LaidOutEdge[] = []

  // Each stage to the ports drawn under it: a stub down its left margin.
  for (const port of laidPorts) {
    const owner = placed.get(port.owner)
    if (!owner) continue
    const stem = owner.x + PORT_INDENT / 2
    const top = { x: stem, y: owner.y + NODE_H }
    const corner = { x: stem, y: midY(port) }
    const side = { x: port.x, y: midY(port) }
    // A sink the stage only reads from points back up at the stage.
    const readsOnly = graph.edges.some(
      (e) => e.kind === "reads" && e.from === port.id && e.to === owner.id,
    )
    edges.push({
      id: `attach:${owner.id}->${port.id}`,
      kind: "attach",
      from: readsOnly ? port.id : owner.id,
      to: readsOnly ? owner.id : port.id,
      points: readsOnly ? [side, corner, top] : [top, corner, side],
    })
  }

  // Routed edges to and from another stage's port, and the requires edges.
  for (const e of graph.edges) {
    if (e.kind === "needs") continue
    const fromPort = portById.get(e.from)
    const toPort = portById.get(e.to)
    if (fromPort?.owner === e.to || toPort?.owner === e.from) continue // drawn as a stub
    const isRequires = e.kind === "requires"
    if (!isRequires && !fromPort && !toPort) continue // selectors are buses
    const source = endOf(e.from)
    const target = endOf(e.to)
    if (!source || !target || e.from === e.to) continue
    edges.push({
      id: `${e.kind}:${e.from}->${e.to}`,
      kind: e.kind,
      from: e.from,
      to: e.to,
      points: route(source, target),
    })
  }

  const buses: LaidOutBus[] = busPlans.map((plan) => {
    const lane = laneById.get(plan.laneId)
    const barY = (lane ? lane.y : 0) + BAND_HEADER_H + plan.track * BUS_H + BUS_H - 6
    const columnOfStage = (id: string) => placed.get(id)?.column ?? 0
    const xs = [
      ...plan.readers.map((id) => gutter(columnOfStage(id))),
      ...plan.writers.map((id) => gutter(columnOfStage(id) + 1)),
    ]
    const left = Math.min(...xs)
    const busWidth = Math.max(MIN_BUS_W, Math.max(...xs) - left)
    const id = plan.selector.id
    for (const reader of plan.readers) {
      const target = placed.get(reader)
      if (!target) continue
      const gt = gutter(target.column)
      const endY = midY(target)
      edges.push({
        id: `bus:${id}->${reader}`,
        kind: "bus-read",
        from: id,
        to: reader,
        points: simplify([
          { x: gt, y: barY },
          { x: gt, y: endY },
          { x: target.x, y: endY },
        ]),
      })
    }
    for (const writer of plan.writers) {
      const source = placed.get(writer)
      if (!source) continue
      const gs = gutter(source.column + 1)
      const startY = midY(source)
      edges.push({
        id: `bus:${writer}->${id}`,
        kind: "bus-write",
        from: writer,
        to: id,
        points: simplify([
          { x: source.x + NODE_W, y: startY },
          { x: gs, y: startY },
          { x: gs, y: barY },
        ]),
      })
    }
    return {
      id,
      selector: plan.selector,
      laneId: plan.laneId,
      track: plan.track,
      x: left,
      width: busWidth,
      y: barY,
      readers: plan.readers,
      writers: plan.writers,
    }
  })

  return {
    phases,
    lanes: laidLanes,
    stages: laidStages,
    ports: laidPorts,
    buses,
    edges,
    width,
    height,
  }
}
