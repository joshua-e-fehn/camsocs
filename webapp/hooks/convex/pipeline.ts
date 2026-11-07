// Hooks for the broker's pipeline pages (/dashboard/pipeline, /dashboard/status).
// Thin wrappers over convex/react, like ./broker.ts. Every broker function
// behind them calls `requireBrokerUser`, so they are only mounted inside
// `BrokerGate`.
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import type { GroupKey } from "@/lib/pipeline-graph/graph"

export type PipelineStageDetail = NonNullable<
  FunctionReturnType<typeof api.broker.pipeline.stageDetail>
>
export type TalksOverview = FunctionReturnType<typeof api.talks.overview>

/** Per-stage status over the newest runs, optionally of one group. */
export function useStageStatus(group?: GroupKey) {
  return useQuery(api.broker.pipeline.stageStatus, group ? { group } : {})
}

/** The newest runs for the run picker (at most 30). */
export function usePipelineRuns(group?: GroupKey, limit = 15) {
  return useQuery(api.broker.pipeline.runs, group ? { group, limit } : { limit })
}

/** One stage's notes and error, read only once the broker opens them. */
export function useStageDetail(target: { runKey: string; stage: string } | null) {
  return useQuery(api.broker.pipeline.stageDetail, target ?? "skip")
}

/** The talks pillar's counts (`talkStats`) and its last run (`talkRuns`). */
export function useTalksOverview() {
  return useQuery(api.talks.overview)
}
