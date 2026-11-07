import { z } from "zod"
import graphJson from "@/lib/generated/pipeline-graph.cam.json"

/**
 * The pipeline graph the Python side exports (`camsocs graph`, spec §5A,
 * schema `camsocs.pipeline-graph/1`): the stage registry with its phases,
 * pillars and lanes, the staging directories and selectors the stages read
 * and write, the Convex routes they post to, the groups and the source
 * manifest. Generated into `lib/generated/pipeline-graph.cam.json` by
 * `pixi run pipeline-graph`; never edited by hand.
 *
 * The schema below is the TS side of that contract. `PIPELINE_GRAPH` is parsed
 * once, so a regenerated file that no longer fits fails loudly (and the
 * shape test in layout.test.ts fails first).
 */

export const PHASES = [
  "seed",
  "harvest",
  "resolve",
  "enrich",
  "classify",
  "events",
  "inbox",
  "load",
  "talks",
  "report",
] as const
export type Phase = (typeof PHASES)[number]

/** The three pillars plus the engine's shared stages. Never merged (D8). */
export const PILLARS = ["societies", "events", "talks", "shared"] as const
export type Pillar = (typeof PILLARS)[number]

export const PILLAR_LABELS: Record<Pillar, string> = {
  societies: "Societies",
  events: "Events",
  talks: "Talks",
  shared: "Shared",
}

/** The scheduled stage groups (`GROUPS` in stages/__init__.py). */
export const GROUPS = ["events", "full", "talks"] as const
export type GroupKey = (typeof GROUPS)[number]

const docRef = z.object({
  doc: z.string(),
  section: z.string().nullable(),
  anchor: z.string().nullable(),
})
export type DocRef = z.infer<typeof docRef>

const stageNode = z.object({
  id: z.string(),
  kind: z.literal("stage"),
  name: z.string(),
  order: z.number().int(),
  phase: z.enum(PHASES),
  pillar: z.enum(PILLARS),
  /** null = an engine stage, shared by every campus. */
  campus: z.string().nullable(),
  lane: z.string(),
  /** The registry's one-line description; null when the stage has none. */
  description: z.string().nullable(),
  requires: z.array(z.string()),
  groups: z.array(z.string()),
  network: z.boolean(),
  llm: z.boolean(),
  fetchesInDryRun: z.boolean(),
  /** A display label that replaces the name (talks_cam: "talks.cam lists (G1)"). */
  label: z.string().nullable(),
  docs: z.array(docRef),
})
export type StageNode = z.infer<typeof stageNode>

const stagingNode = z.object({
  id: z.string(),
  kind: z.literal("staging"),
  name: z.string(),
  /** null for directories that are no source type (`_resolved`, `talks`). */
  sourceType: z.string().nullable(),
  events: z.boolean(),
})

const selectorNode = z.object({
  id: z.string(),
  kind: z.literal("selector"),
  name: z.string(),
  selector: z.string(),
  description: z.string(),
})
export type SelectorNode = z.infer<typeof selectorNode>

const sinkNode = z.object({
  id: z.string(),
  kind: z.literal("sink"),
  name: z.string(),
  route: z.string(),
})

const groupNode = z.object({ id: z.string(), kind: z.literal("group"), name: z.string() })

const graphNode = z.discriminatedUnion("kind", [
  stageNode,
  stagingNode,
  selectorNode,
  sinkNode,
  groupNode,
])
export type GraphNode = z.infer<typeof graphNode>

export const EDGE_KINDS = ["writes", "reads", "requires", "needs", "posts"] as const

const graphEdge = z.object({ from: z.string(), to: z.string(), kind: z.enum(EDGE_KINDS) })
export type GraphEdge = z.infer<typeof graphEdge>

const lane = z.object({ id: z.string(), campus: z.string().nullable(), pillar: z.enum(PILLARS) })
export type Lane = z.infer<typeof lane>

const group = z.object({
  key: z.string(),
  description: z.string(),
  stages: z.array(z.string()),
  needs: z.array(z.string()),
  staleAfterDays: z.number().nullable(),
  derive: z.boolean(),
  schedule: z.string().nullable(),
})
export type GraphGroup = z.infer<typeof group>

const source = z.object({
  key: z.string(),
  label: z.string(),
  stage: z.string(),
  pillar: z.enum(PILLARS),
  sourceTypes: z.array(z.string()),
  eventSources: z.array(z.string()),
  section: z.string().nullable(),
  anchor: z.string().nullable(),
  permission: z.enum(["robots", "D3", "D3a"]).nullable(),
})
export type GraphSource = z.infer<typeof source>

export const pipelineGraphSchema = z.object({
  schema: z.literal("camsocs.pipeline-graph/1"),
  campus: z.object({ id: z.string(), name: z.string(), site: z.string(), docs: z.string() }),
  pillars: z.array(z.enum(PILLARS)),
  phases: z.array(z.object({ key: z.enum(PHASES), order: z.number().int() })),
  lanes: z.array(lane),
  groups: z.array(group),
  nodes: z.array(graphNode),
  edges: z.array(graphEdge),
  sources: z.array(source),
})
export type PipelineGraph = z.infer<typeof pipelineGraphSchema>

/** The live campus's graph, checked against the schema. */
export const PIPELINE_GRAPH: PipelineGraph = pipelineGraphSchema.parse(graphJson)

export function stageNodes(graph: PipelineGraph): StageNode[] {
  return graph.nodes.filter((node): node is StageNode => node.kind === "stage")
}

/** The name a stage is shown under: its label when it has one. */
export function stageTitle(stage: Pick<StageNode, "name" | "label">): string {
  return stage.label ?? stage.name
}

/** Where the repository's docs are read (the broker's own GitHub access). */
const DOCS_BASE = "https://github.com/joshua-e-fehn/camsocs/blob/main/"

/** A link to a cited doc section, e.g. `docs/source-research.md#1-…`. */
export function docHref(ref: DocRef): string {
  return `${DOCS_BASE}${ref.doc}${ref.anchor ? `#${ref.anchor}` : ""}`
}

/** "source-research §1", or the doc's file name when no section is cited. */
export function docLabel(ref: DocRef): string {
  const file = ref.doc.replace(/^.*\//, "").replace(/\.md$/, "")
  return ref.section ? `${file} §${ref.section}` : file
}

/** What a stage reads, writes and posts, by the names in the graph. */
export type StageIo = {
  writes: string[]
  reads: string[]
  posts: string[]
  /** Stages this one waits for (`requires`). */
  requires: string[]
}

export function stageIo(graph: PipelineGraph, stageId: string): StageIo {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const name = (id: string) => {
    const node = byId.get(id)
    if (!node) return id
    return node.kind === "selector" ? node.selector : node.name
  }
  const io: StageIo = { writes: [], reads: [], posts: [], requires: [] }
  for (const edge of graph.edges) {
    if (edge.kind === "writes" && edge.from === stageId) io.writes.push(name(edge.to))
    else if (edge.kind === "reads" && edge.to === stageId) io.reads.push(name(edge.from))
    else if (edge.kind === "posts" && edge.from === stageId) io.posts.push(name(edge.to))
    else if (edge.kind === "requires" && edge.to === stageId) io.requires.push(name(edge.from))
  }
  return io
}
