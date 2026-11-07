"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { PipelineCanvas } from "@/components/molecules/pipeline-canvas"
import { StageLegend, StageStatusMark } from "@/components/molecules/stage-node"
import { StageSheet } from "@/components/molecules/stage-sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePipelineRuns, useStageStatus } from "@/hooks/convex/pipeline"
import { formatDateTime } from "@/lib/broker/format"
import {
  GROUPS,
  type GroupKey,
  PILLAR_LABELS,
  PILLARS,
  PIPELINE_GRAPH,
  stageNodes,
} from "@/lib/pipeline-graph/graph"
import { layoutPipeline } from "@/lib/pipeline-graph/layout"
import {
  NODE_STATES,
  STATE_WORDS,
  type StageView,
  stageViews,
  stateCounts,
} from "@/lib/pipeline-graph/status"

/**
 * `/dashboard/pipeline` (spec §5B): the pipeline as a node graph, phases left
 * to right and one band per campus × pillar, every stage showing its newest
 * result. The group picker narrows the run log to the daily `events`, the
 * weekly `full` or the `talks` group; the run picker shows one run instead of
 * the newest result per stage. Clicking a stage opens its sheet.
 */

const ALL = "all"
const LATEST = "latest"
type GroupChoice = GroupKey | typeof ALL

const GROUP_LABELS: Record<GroupChoice, string> = {
  all: "All runs",
  events: "events",
  full: "full",
  talks: "talks",
}

/** The layout depends only on the generated graph, so it is computed once. */
const LAYOUT = layoutPipeline(PIPELINE_GRAPH)
const STAGES = stageNodes(PIPELINE_GRAPH)

/** The clock the "running" state is judged by, refreshed every minute. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function BrokerPipeline() {
  const [group, setGroup] = useState<GroupChoice>(ALL)
  const [runKey, setRunKey] = useState<string>(LATEST)
  const [selected, setSelected] = useState<string | null>(null)
  const now = useMinuteClock()

  const groupArg = group === ALL ? undefined : group
  const status = useStageStatus(groupArg)
  const runs = usePipelineRuns(groupArg, 20)
  const run = runKey === LATEST ? null : (runs?.find((r) => r.runKey === runKey) ?? null)

  const views = useMemo(() => {
    if (run) return stageViews(PIPELINE_GRAPH, { kind: "run", run, now })
    if (status === undefined) return null
    return stageViews(PIPELINE_GRAPH, { kind: "status", rows: status, group: groupArg })
  }, [run, status, groupArg, now])

  const onOpenStage = useCallback((name: string) => setSelected(name), [])
  const selectedStage = STAGES.find((stage) => stage.name === selected) ?? null

  return (
    <>
      <BrokerPageHeader
        title="Pipeline"
        description="Every stage by phase and lane, with its newest result. Open a stage for its numbers, docs and groups."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          value={group}
          onValueChange={(value) => {
            if (!value) return
            setGroup(value as GroupChoice)
            setRunKey(LATEST)
          }}
          className="flex-wrap"
          aria-label="Group"
        >
          {([ALL, ...GROUPS] as GroupChoice[]).map((choice) => (
            <ToggleGroupItem
              key={choice}
              value={choice}
              className={choice === ALL ? "" : "font-mono"}
            >
              {GROUP_LABELS[choice]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select value={runKey} onValueChange={setRunKey}>
          <SelectTrigger size="sm" className="w-full sm:w-80" aria-label="Run">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={LATEST}>Newest result per stage</SelectItem>
            {(runs ?? []).map((r) => (
              <SelectItem key={r.runKey} value={r.runKey}>
                <span className="font-mono tabular-nums">{formatDateTime(r.startedAt)}</span>
                <span className="text-muted-foreground">
                  {r.group ?? "ad hoc"} · {r.status}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {views === null ? (
        <Skeleton className="h-[min(78vh,860px)] min-h-[420px] w-full rounded-xl" />
      ) : (
        <>
          <PillarSummary views={views} />
          {!run && status?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No run of this group is recorded yet, so every stage reads “not run”.
            </p>
          )}
          <PipelineCanvas
            layout={LAYOUT}
            views={views}
            selected={selected}
            onOpenStage={onOpenStage}
          />
        </>
      )}

      <StageLegend />

      <StageSheet
        graph={PIPELINE_GRAPH}
        stage={selectedStage}
        view={selectedStage && views ? views[selectedStage.name] : null}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </>
  )
}

/** One line per pillar: how many of its stages are in each state. */
function PillarSummary({ views }: { views: Record<string, StageView> }) {
  return (
    <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {PILLARS.map((pillar) => {
        const stages = STAGES.filter((stage) => stage.pillar === pillar)
        const counts = stateCounts(stages.map((stage) => views[stage.name]))
        return (
          <li key={pillar} className="flex flex-col gap-1 rounded-xl border bg-card p-3">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {PILLAR_LABELS[pillar]} · {stages.length} {stages.length === 1 ? "stage" : "stages"}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {NODE_STATES.filter((state) => counts[state] > 0).map((state) => (
                <span key={state} className="inline-flex items-center gap-1">
                  <StageStatusMark view={{ state, failStreak: 0, yieldDrop: false }} />
                  <span className="sr-only">:</span>
                  <span className="font-mono text-xs tabular-nums" title={STATE_WORDS[state]}>
                    {counts[state]}
                  </span>
                </span>
              ))}
              {counts.yieldDrop > 0 && (
                <span className="inline-flex items-center gap-1 text-xs">
                  yield ↓ <span className="font-mono tabular-nums">{counts.yieldDrop}</span>
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
