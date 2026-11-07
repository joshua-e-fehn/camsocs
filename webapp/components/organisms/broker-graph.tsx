"use client"

import {
  EyeOffIcon,
  HandshakeIcon,
  MessagesSquareIcon,
  NetworkIcon,
  ShieldAlertIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useMemo, useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import type { GraphEdge, GraphNode } from "@/components/molecules/relationship-graph"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type BrokerMatch,
  runWithToast,
  useBrokerEcosystem,
  useBrokerIntroductionMutations,
  useBrokerIntroductions,
  useBrokerMatches,
} from "@/hooks/convex/broker"
import {
  ECOSYSTEM_EDGE_LABELS,
  ECOSYSTEM_LAYERS,
  type EcosystemEdge,
  type EcosystemLayer,
  type EcosystemNode,
  LAYER_LABELS,
  limitView,
} from "@/lib/broker/ecosystem"
import { formatDate, humanize, RELATIONSHIP_LABELS } from "@/lib/broker/format"
import {
  CATEGORY_LABELS,
  type Category,
  RELATIONSHIP_TYPES,
  type RelationshipType,
} from "@/lib/vocab"

/** The SVG graph is loaded only on this page, and only in the browser. */
const RelationshipGraph = dynamic(
  () => import("@/components/molecules/relationship-graph").then((m) => m.RelationshipGraph),
  { ssr: false, loading: () => <Skeleton className="aspect-[11/7] w-full rounded-lg" /> },
)

type Visibility = "all" | "public" | "internal"

/** What an edge is, in words: its relationship type or its layer's kind. */
function edgeLabel(edge: EcosystemEdge): string {
  if (edge.layer === "relationships") return RELATIONSHIP_LABELS[edge.type] ?? humanize(edge.type)
  return (
    ECOSYSTEM_EDGE_LABELS[edge.type as keyof typeof ECOSYSTEM_EDGE_LABELS] ?? humanize(edge.type)
  )
}

/** How much stands behind an edge: co-hosted events per academic year, an
 * introduction's status, or the number of sightings. */
function edgeDetail(edge: EcosystemEdge): string {
  if (edge.years.length > 0) {
    return edge.years.map((year) => `${year.academicYear}: ${year.count}`).join(" · ")
  }
  if (edge.status) return humanize(edge.status).toLowerCase()
  return `${edge.weight} ${edge.weight === 1 ? "sighting" : "sightings"}`
}

function matchReason(match: BrokerMatch): string {
  const shared = match.sharedCategories.length
    ? ` Both are in ${match.sharedCategories
        .map((c) => CATEGORY_LABELS[c as Category] ?? c)
        .join(", ")}.`
    : ""
  if (match.kind === "past_sponsor") {
    return `${match.needName} needs ${humanize(match.need).toLowerCase()}; ${match.offerName} has sponsored ${match.sponsoredName}.${shared}`
  }
  return `${match.needName} needs ${humanize(match.need).toLowerCase()}; ${match.offerName} offers ${humanize(match.offer ?? match.need).toLowerCase()}.${shared}`
}

/**
 * The organisation graph: the ecosystem map's layers (lib/broker/ecosystem.ts)
 * — relationships (public and internal, filtered by type), co-hosted events,
 * sponsors and the broker's outreach — as a force-directed picture with a
 * list beside it, and "who could meet whom", complementary needs and offers
 * that become introduction ideas. People are only ever a count.
 */
export function BrokerGraph() {
  const [layers, setLayers] = useState<EcosystemLayer[]>(["relationships"])
  const [types, setTypes] = useState<RelationshipType[]>([])
  const [visibility, setVisibility] = useState<Visibility>("all")
  const [selected, setSelected] = useState<string | null>(null)
  const graph = useBrokerEcosystem(layers, layers.includes("relationships") ? types : [])

  const view = useMemo(() => {
    if (!graph) return undefined
    const limited = limitView(graph, { visibility })
    const nodes: GraphNode[] = limited.nodes.map((node) => ({
      key: node.id,
      name: node.name,
      isCounterpart: node.isCounterpart,
      degree: node.degree,
    }))
    const edges: GraphEdge[] = limited.edges.map((edge) => ({
      key: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      visibility: edge.visibility,
    }))
    return {
      nodes,
      edges,
      ecosystemEdges: limited.edges,
      dropped: limited.dropped,
      byId: new Map(graph.nodes.map((node) => [node.id, node])),
    }
  }, [graph, visibility])

  const selectedNode = selected ? view?.byId.get(selected) : undefined
  const selectedEdges = useMemo(
    () =>
      view && selected
        ? view.ecosystemEdges.filter((edge) => edge.from === selected || edge.to === selected)
        : [],
    [view, selected],
  )

  return (
    <>
      <BrokerPageHeader
        title="Graph"
        description="Sponsors, co-hosts, sister societies and affiliations, your outreach — and who could usefully meet."
      />

      <div className="flex flex-col gap-2">
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={1}
          value={layers}
          onValueChange={(value) => {
            // At least one layer stays on.
            if (value.length === 0) return
            setLayers(value as EcosystemLayer[])
            setSelected(null)
          }}
          className="flex-wrap"
          aria-label="Layers"
        >
          {ECOSYSTEM_LAYERS.map((layer) => (
            <ToggleGroupItem key={layer} value={layer}>
              {LAYER_LABELS[layer]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {layers.includes("relationships") && (
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={1}
            value={types}
            onValueChange={(value) => {
              setTypes(value as RelationshipType[])
              setSelected(null)
            }}
            className="flex-wrap"
            aria-label="Relationship types"
          >
            {RELATIONSHIP_TYPES.map((type) => (
              <ToggleGroupItem key={type} value={type}>
                {RELATIONSHIP_LABELS[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={visibility}
          onValueChange={(value) => value && setVisibility(value as Visibility)}
          aria-label="Visibility"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="public">Public</ToggleGroupItem>
          <ToggleGroupItem value="internal">Internal</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col gap-3">
            {view === undefined ? (
              <Skeleton className="aspect-[11/7] w-full rounded-lg" />
            ) : view.nodes.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <NetworkIcon />
                  </EmptyMedia>
                  <EmptyTitle>Nothing in these layers yet</EmptyTitle>
                  <EmptyDescription>
                    Edges appear as the pipeline finds sponsors, co-hosted events and affiliations,
                    and as you record introductions and interactions.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <RelationshipGraph
                nodes={view.nodes}
                edges={view.edges}
                selected={selected}
                onSelect={setSelected}
              />
            )}
            <GraphLegend />
            {view && (view.dropped > 0 || graph?.truncated) && (
              <p className="text-xs text-muted-foreground">
                Showing the {view.nodes.length} best-connected organisations
                {view.dropped > 0 && `; ${view.dropped} more are left out`}. Filter by layer or type
                to see them.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="truncate">
              {selected ? (selectedNode?.name ?? selected) : "Select an organisation"}
            </CardTitle>
            <CardDescription>
              {selectedNode ? (
                <Link
                  href={`/dashboard/organisations?org=${selectedNode.key}`}
                  className="underline-offset-4 hover:underline"
                >
                  Open its record
                </Link>
              ) : (
                "Click or focus a node to list its relationships."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {selectedNode && <NodeBadges node={selectedNode} />}
            <ul className="flex max-h-96 flex-col gap-2 overflow-auto text-sm">
              {selectedEdges.map((edge) => {
                const other = edge.from === selected ? edge.to : edge.from
                return (
                  <li key={edge.id} className="flex flex-col">
                    <span className="text-xs text-muted-foreground">
                      {edge.from === selected ? edgeLabel(edge) : `${edgeLabel(edge)} (incoming)`} ·{" "}
                      {edge.layer === "relationships" ? edge.visibility : LAYER_LABELS[edge.layer]}
                    </span>
                    <button
                      type="button"
                      className="text-left font-medium underline-offset-4 hover:underline"
                      onClick={() => setSelected(other)}
                    >
                      {view?.byId.get(other)?.name ?? other}
                    </button>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {edgeDetail(edge)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Matches />
    </>
  )
}

/**
 * What the map knows about one organisation beyond its edges, each as an icon
 * and words (never colour alone): a sensitive society (Art 9), a hidden
 * listing, how many people the CRM holds (a count; people are never nodes)
 * and your interactions with it.
 */
function NodeBadges({ node }: { node: EcosystemNode }) {
  if (!node.sensitive && !node.hidden && node.people === 0 && node.interactions === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {node.sensitive && (
        <Badge variant="outline">
          <ShieldAlertIcon />
          sensitive
        </Badge>
      )}
      {node.hidden && (
        <Badge variant="outline">
          <EyeOffIcon />
          hidden
        </Badge>
      )}
      {node.people > 0 && (
        <Badge variant="outline" className="font-mono tabular-nums">
          <UsersIcon />
          {node.people} {node.people === 1 ? "person" : "people"}
        </Badge>
      )}
      {node.interactions > 0 && (
        <Badge variant="outline" className="font-mono tabular-nums">
          <MessagesSquareIcon />
          {node.interactions} {node.interactions === 1 ? "interaction" : "interactions"}
          {node.lastInteractionAt !== undefined && `, last ${formatDate(node.lastInteractionAt)}`}
        </Badge>
      )}
    </div>
  )
}

function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="28" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="28" y2="4" stroke="var(--primary)" strokeWidth="2" />
        </svg>
        public
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="28" height="8" aria-hidden="true">
          <line
            x1="0"
            y1="4"
            x2="28"
            y2="4"
            stroke="var(--muted-foreground)"
            strokeWidth="2"
            strokeDasharray="4 3"
          />
        </svg>
        internal
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="var(--card)" stroke="var(--foreground)" />
        </svg>
        society or club
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="12" height="12" aria-hidden="true">
          <rect
            x="1"
            y="1"
            width="10"
            height="10"
            rx="2"
            fill="var(--card)"
            stroke="var(--foreground)"
          />
        </svg>
        counterpart
      </span>
      <span>size: number of edges</span>
      <span>layers other than relationships: internal</span>
    </div>
  )
}

function Matches() {
  const matches = useBrokerMatches()
  const intros = useBrokerIntroductions()
  const { create } = useBrokerIntroductionMutations()

  const existing = useMemo(() => {
    const pairs = new Set<string>()
    for (const intro of intros ?? []) {
      const a = intro.partyA.orgKey
      const b = intro.partyB.orgKey
      if (a && b) pairs.add([a, b].sort().join("|"))
    }
    return pairs
  }, [intros])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          Who could meet whom
        </CardTitle>
        <CardDescription>
          Complementary needs and offers, and sponsors of similar societies. Confirmed entries and
          shared categories rank higher; rejected ones never appear.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {matches === undefined ? (
          <Skeleton className="h-40" />
        ) : matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matches yet. They appear once organisations have needs and offers (inferred by the
            pipeline or added in their records).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Needs</TableHead>
                  <TableHead>Could help</TableHead>
                  <TableHead className="hidden md:table-cell">Why</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.slice(0, 60).map((match) => {
                  const pair = [match.needKey, match.offerKey].sort().join("|")
                  const done = existing.has(pair)
                  return (
                    <TableRow key={`${match.needKey}-${match.offerKey}-${match.need}`}>
                      <TableCell className="align-top">
                        <Link
                          href={`/dashboard/organisations?org=${match.needKey}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {match.needName}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {humanize(match.need).toLowerCase()}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Link
                          href={`/dashboard/organisations?org=${match.offerKey}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {match.offerName}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {match.kind === "past_sponsor"
                            ? `sponsored ${match.sponsoredName}`
                            : `offers ${humanize(match.offer ?? match.need).toLowerCase()}`}
                        </div>
                      </TableCell>
                      <TableCell className="hidden align-top md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline">
                            {match.kind === "past_sponsor" ? "past sponsor" : "offer"}
                          </Badge>
                          {match.sharedCategories.map((c) => (
                            <Badge key={c} variant="ghost" className="text-muted-foreground">
                              {CATEGORY_LABELS[c as Category] ?? c}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top font-mono tabular-nums">
                        {match.score.toFixed(1)}
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={done}
                          onClick={() =>
                            runWithToast(
                              create({
                                partyA: { orgKey: match.needKey },
                                partyB: { orgKey: match.offerKey },
                                reason: matchReason(match),
                                status: "idea",
                              }),
                              "Added to introductions as an idea",
                            )
                          }
                        >
                          <HandshakeIcon />
                          {done ? "On the board" : "Add idea"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
