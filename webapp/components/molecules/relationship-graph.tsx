"use client"

import { useMemo } from "react"
import { forceLayout } from "@/lib/broker/force-layout"
import { humanize, RELATIONSHIP_LABELS } from "@/lib/broker/format"

export type GraphNode = { key: string; name: string; isCounterpart: boolean; degree: number }
export type GraphEdge = {
  key: string
  from: string
  to: string
  type: string
  visibility: "public" | "internal"
}

const WIDTH = 880
const HEIGHT = 560
const LABELLED = 24
/** Within this distance of the left / right edge, labels anchor inwards. */
const EDGE_ZONE = 110

/**
 * The relationship graph as SVG, laid out by lib/broker/force-layout.ts.
 * Encodings never rely on colour alone: public edges are solid, internal ones
 * dashed; societies are circles, counterparts squares; size is degree.
 * Selecting a node highlights it and its neighbours (select it again to clear).
 * Loaded lazily by the
 * graph page (next/dynamic), so it costs nothing elsewhere.
 */
export function RelationshipGraph({
  nodes,
  edges,
  selected,
  onSelect,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selected: string | null
  onSelect: (key: string | null) => void
}) {
  const positions = useMemo(
    () =>
      forceLayout(
        nodes.map((node) => node.key),
        edges.map((edge) => ({ source: edge.from, target: edge.to })),
        { width: WIDTH, height: HEIGHT },
      ),
    [nodes, edges],
  )

  const neighbours = useMemo(() => {
    if (!selected) return null
    const set = new Set([selected])
    for (const edge of edges) {
      if (edge.from === selected) set.add(edge.to)
      if (edge.to === selected) set.add(edge.from)
    }
    return set
  }, [selected, edges])

  const labelled = useMemo(() => {
    const top = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, LABELLED)
    return new Set([...top.map((node) => node.key), ...(neighbours ?? [])])
  }, [nodes, neighbours])

  const radius = (degree: number) => Math.min(14, 4 + Math.sqrt(degree) * 1.6)

  return (
    // The nodes inside are focusable buttons, so this is labelled, not role="img"
    // (which would hide them from assistive technology).
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full select-none"
      aria-label={`Relationship graph: ${nodes.length} organisations, ${edges.length} relationships`}
    >
      <g>
        {edges.map((edge) => {
          const a = positions.get(edge.from)
          const b = positions.get(edge.to)
          if (!a || !b) return null
          const active = !neighbours || edge.from === selected || edge.to === selected
          return (
            <line
              key={edge.key}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={edge.visibility === "public" ? "var(--primary)" : "var(--muted-foreground)"}
              strokeWidth={active && neighbours ? 2 : 1.25}
              strokeDasharray={edge.visibility === "public" ? undefined : "4 3"}
              strokeOpacity={active ? 0.7 : 0.12}
            >
              <title>{RELATIONSHIP_LABELS[edge.type] ?? humanize(edge.type)}</title>
            </line>
          )
        })}
      </g>
      <g>
        {nodes.map((node) => {
          const at = positions.get(node.key)
          if (!at) return null
          const r = radius(node.degree)
          const isSelected = node.key === selected
          const faded = neighbours !== null && !neighbours.has(node.key)
          const shared = {
            fill: isSelected ? "var(--primary)" : "var(--card)",
            stroke: "var(--foreground)",
            strokeWidth: isSelected ? 2 : 1.25,
            opacity: faded ? 0.25 : 1,
          }
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; it is focusable and keyboard-operable.
            <g
              key={node.key}
              role="button"
              tabIndex={0}
              aria-label={`${node.name}, ${node.degree} relationships`}
              aria-pressed={isSelected}
              className="cursor-pointer outline-none focus-visible:[&>*:first-child]:stroke-[3]"
              onClick={(event) => {
                event.stopPropagation()
                onSelect(isSelected ? null : node.key)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onSelect(isSelected ? null : node.key)
                }
              }}
            >
              {node.isCounterpart ? (
                <rect x={at.x - r} y={at.y - r} width={r * 2} height={r * 2} rx={2} {...shared} />
              ) : (
                <circle cx={at.x} cy={at.y} r={r} {...shared} />
              )}
              {/* A larger invisible target than the mark. */}
              <circle cx={at.x} cy={at.y} r={Math.max(r, 10)} fill="transparent" />
              {labelled.has(node.key) && (
                <text
                  // Near an edge the label grows inwards, so it is never cut off.
                  x={at.x < EDGE_ZONE ? at.x - r : at.x > WIDTH - EDGE_ZONE ? at.x + r : at.x}
                  y={at.y - r - 4}
                  textAnchor={
                    at.x < EDGE_ZONE ? "start" : at.x > WIDTH - EDGE_ZONE ? "end" : "middle"
                  }
                  className="fill-muted-foreground text-[11px]"
                  style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 3 }}
                  opacity={faded ? 0.3 : 1}
                >
                  {node.name.length > 28 ? `${node.name.slice(0, 27)}…` : node.name}
                </text>
              )}
            </g>
          )
        })}
      </g>
    </svg>
  )
}
