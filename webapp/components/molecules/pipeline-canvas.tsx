"use client"

// The graph library's structural styles only (decision D10): no theme sheet,
// every colour below comes from our tokens.
import "@xyflow/react/dist/base.css"
import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react"
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react"
import dynamic from "next/dynamic"
import { type CSSProperties, useMemo } from "react"
import { StageNodeCard, StagePortChip } from "@/components/molecules/stage-node"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { StageNode } from "@/lib/pipeline-graph/graph"
import {
  BUS_H,
  type EdgeKind,
  NODE_H,
  NODE_W,
  type PipelineLayout,
  type Point,
  type PortNode,
  pathOf,
} from "@/lib/pipeline-graph/layout"
import type { StageView } from "@/lib/pipeline-graph/status"
import { cn } from "@/lib/utils"

/**
 * The pipeline as an n8n-style node graph (spec §5B, decision D10): lanes by
 * pillar and campus, phase columns, stage nodes with an icon and a word for
 * their status, the staging directories and Convex routes under their
 * stages, orthogonal edges and the selector buses. Positions come from
 * `lib/pipeline-graph/layout.ts`; this component only draws them.
 *
 * `@xyflow/react` is imported here and nowhere else, through `next/dynamic`
 * with `ssr: false`, so it ships only in the broker's dashboard chunk and is
 * never rendered on the server. Nodes are fixed (no dragging, no connecting);
 * the canvas pans and zooms. Each stage node is a button that opens its sheet.
 */

export type PipelineCanvasProps = {
  layout: PipelineLayout
  /** Stage name → its view (lib/pipeline-graph/status.ts). */
  views: Record<string, StageView>
  /** The stage whose sheet is open. */
  selected: string | null
  onOpenStage: (name: string) => void
  className?: string
}

type StageData = { stage: StageNode; view: StageView; selected: boolean; onOpen: () => void }
type LaneData = { label: string; width: number; height: number }
type PhaseData = { label: string; width: number }
type PortData = { node: PortNode; width: number; height: number }
type BusData = { label: string; description: string; width: number; drops: number }
type OrthoData = { points: Point[]; kind: EdgeKind }

type StageFlowNode = Node<StageData, "stage">
type LaneFlowNode = Node<LaneData, "lane">
type PhaseFlowNode = Node<PhaseData, "phase">
type BusFlowNode = Node<BusData, "bus">
type PortFlowNode = Node<PortData, "port">
type FlowNode = StageFlowNode | LaneFlowNode | PhaseFlowNode | BusFlowNode | PortFlowNode
type OrthoEdge = Edge<OrthoData, "ortho">

/** Handles exist so the library can attach edges; ours draw their own paths. */
const HIDDEN_HANDLE: CSSProperties = { opacity: 0, pointerEvents: "none" }

const EDGE_STYLE: Record<EdgeKind, CSSProperties> = {
  attach: { stroke: "var(--muted-foreground)", strokeWidth: 1 },
  writes: { stroke: "var(--foreground)", strokeWidth: 1.25 },
  posts: { stroke: "var(--foreground)", strokeWidth: 1.25 },
  reads: { stroke: "var(--foreground)", strokeWidth: 1.25 },
  requires: { stroke: "var(--muted-foreground)", strokeWidth: 1.25, strokeDasharray: "5 4" },
  "bus-read": { stroke: "var(--faint)", strokeWidth: 1 },
  "bus-write": { stroke: "var(--faint)", strokeWidth: 1 },
}

const STATIC = { draggable: false, selectable: false, focusable: false, connectable: false }

function CanvasSkeleton() {
  return <Skeleton className="h-[min(78vh,860px)] min-h-[420px] w-full rounded-xl" />
}

export const PipelineCanvas = dynamic<PipelineCanvasProps>(
  async () => {
    const {
      Background,
      BackgroundVariant,
      BaseEdge,
      Handle,
      MarkerType,
      Panel,
      Position,
      ReactFlow,
      useReactFlow,
    } = await import("@xyflow/react")

    function StageNodeView({ data }: NodeProps<StageFlowNode>) {
      return (
        <>
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
          <StageNodeCard
            stage={data.stage}
            view={data.view}
            selected={data.selected}
            onOpen={data.onOpen}
            style={{ width: NODE_W, height: NODE_H, pointerEvents: "auto" }}
          />
          <Handle
            type="source"
            position={Position.Right}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
        </>
      )
    }

    function LaneNodeView({ data }: NodeProps<LaneFlowNode>) {
      return (
        <div
          className="rounded-xl border border-border bg-muted/50"
          style={{ width: data.width, height: data.height }}
        >
          <p className="px-3 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {data.label}
          </p>
        </div>
      )
    }

    function PhaseNodeView({ data }: NodeProps<PhaseFlowNode>) {
      return (
        <div className="border-t-2 border-foreground pt-1" style={{ width: data.width }}>
          <span className="font-serif text-base">{data.label}</span>
        </div>
      )
    }

    function BusNodeView({ data }: NodeProps<BusFlowNode>) {
      return (
        <div
          className="relative"
          style={{ width: data.width, height: BUS_H }}
          title={data.description}
        >
          <span className="absolute top-0 left-1 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
            {data.label} · {data.drops} {data.drops === 1 ? "stage" : "stages"}
          </span>
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-[3px] h-1.5 rounded-full bg-muted-foreground"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
          <Handle
            type="target"
            position={Position.Bottom}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
        </div>
      )
    }

    function PortNodeView({ data }: NodeProps<PortFlowNode>) {
      return (
        <>
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
          <StagePortChip node={data.node} style={{ width: data.width, height: data.height }} />
          <Handle
            type="source"
            position={Position.Right}
            isConnectable={false}
            style={HIDDEN_HANDLE}
          />
        </>
      )
    }

    function OrthoEdgeView({ id, data, markerEnd, style }: EdgeProps<OrthoEdge>) {
      if (!data) return null
      return (
        <BaseEdge
          id={id}
          path={pathOf(data.points)}
          markerEnd={markerEnd}
          style={style}
          interactionWidth={0}
        />
      )
    }

    const nodeTypes = {
      stage: StageNodeView,
      lane: LaneNodeView,
      phase: PhaseNodeView,
      bus: BusNodeView,
      port: PortNodeView,
    }
    const edgeTypes = { ortho: OrthoEdgeView }

    function ZoomControls() {
      const { zoomIn, zoomOut, fitView } = useReactFlow()
      return (
        <Panel position="top-right" className="flex gap-1">
          <Button size="icon-sm" variant="outline" aria-label="Zoom in" onClick={() => zoomIn()}>
            <PlusIcon />
          </Button>
          <Button size="icon-sm" variant="outline" aria-label="Zoom out" onClick={() => zoomOut()}>
            <MinusIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Fit the whole pipeline"
            onClick={() => fitView({ padding: 0.04 })}
          >
            <MaximizeIcon />
          </Button>
        </Panel>
      )
    }

    function Canvas({ layout, views, selected, onOpenStage, className }: PipelineCanvasProps) {
      const background = useMemo<FlowNode[]>(
        () => [
          ...layout.lanes.map(
            (lane): LaneFlowNode => ({
              id: `lane:${lane.id}`,
              type: "lane",
              position: { x: 0, y: lane.y },
              data: { label: lane.label, width: lane.width, height: lane.height },
              zIndex: -1,
              ...STATIC,
            }),
          ),
          ...layout.phases.map(
            (phase): PhaseFlowNode => ({
              id: `phase:${phase.key}`,
              type: "phase",
              position: { x: phase.x, y: 0 },
              data: { label: phase.label, width: phase.width },
              ...STATIC,
            }),
          ),
          ...layout.ports.map(
            (port): PortFlowNode => ({
              id: port.id,
              type: "port",
              position: { x: port.x, y: port.y },
              width: port.width,
              height: port.height,
              data: { node: port.node, width: port.width, height: port.height },
              ...STATIC,
            }),
          ),
          ...layout.buses.map(
            (bus): BusFlowNode => ({
              id: bus.id,
              type: "bus",
              position: { x: bus.x, y: bus.y - (BUS_H - 6) },
              data: {
                label: bus.selector.selector,
                description: bus.selector.description,
                width: bus.width,
                drops: bus.readers.length + bus.writers.length,
              },
              ...STATIC,
            }),
          ),
        ],
        [layout],
      )

      const nodes = useMemo<FlowNode[]>(
        () => [
          ...background,
          ...layout.stages.map(
            (laid): StageFlowNode => ({
              id: laid.id,
              type: "stage",
              position: { x: laid.x, y: laid.y },
              width: NODE_W,
              height: NODE_H,
              data: {
                stage: laid.stage,
                view: views[laid.stage.name],
                selected: selected === laid.stage.name,
                onOpen: () => onOpenStage(laid.stage.name),
              },
              ...STATIC,
            }),
          ),
        ],
        [background, layout, views, selected, onOpenStage],
      )

      const edges = useMemo<OrthoEdge[]>(
        () =>
          layout.edges.map((edge) => {
            const style = EDGE_STYLE[edge.kind]
            return {
              id: edge.id,
              type: "ortho",
              source: edge.from,
              target: edge.to,
              data: { points: edge.points, kind: edge.kind },
              style,
              focusable: false,
              selectable: false,
              markerEnd:
                edge.kind === "bus-write"
                  ? undefined
                  : {
                      type: MarkerType.ArrowClosed,
                      color: String(style.stroke),
                      width: edge.kind === "attach" ? 10 : 14,
                      height: edge.kind === "attach" ? 10 : 14,
                    },
            }
          }),
        [layout],
      )

      return (
        <div
          className={cn(
            "h-[min(78vh,860px)] min-h-[420px] w-full overflow-hidden rounded-xl border bg-card",
            className,
          )}
        >
          <ReactFlow<FlowNode, OrthoEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode="light"
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.04 }}
            minZoom={0.15}
            maxZoom={1.5}
            aria-label="The pipeline: stages by phase (columns) and lane (rows)"
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
            <ZoomControls />
          </ReactFlow>
        </div>
      )
    }

    return Canvas
  },
  { ssr: false, loading: CanvasSkeleton },
)
