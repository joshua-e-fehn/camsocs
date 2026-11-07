"use client"

import { ChevronRightIcon } from "lucide-react"
import { useState } from "react"
import { ExternalLink } from "@/components/molecules/external-link"
import { PHASE_ICONS, StageStatusMark } from "@/components/molecules/stage-node"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { useStageDetail } from "@/hooks/convex/pipeline"
import { formatDateTime, percent } from "@/lib/broker/format"
import {
  docHref,
  docLabel,
  PILLAR_LABELS,
  type PipelineGraph,
  type StageNode,
  stageIo,
  stageTitle,
} from "@/lib/pipeline-graph/graph"
import {
  fetchErrorShare,
  formatCount,
  formatDuration,
  type StageView,
  yieldRatio,
} from "@/lib/pipeline-graph/status"

/**
 * One stage's sheet on `/dashboard/pipeline` (spec §5B): the newest result's
 * metrics, the yield against its median, the fetch counters ("not recorded"
 * when the result carried none, never zeros), the docs § it is built on, the
 * groups that run it and what it reads, writes and posts. The run's notes and
 * error sit behind a disclosure and are read from the broker-only
 * `stageDetail` only once it is opened.
 */
export function StageSheet({
  graph,
  stage,
  view,
  onOpenChange,
}: {
  graph: PipelineGraph
  /** The open stage, or null when the sheet is closed. */
  stage: StageNode | null
  view: StageView | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={stage !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {stage && view && <SheetBody graph={graph} stage={stage} view={view} />}
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-4">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

/** A definition list of label → value, values in mono. */
function Metrics({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-mono tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function NamesList({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ul className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li key={name}>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{name}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SheetBody({
  graph,
  stage,
  view,
}: {
  graph: PipelineGraph
  stage: StageNode
  view: StageView
}) {
  const PhaseIcon = PHASE_ICONS[stage.phase]
  const io = stageIo(graph, stage.id)
  const ratio = yieldRatio(view)
  const share = fetchErrorShare(view.fetch)
  const groups = graph.groups.filter((group) => stage.groups.includes(group.key))

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SheetHeader className="gap-2 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <PhaseIcon aria-hidden="true" />
            {stage.phase}
          </Badge>
          <Badge variant="outline">{PILLAR_LABELS[stage.pillar]}</Badge>
          <Badge variant="outline">{stage.campus === null ? "engine" : stage.campus}</Badge>
        </div>
        <SheetTitle className="text-xl">{stageTitle(stage)}</SheetTitle>
        <SheetDescription>{stage.description ?? `The ${stage.name} stage.`}</SheetDescription>
        <StageStatusMark view={view} className="text-sm" />
      </SheetHeader>

      <Section title="Newest result">
        <Metrics
          rows={[
            ["Run", view.runKey ?? "—"],
            ["Started", formatDateTime(view.startedAt)],
            ["Duration", formatDuration(view.durationMs)],
            ["Yield", formatCount(view.yield)],
            ["Inserted", formatCount(view.inserted)],
            ["Updated", formatCount(view.updated)],
            ["Unchanged", formatCount(view.unchanged)],
            ["Skipped", formatCount(view.skipped)],
            ["Failed in a row", formatCount(view.failStreak)],
            ["Last ok", formatDateTime(view.lastOkAt)],
            ["Last productive", formatDateTime(view.lastProductiveAt)],
          ]}
        />
      </Section>

      <Section title={`Yield against the ${view.medianDays}-day median`}>
        <Metrics
          rows={[
            ["Median", view.median === null ? "—" : formatCount(view.median)],
            ["Runs in the median", formatCount(view.medianSamples)],
            ["Latest ÷ median", ratio === null ? "—" : percent(ratio)],
          ]}
        />
      </Section>

      <Section title="Fetches">
        {view.fetch === null ? (
          <p className="text-sm text-muted-foreground">
            Not recorded: the newest result carried no fetch counters.
          </p>
        ) : (
          <Metrics
            rows={[
              ["Requests", formatCount(view.fetch.requests)],
              [
                "Errors",
                `${formatCount(view.fetch.errors)}${share === null ? "" : ` (${percent(share)})`}`,
              ],
              ["HTTP 4xx", formatCount(view.fetch.status4xx)],
              ["HTTP 5xx", formatCount(view.fetch.status5xx)],
              ["Blocked by robots.txt", formatCount(view.fetch.robotsBlocked)],
              ["Retries", formatCount(view.fetch.retries)],
              ["Too many requests (429)", formatCount(view.fetch.tooMany)],
            ]}
          />
        )}
      </Section>

      {view.talkRun && (
        <Section title="Talks pillar run">
          <Metrics
            rows={[
              ["Status", view.talkRun.status],
              ["Finished", formatDateTime(view.talkRun.finishedAt)],
              ["Sources ok", formatCount(view.talkRun.sourcesOk)],
              ["Sources failed", formatCount(view.talkRun.sourcesFailed)],
              ["Talks received", formatCount(view.talkRun.talksReceived)],
              ["Inserted", formatCount(view.talkRun.inserted)],
              ["Updated", formatCount(view.talkRun.updated)],
              ["Unchanged", formatCount(view.talkRun.unchanged)],
              ["Missing", formatCount(view.talkRun.missing)],
              ["Errors", formatCount(view.talkRun.errorCount)],
            ]}
          />
        </Section>
      )}

      <Section title="Docs">
        {stage.docs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No section cited.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {stage.docs.map((ref) => (
              <li key={`${ref.doc}#${ref.section}`}>
                <ExternalLink href={docHref(ref)} className="text-brand-text">
                  {docLabel(ref)}
                </ExternalLink>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Groups">
        <ul className="flex flex-col gap-1.5 text-sm">
          {groups.map((group) => (
            <li key={group.key} className="flex flex-wrap items-baseline gap-x-2">
              <code className="font-mono text-xs font-semibold">{group.key}</code>
              <span className="text-muted-foreground">{group.schedule ?? "on request"}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Reads, writes and posts">
        <div className="flex flex-col gap-2">
          <NamesList label="Waits for" names={io.requires} />
          <NamesList label="Reads" names={io.reads} />
          <NamesList label="Writes" names={io.writes} />
          <NamesList label="Posts" names={io.posts} />
          <p className="text-xs text-muted-foreground">
            {stage.network ? "Fetches from the web" : "No web fetches"}
            {stage.llm ? " · calls the LLM" : " · no LLM"}
            {stage.fetchesInDryRun ? " · fetches in a dry run" : ""}
          </p>
        </div>
      </Section>

      {view.runKey && <NotesDisclosure runKey={view.runKey} stage={stage.name} />}
    </div>
  )
}

/** The run's notes and error, read only once opened. */
function NotesDisclosure({ runKey, stage }: { runKey: string; stage: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2 px-4">
      <CollapsibleTrigger className="group inline-flex items-center gap-1 self-start rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
        Notes and error of this run
      </CollapsibleTrigger>
      <CollapsibleContent>{open && <NotesBody runKey={runKey} stage={stage} />}</CollapsibleContent>
    </Collapsible>
  )
}

function NotesBody({ runKey, stage }: { runKey: string; stage: string }) {
  const detail = useStageDetail({ runKey, stage })
  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (detail === null) {
    return <p className="text-sm text-muted-foreground">This run posted no result for the stage.</p>
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      {detail.error !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-destructive">Error</span>
          <pre className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            {detail.error}
          </pre>
        </div>
      )}
      {detail.notes.length === 0 ? (
        <p className="text-muted-foreground">No notes.</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {detail.notes.map((note, index) => (
            // Notes are plain lines with no id; their order is the run's.
            // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reordered
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
