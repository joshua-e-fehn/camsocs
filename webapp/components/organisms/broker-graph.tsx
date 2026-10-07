"use client"

import { HandshakeIcon, NetworkIcon, SparklesIcon } from "lucide-react"
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
  useBrokerGraph,
  useBrokerIntroductionMutations,
  useBrokerIntroductions,
  useBrokerMatches,
} from "@/hooks/convex/broker"
import { humanize, RELATIONSHIP_LABELS } from "@/lib/broker/format"
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

/** More nodes than this stop being readable; the best-connected are kept. */
const MAX_NODES = 250

type Visibility = "all" | "public" | "internal"

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
 * The organisation graph: every relationship (public and internal), filtered
 * by type, as a force-directed picture with a list beside it — and "who could
 * meet whom", complementary needs and offers that become introduction ideas.
 */
export function BrokerGraph() {
  const [types, setTypes] = useState<RelationshipType[]>([])
  const [visibility, setVisibility] = useState<Visibility>("all")
  const [selected, setSelected] = useState<string | null>(null)
  const graph = useBrokerGraph(types)

  const view = useMemo(() => {
    if (!graph) return undefined
    const edges: GraphEdge[] = graph.edges.filter(
      (edge) => visibility === "all" || edge.visibility === visibility,
    )
    const degree = new Map<string, number>()
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    }
    const nodes: GraphNode[] = graph.nodes
      .filter((node) => degree.has(node.key))
      .map((node) => ({ ...node, degree: degree.get(node.key) ?? 0 }))
      .sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
      .slice(0, MAX_NODES)
    const kept = new Set(nodes.map((node) => node.key))
    return {
      nodes,
      edges: edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
      dropped: degree.size - nodes.length,
      names: new Map(graph.nodes.map((node) => [node.key, node.name])),
    }
  }, [graph, visibility])

  const selectedEdges = useMemo(
    () =>
      view && selected
        ? view.edges.filter((edge) => edge.from === selected || edge.to === selected)
        : [],
    [view, selected],
  )

  return (
    <>
      <BrokerPageHeader
        title="Graph"
        description="Sponsors, co-hosts, sister societies and affiliations — and who could usefully meet."
      />

      <div className="flex flex-col gap-2">
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
                  <EmptyTitle>No relationships yet</EmptyTitle>
                  <EmptyDescription>
                    Edges appear as the pipeline finds sponsors, co-hosted events and affiliations.
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
                {view.dropped > 0 && `; ${view.dropped} more are left out`}. Filter by type to see
                them.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="truncate">
              {selected ? (view?.names.get(selected) ?? selected) : "Select an organisation"}
            </CardTitle>
            <CardDescription>
              {selected ? (
                <Link
                  href={`/dashboard/organisations?org=${selected}`}
                  className="underline-offset-4 hover:underline"
                >
                  Open its record
                </Link>
              ) : (
                "Click or focus a node to list its relationships."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex max-h-96 flex-col gap-2 overflow-auto text-sm">
              {selectedEdges.map((edge) => {
                const other = edge.from === selected ? edge.to : edge.from
                return (
                  <li key={edge.key} className="flex flex-col">
                    <span className="text-xs text-muted-foreground">
                      {edge.from === selected
                        ? RELATIONSHIP_LABELS[edge.type]
                        : `${RELATIONSHIP_LABELS[edge.type]} (incoming)`}{" "}
                      · {edge.visibility}
                    </span>
                    <button
                      type="button"
                      className="text-left font-medium underline-offset-4 hover:underline"
                      onClick={() => setSelected(other)}
                    >
                      {view?.names.get(other) ?? other}
                    </button>
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
      <span>size: number of relationships</span>
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
