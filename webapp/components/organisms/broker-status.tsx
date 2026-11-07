"use client"

import Link from "next/link"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { StageStatusMark } from "@/components/molecules/stage-node"
import { StatTile } from "@/components/molecules/stat-tile"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useBrokerSummary } from "@/hooks/convex/broker"
import { useStageStatus, useTalksOverview } from "@/hooks/convex/pipeline"
import { EVENT_SOURCE_LABELS, formatDateTime, percent } from "@/lib/broker/format"
import {
  PILLAR_LABELS,
  PIPELINE_GRAPH,
  type Pillar,
  stageNodes,
  stageTitle,
} from "@/lib/pipeline-graph/graph"
import {
  type FetchGap,
  fetchGap,
  formatCount,
  formatDuration,
  type SourceStatusRow,
  type StageView,
  sourceStatusRows,
  stagesWithoutSource,
  stageViews,
  stateCounts,
} from "@/lib/pipeline-graph/status"

/**
 * `/dashboard/status` (spec §5D): one row per source in the campus's manifest,
 * joined to its stage's newest result (last ok, last productive run, status,
 * yield against the 7/28-day median, fetch error share, duration), a tile
 * per pillar from Convex's own tables, and the stages no source names
 * (resolve, classify, load, report…), so a failed `load` shows here too.
 * Counts and dates only: no notes and no error text. This page is the
 * fallback view when PostHog is down.
 */

const STAGES = stageNodes(PIPELINE_GRAPH)
const SOURCELESS = stagesWithoutSource(PIPELINE_GRAPH)
const TILE_PILLARS: Exclude<Pillar, "shared">[] = ["societies", "events", "talks"]

/** The fetch cell's words when there are no counters to show. */
const FETCH_GAP_WORDS: Record<FetchGap, string> = {
  no_fetch: "no fetches",
  no_result: "—",
  none_recorded: "none recorded",
}

const PERMISSION_LABELS: Record<string, string> = {
  robots: "robots.txt",
  D3: "D3 society override",
  D3a: "D3a recorded permission",
}

export function BrokerStatus() {
  const status = useStageStatus()
  const rows = status === undefined ? undefined : sourceStatusRows(PIPELINE_GRAPH, status)
  const views =
    status === undefined ? undefined : stageViews(PIPELINE_GRAPH, { kind: "status", rows: status })

  return (
    <>
      <BrokerPageHeader
        title="Status"
        description="Each source's newest result, its yield against the usual, and each pillar's counts in Convex."
      >
        <Link
          href="/dashboard/pipeline"
          className="text-sm text-brand-text underline-offset-4 hover:underline"
        >
          Open the pipeline graph
        </Link>
      </BrokerPageHeader>

      <div className="grid gap-4 md:grid-cols-3">
        {TILE_PILLARS.map((pillar) => (
          <PillarTile key={pillar} pillar={pillar} views={views} />
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="border-b-2 border-foreground pb-1 font-serif text-xl">Sources</h2>
        <p className="text-sm text-muted-foreground">
          Yield is what a stage found in its newest run (inserted + updated + unchanged), against
          the median of its earlier ok runs: 7 days for the daily events group, 28 for the weekly
          full run.
        </p>
        <SourceTable rows={rows} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="border-b-2 border-foreground pb-1 font-serif text-xl">
          Stages without a source
        </h2>
        <p className="text-sm text-muted-foreground">
          The engine stages that read what the sources staged, and the shared ones that post it to
          Convex and report on it.
        </p>
        <EngineTable views={views} />
      </section>
    </>
  )
}

function EngineTable({ views }: { views: Record<string, StageView> | undefined }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Stage</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last ok</TableHead>
            <TableHead className="text-right">Yield</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {SOURCELESS.map((stage) => {
            const view = views?.[stage.name]
            return (
              <TableRow key={stage.name}>
                <TableCell className="min-w-56 align-top whitespace-normal">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-sm">{stageTitle(stage)}</code>
                    <Badge variant="outline">{PILLAR_LABELS[stage.pillar]}</Badge>
                  </span>
                </TableCell>
                {view === undefined ? (
                  Array.from({ length: 4 }, (_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))
                ) : (
                  <>
                    <TableCell className="align-top">
                      <StageStatusMark view={view} />
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs tabular-nums">
                      {formatDateTime(view.lastOkAt)}
                    </TableCell>
                    <TableCell className="text-right align-top font-mono tabular-nums">
                      {formatCount(view.yield)}
                    </TableCell>
                    <TableCell className="text-right align-top font-mono tabular-nums">
                      {formatDuration(view.durationMs)}
                    </TableCell>
                  </>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function SourceTable({ rows }: { rows: SourceStatusRow[] | undefined }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last ok</TableHead>
            <TableHead>Last productive</TableHead>
            <TableHead className="text-right">Yield</TableHead>
            <TableHead className="text-right">Median</TableHead>
            <TableHead className="text-right">Fetch errors</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows === undefined
            ? Array.from({ length: 6 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
                <TableRow key={i}>
                  {Array.from({ length: 8 }, (_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => <SourceRow key={row.source.key} row={row} />)}
        </TableBody>
      </Table>
    </div>
  )
}

function SourceRow({ row }: { row: SourceStatusRow }) {
  const { source, stage, view, errorShare, ratio } = row
  const gap = fetchGap(stage, view)
  return (
    <TableRow>
      <TableCell className="min-w-56 align-top whitespace-normal">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{source.label}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline">{PILLAR_LABELS[source.pillar]}</Badge>
            <code className="font-mono">{stage ? stageTitle(stage) : source.stage}</code>
            {source.section && <span>§{source.section}</span>}
            {source.permission && <span>{PERMISSION_LABELS[source.permission]}</span>}
          </span>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <StageStatusMark view={view} />
      </TableCell>
      <TableCell className="align-top font-mono text-xs tabular-nums">
        {formatDateTime(view.lastOkAt)}
      </TableCell>
      <TableCell className="align-top font-mono text-xs tabular-nums">
        {formatDateTime(view.lastProductiveAt)}
      </TableCell>
      <TableCell className="text-right align-top font-mono tabular-nums">
        {formatCount(view.yield)}
      </TableCell>
      <TableCell className="text-right align-top font-mono tabular-nums">
        <span className="flex flex-col items-end">
          <span>
            {view.median === null ? "—" : formatCount(view.median)}
            <span className="text-xs text-muted-foreground"> /{view.medianDays} d</span>
          </span>
          {ratio !== null && (
            <span className="text-xs text-muted-foreground">{percent(ratio)} of median</span>
          )}
        </span>
      </TableCell>
      <TableCell className="text-right align-top font-mono tabular-nums">
        {gap !== null || view.fetch === null ? (
          <span className="font-sans text-xs text-muted-foreground">
            {FETCH_GAP_WORDS[gap ?? "none_recorded"]}
          </span>
        ) : errorShare === null ? (
          "—"
        ) : (
          <span className="flex flex-col items-end">
            <span>{percent(errorShare)}</span>
            <span className="text-xs text-muted-foreground">
              of {formatCount(view.fetch.requests)}
            </span>
          </span>
        )}
      </TableCell>
      <TableCell className="text-right align-top font-mono tabular-nums">
        {formatDuration(view.durationMs)}
      </TableCell>
    </TableRow>
  )
}

/** "11 ok · 1 failed · 2 not run" over a pillar's stages. */
function stageHealth(views: Record<string, StageView>, pillar: Pillar): string {
  const counts = stateCounts(
    STAGES.filter((stage) => stage.pillar === pillar).map((stage) => views[stage.name]),
  )
  const parts = [
    counts.ok && `${counts.ok} ok`,
    counts.failed && `${counts.failed} failed`,
    counts.running && `${counts.running} running`,
    counts.not_run && `${counts.not_run} not run`,
    counts.not_requested && `${counts.not_requested} not requested`,
    counts.yieldDrop && `${counts.yieldDrop} yield ↓`,
  ].filter(Boolean)
  return parts.length === 0 ? "no stages" : `Stages: ${parts.join(" · ")}`
}

function PillarTile({
  pillar,
  views,
}: {
  pillar: Exclude<Pillar, "shared">
  views: Record<string, StageView> | undefined
}) {
  const health = views ? stageHealth(views, pillar) : null
  if (pillar === "societies") return <SocietiesTile health={health} />
  if (pillar === "events") return <EventsTile health={health} />
  return <TalksTile health={health} talksView={views?.talks} />
}

function TileSkeleton() {
  return <Skeleton className="h-36 rounded-xl" />
}

/** Societies: the directory's coverage snapshot (`coverageSnapshots`). */
function SocietiesTile({ health }: { health: string | null }) {
  const summary = useBrokerSummary()
  if (summary === undefined) return <TileSkeleton />
  const coverage = summary.coverage
  return (
    <StatTile
      label="Societies · directory"
      value={coverage ? formatCount(coverage.stats.total) : "—"}
      hint={
        <span className="flex flex-col gap-0.5">
          {coverage ? (
            <>
              <span>
                listings · website {percent(coverage.stats.share.website)} · contact{" "}
                {percent(coverage.stats.share.email)}
              </span>
              <span>coverage computed {formatDateTime(coverage.computedAt)}</span>
            </>
          ) : (
            <span>Coverage not computed yet.</span>
          )}
          {health && <span>{health}</span>}
        </span>
      }
    />
  )
}

/** Events: events in the next 14 days by source (broker overview). */
function EventsTile({ health }: { health: string | null }) {
  const summary = useBrokerSummary()
  if (summary === undefined) return <TileSkeleton />
  const { total, truncated, bySource } = summary.events
  const sources = Object.entries(bySource)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  return (
    <StatTile
      label="Events · next 14 days"
      value={`${formatCount(total)}${truncated ? "+" : ""}`}
      hint={
        <span className="flex flex-col gap-1">
          {sources.length === 0 ? (
            <span>No upcoming events.</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sources.map(([source, count]) => (
                <li key={source} className="flex justify-between gap-2">
                  <span>{EVENT_SOURCE_LABELS[source] ?? source}</span>
                  <span className="font-mono tabular-nums">{formatCount(count)}</span>
                </li>
              ))}
            </ul>
          )}
          {health && <span>{health}</span>}
        </span>
      }
    />
  )
}

/** Talks: the pillar's counts (`talkStats`) and its last run (`talkRuns`), counts only. */
function TalksTile({ health, talksView }: { health: string | null; talksView?: StageView }) {
  const overview = useTalksOverview()
  if (overview === undefined) return <TileSkeleton />
  const run = talksView?.talkRun ?? null
  return (
    <StatTile
      label="Talks · next 28 days"
      value={formatCount(overview.next28Days)}
      hint={
        <span className="flex flex-col gap-0.5">
          <span>
            {formatCount(overview.thisWeek)} this week · {formatCount(overview.departments)} of{" "}
            {formatCount(overview.departmentsTotal)} departments listing
          </span>
          <span>last talks run {formatDateTime(overview.lastRunAt)}</span>
          {run && (
            <span>
              {run.status} · {formatCount(run.sourcesOk)} sources ok,{" "}
              {formatCount(run.sourcesFailed)} failed · {formatCount(run.talksReceived)} talks
              received
            </span>
          )}
          {health && <span>{health}</span>}
        </span>
      }
    />
  )
}
