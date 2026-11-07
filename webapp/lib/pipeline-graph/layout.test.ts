import { describe, expect, test } from "bun:test"
import graphJson from "@/lib/generated/pipeline-graph.cam.json"
import {
  docHref,
  docLabel,
  GROUPS,
  PIPELINE_GRAPH,
  type PipelineGraph,
  pipelineGraphSchema,
  stageIo,
  stageNodes,
  stageTitle,
} from "./graph"
import {
  BAND_HEADER_H,
  COLUMN_W,
  layoutPipeline,
  NODE_H,
  NODE_W,
  orderLanes,
  PORT_INDENT,
  type Point,
  pathOf,
} from "./layout"

/**
 * The pipeline graph's TS contract and the deterministic layout of
 * `/dashboard/pipeline` (spec §5B). The second half runs over a small
 * invented graph with a synthetic campus (`zz`), never real data.
 */

describe("pipeline-graph.cam.json against the TS type", () => {
  test("the generated file fits the schema exactly", () => {
    const parsed = pipelineGraphSchema.safeParse(graphJson)
    if (!parsed.success) throw new Error(parsed.error.message)
    expect(parsed.data.schema).toBe("camsocs.pipeline-graph/1")
    expect(parsed.data.campus.id).toBe("cam")
  })

  test("every stage has a phase, a pillar and a declared lane", () => {
    const stages = stageNodes(PIPELINE_GRAPH)
    expect(stages).toHaveLength(25)
    const lanes = new Set(PIPELINE_GRAPH.lanes.map((lane) => lane.id))
    const phases = new Set(PIPELINE_GRAPH.phases.map((phase) => phase.key))
    for (const stage of stages) {
      expect(lanes.has(stage.lane)).toBe(true)
      expect(phases.has(stage.phase)).toBe(true)
      expect(PIPELINE_GRAPH.pillars).toContain(stage.pillar)
    }
  })

  test("the groups are exactly events, full and talks", () => {
    expect(PIPELINE_GRAPH.groups.map((g) => g.key).sort()).toEqual([...GROUPS].sort())
  })

  test("talks_cam is shown under its G1 label, talks stays its own pillar", () => {
    const stages = new Map(stageNodes(PIPELINE_GRAPH).map((s) => [s.name, s]))
    const talksCam = stages.get("talks_cam")!
    expect(stageTitle(talksCam)).toBe("talks.cam lists (G1)")
    expect(talksCam.pillar).toBe("events")
    expect(stages.get("talks")!.pillar).toBe("talks")
  })

  test("every source in the manifest names a stage of the graph", () => {
    const names = new Set(stageNodes(PIPELINE_GRAPH).map((s) => s.name))
    for (const source of PIPELINE_GRAPH.sources) expect(names.has(source.stage)).toBe(true)
  })

  test("doc links and labels", () => {
    const ref = { doc: "docs/source-research.md", section: "1", anchor: "1-x" }
    expect(docLabel(ref)).toBe("source-research §1")
    expect(docHref(ref)).toEndWith("docs/source-research.md#1-x")
    expect(docLabel({ doc: "docs/talks-redesign-spec.md", section: null, anchor: null })).toBe(
      "talks-redesign-spec",
    )
  })

  test("stage io reads names off the edges", () => {
    const io = stageIo(PIPELINE_GRAPH, "stage:cam:load")
    expect(io.reads).toContain("@all_observations")
    expect(io.posts).toContain("claims")
    expect(io.requires).toEqual(["resolve"])
  })
})

type Rect = { x: number; y: number; w: number; h: number }

/** Whether the axis-parallel segment a→b passes through the open interior of r. */
function crossesInterior(a: Point, b: Point, r: Rect): boolean {
  const eps = 0.5
  if (a.x === b.x) {
    const [y0, y1] = a.y < b.y ? [a.y, b.y] : [b.y, a.y]
    return a.x > r.x + eps && a.x < r.x + r.w - eps && y1 > r.y + eps && y0 < r.y + r.h - eps
  }
  const [x0, x1] = a.x < b.x ? [a.x, b.x] : [b.x, a.x]
  return a.y > r.y + eps && a.y < r.y + r.h - eps && x1 > r.x + eps && x0 < r.x + r.w - eps
}

function checkLayout(graph: PipelineGraph) {
  const layout = layoutPipeline(graph)
  const rects: (Rect & { id: string })[] = [
    ...layout.stages.map((s) => ({ id: s.id, x: s.x, y: s.y, w: NODE_W, h: NODE_H })),
    ...layout.ports.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.width, h: p.height })),
  ]

  // Nodes never overlap.
  for (const [i, a] of rects.entries()) {
    for (const b of rects.slice(i + 1)) {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
      expect(apart).toBe(true)
    }
  }

  // Every node sits inside its band.
  const lanes = new Map(layout.lanes.map((lane) => [lane.id, lane]))
  const stageLane = new Map(layout.stages.map((s) => [s.id, s.laneId]))
  for (const rect of rects) {
    const port = layout.ports.find((p) => p.id === rect.id)
    const lane = lanes.get(stageLane.get(port ? port.owner : rect.id)!)!
    expect(rect.y).toBeGreaterThanOrEqual(lane.y + BAND_HEADER_H)
    expect(rect.y + rect.h).toBeLessThanOrEqual(lane.y + lane.height)
  }

  for (const edge of layout.edges) {
    expect(edge.points.length).toBeGreaterThanOrEqual(2)
    for (const [i, p] of edge.points.slice(1).entries()) {
      const prev = edge.points[i]
      // Orthogonal: every segment is horizontal or vertical.
      expect(prev.x === p.x || prev.y === p.y).toBe(true)
      // And none runs through a node.
      for (const rect of rects) expect(crossesInterior(prev, p, rect)).toBe(false)
    }
  }
  return layout
}

describe("layoutPipeline over the live graph", () => {
  const layout = checkLayout(PIPELINE_GRAPH)

  test("is deterministic", () => {
    expect(layoutPipeline(PIPELINE_GRAPH)).toEqual(layout)
  })

  test("x is the phase column × 280px", () => {
    const order = new Map(PIPELINE_GRAPH.phases.map((p) => [p.key, p.order]))
    for (const s of layout.stages) {
      expect(s.column).toBe(order.get(s.stage.phase)!)
      expect(s.x).toBe(s.column * COLUMN_W + (COLUMN_W - NODE_W) / 2)
    }
    expect(COLUMN_W).toBe(280)
  })

  test("y is the lane band plus the index within it", () => {
    // Inside one band and phase, rows follow registry order.
    const harvest = layout.stages
      .filter((s) => s.laneId === "cam/societies" && s.stage.phase === "harvest")
      .sort((a, b) => a.row - b.row)
    expect(harvest.map((s) => s.stage.name)).toEqual([
      "su_directory",
      "proctors_register",
      "sport_clubs",
      "sport_guide_pdf",
      "camdram_societies",
      "cucbc_clubs",
      "colleges",
    ])
    expect(harvest.map((s) => s.row)).toEqual([0, 1, 2, 3, 4, 5, 6])
    // Rows grow downwards, each below the previous one's ports.
    for (const [i, s] of harvest.slice(1).entries()) {
      const above = harvest[i]
      const ports = layout.ports.filter((p) => p.owner === above.id)
      const bottom = Math.max(above.y + NODE_H, ...ports.map((p) => p.y + p.height))
      expect(s.y).toBeGreaterThan(bottom)
    }
  })

  test("bands are grouped by pillar, campus lanes before the engine's", () => {
    expect(layout.lanes.map((lane) => lane.id)).toEqual([
      "cam/societies",
      "engine/societies",
      "cam/events",
      "engine/events",
      "cam/talks",
      "engine/shared",
    ])
    expect(layout.lanes[0].label).toBe("Societies · Cambridge")
    expect(layout.lanes[1].label).toBe("Societies · engine")
    // Bands never overlap.
    for (const [i, lane] of layout.lanes.slice(1).entries()) {
      const above = layout.lanes[i]
      expect(lane.y).toBeGreaterThanOrEqual(above.y + above.height)
    }
  })

  test("each selector is one bus, above the band that first uses it, spanning its drops", () => {
    expect(layout.buses.map((b) => b.selector.selector).sort()).toEqual([
      "@all_observations",
      "@event_index",
      "@org_lookup",
    ])
    const lanes = new Map(layout.lanes.map((lane) => [lane.id, lane]))
    for (const bus of layout.buses) {
      const lane = lanes.get(bus.laneId)!
      expect(bus.y).toBeGreaterThan(lane.y)
      expect(bus.y).toBeLessThan(lane.y + BAND_HEADER_H + lane.tracks * 30)
      const drops = layout.edges.filter((e) => e.from === bus.id || e.to === bus.id)
      expect(drops.length).toBe(bus.readers.length + bus.writers.length)
      for (const drop of drops) {
        const onBar = drop.kind === "bus-read" ? drop.points[0] : drop.points.at(-1)!
        expect(onBar.y).toBe(bus.y)
        expect(onBar.x).toBeGreaterThanOrEqual(bus.x)
        expect(onBar.x).toBeLessThanOrEqual(bus.x + bus.width)
      }
    }
    const org = layout.buses.find((b) => b.selector.selector === "@org_lookup")!
    expect(org.laneId).toBe("cam/events")
    const all = layout.buses.find((b) => b.selector.selector === "@all_observations")!
    expect(all.writers).toEqual(["stage:cam:classify"])
  })

  test("every staging directory and sink is one port node, under its first stage", () => {
    const portIds = layout.ports.map((p) => p.id)
    expect(new Set(portIds).size).toBe(portIds.length)
    const expected = PIPELINE_GRAPH.nodes
      .filter((n) => n.kind === "staging" || n.kind === "sink")
      .map((n) => n.id)
      .sort()
    expect([...portIds].sort()).toEqual(expected)
    const owner = (id: string) => layout.ports.find((p) => p.id === id)?.owner
    // A directory belongs to its first writer, even when a later stage writes it too.
    expect(owner("dir:cam:society_website")).toBe("stage:cam:colleges")
    expect(owner("dir:cam:_resolved")).toBe("stage:cam:resolve")
    // A sink belongs to the first stage that touches it: inbox posts the loader's routes
    // before load does.
    expect(owner("sink:cam:eventOrganisers")).toBe("stage:cam:inbox")
    expect(owner("sink:cam:crosswalk")).toBe("stage:cam:resolve")
    expect(owner("sink:cam:talks/runs")).toBe("stage:cam:talks")
    expect(owner("sink:cam:coverage")).toBe("stage:cam:report")
    expect(layout.ports.some((p) => p.owner === "stage:cam:load")).toBe(false)
    // Ports stack under their stage: directories first, then sinks.
    const inbox = layout.ports.filter((p) => p.owner === "stage:cam:inbox")
    expect(inbox.map((p) => p.node.name)).toEqual([
      "mailing_list_email",
      "inbound/pending",
      "inbound/file",
      "suppressions",
      "sources",
      "files",
      "claims",
      "orgInternal",
      "relationships",
      "eventOrganisers",
      "events/superseded",
      "brokerInferences",
      "inbound/mark",
    ])
    expect(inbox.map((p) => p.node.kind)).toEqual(["staging", ...Array(12).fill("sink")])
    const inboxStage = layout.stages.find((s) => s.id === "stage:cam:inbox")!
    for (const port of inbox) {
      expect(port.x).toBe(inboxStage.x + PORT_INDENT)
      expect(port.y).toBeGreaterThanOrEqual(inboxStage.y + NODE_H)
    }
  })

  test("each port is stubbed to its owner; other stages reach it by a routed edge", () => {
    const ids = new Set(layout.edges.map((e) => e.id))
    expect(ids.has("attach:stage:cam:inbox->sink:cam:claims")).toBe(true)
    expect(ids.has("posts:stage:cam:load->sink:cam:claims")).toBe(true)
    // A sink the stage reads from points back up at it.
    const coverage = layout.edges.find(
      (e) => e.id === "attach:stage:cam:report->sink:cam:coverage",
    )!
    expect(coverage.from).toBe("sink:cam:coverage")
    expect(coverage.to).toBe("stage:cam:report")
    // A second writer, and readers in other columns or rows.
    expect(ids.has("writes:stage:cam:enrich->dir:cam:society_website")).toBe(true)
    expect(ids.has("reads:dir:cam:society_website->stage:cam:website_events")).toBe(true)
    expect(ids.has("reads:dir:cam:su_profile->stage:cam:su_whatson")).toBe(true)
    expect(ids.has("reads:dir:cam:sport_club_page->stage:cam:sport_guide_pdf")).toBe(true)
    expect(ids.has("reads:dir:cam:_resolved->stage:cam:enrich")).toBe(true)
    expect(ids.has("requires:stage:cam:resolve->stage:cam:load")).toBe(true)
    // Needs edges (directory → group) are the run picker's business, not the canvas's.
    expect(layout.edges.some((e) => e.to.startsWith("group:"))).toBe(false)
    // Every routed edge ends on its target's left side.
    for (const edge of layout.edges.filter((e) => e.kind === "reads" || e.kind === "writes")) {
      const end = edge.points.at(-1)!
      const target =
        layout.stages.find((s) => s.id === edge.to) ?? layout.ports.find((p) => p.id === edge.to)!
      expect(end.x).toBe(target.x)
    }
  })

  test("pathOf draws the polyline", () => {
    expect(
      pathOf([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
      ]),
    ).toBe("M 0 0 L 10 0 L 10 5")
  })
})

/** A small invented graph: one synthetic campus (`zz`) beside the engine. */
function syntheticGraph(): PipelineGraph {
  const stage = (
    name: string,
    order: number,
    phase: PipelineGraph["phases"][number]["key"],
    pillar: "societies" | "events" | "talks" | "shared",
    campus: string | null,
  ) => ({
    id: `stage:zz:${name}`,
    kind: "stage" as const,
    name,
    order,
    phase,
    pillar,
    campus,
    lane: `${campus ?? "engine"}/${pillar}`,
    description: name === "clubs" ? null : `${name} (invented)`,
    requires: [],
    groups: ["full"],
    network: campus !== null,
    llm: false,
    fetchesInDryRun: false,
    label: null,
    docs: [],
  })
  return {
    schema: "camsocs.pipeline-graph/1",
    campus: { id: "zz", name: "Testford", site: "https://zz.localhost", docs: "docs/x.md" },
    pillars: ["societies", "events", "talks", "shared"],
    phases: ["seed", "harvest", "resolve", "events", "load"].map((key, order) => ({
      key: key as PipelineGraph["phases"][number]["key"],
      order,
    })),
    lanes: [
      { id: "engine/shared", campus: null, pillar: "shared" },
      { id: "zz/events", campus: "zz", pillar: "events" },
      { id: "engine/societies", campus: null, pillar: "societies" },
      { id: "zz/societies", campus: "zz", pillar: "societies" },
    ],
    groups: [
      {
        key: "full",
        description: "everything",
        stages: ["registry", "clubs", "resolve", "diary", "load"],
        needs: [],
        staleAfterDays: null,
        derive: true,
        schedule: null,
      },
    ],
    nodes: [
      stage("registry", 0, "harvest", "societies", "zz"),
      stage("clubs", 1, "harvest", "societies", "zz"),
      stage("resolve", 2, "resolve", "societies", null),
      stage("diary", 3, "events", "events", "zz"),
      stage("load", 4, "load", "shared", null),
      { id: "dir:zz:registry", kind: "staging", name: "registry", sourceType: "x", events: false },
      {
        id: "dir:zz:_resolved",
        kind: "staging",
        name: "_resolved",
        sourceType: "y",
        events: false,
      },
      {
        id: "sel:zz:org_lookup",
        kind: "selector",
        name: "org_lookup",
        selector: "@org_lookup",
        description: "orgs",
      },
      { id: "sink:zz:claims", kind: "sink", name: "claims", route: "/api/pipeline/claims" },
    ],
    edges: [
      { from: "stage:zz:registry", to: "dir:zz:registry", kind: "writes" },
      { from: "dir:zz:registry", to: "stage:zz:clubs", kind: "reads" },
      { from: "stage:zz:resolve", to: "dir:zz:_resolved", kind: "writes" },
      { from: "dir:zz:_resolved", to: "stage:zz:load", kind: "reads" },
      { from: "sel:zz:org_lookup", to: "stage:zz:diary", kind: "reads" },
      { from: "stage:zz:resolve", to: "stage:zz:load", kind: "requires" },
      { from: "stage:zz:load", to: "sink:zz:claims", kind: "posts" },
    ],
    sources: [],
  }
}

describe("layoutPipeline over a synthetic campus", () => {
  test("lanes order by pillar, the campus before the engine", () => {
    expect(orderLanes(syntheticGraph()).map((lane) => lane.id)).toEqual([
      "zz/societies",
      "engine/societies",
      "zz/events",
      "engine/shared",
    ])
  })

  test("routes without crossing a node, same-column reads included", () => {
    const layout = checkLayout(syntheticGraph())
    expect(layout.lanes[0].label).toBe("Societies · Testford")
    const sameColumn = layout.edges.find((e) => e.id === "reads:dir:zz:registry->stage:zz:clubs")!
    expect(sameColumn.points.at(-1)!.x).toBe(
      layout.stages.find((s) => s.id === "stage:zz:clubs")!.x,
    )
    expect(layout.ports.map((p) => [p.id, p.owner])).toEqual([
      ["dir:zz:registry", "stage:zz:registry"],
      ["dir:zz:_resolved", "stage:zz:resolve"],
      ["sink:zz:claims", "stage:zz:load"],
    ])
    expect(layout.buses).toHaveLength(1)
    expect(layout.buses[0].laneId).toBe("zz/events")
  })

  test("a stage in an undeclared lane is refused", () => {
    const graph = syntheticGraph()
    graph.lanes = graph.lanes.filter((lane) => lane.id !== "zz/events")
    expect(() => layoutPipeline(graph)).toThrow(/unknown lane zz\/events/)
  })
})

describe("decision D10: the graph library stays on the pipeline canvas", () => {
  test("only pipeline-canvas.tsx imports @xyflow/react, through next/dynamic, base.css only", async () => {
    const root = `${import.meta.dir}/../..`
    const importers: string[] = []
    for (const dir of ["app", "components", "hooks", "lib"]) {
      for await (const file of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scan(root)) {
        if (file.endsWith(".test.ts")) continue
        const text = await Bun.file(`${root}/${file}`).text()
        if (/from "@xyflow\/react|import\("@xyflow\/react|"@xyflow\/react\/dist/.test(text)) {
          importers.push(file)
        }
      }
    }
    expect(importers).toEqual(["components/molecules/pipeline-canvas.tsx"])
    const canvas = await Bun.file(`${root}/components/molecules/pipeline-canvas.tsx`).text()
    // Values only through the dynamic import; the static imports are types and the base sheet.
    expect(canvas).toContain('await import("@xyflow/react")')
    expect(canvas).toContain("ssr: false")
    expect(canvas.match(/^import [^\n]*"@xyflow\/react[^"]*"/gm)).toEqual([
      'import "@xyflow/react/dist/base.css"',
      'import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react"',
    ])
    expect(canvas).not.toContain("@xyflow/react/dist/style.css")
  })
})
