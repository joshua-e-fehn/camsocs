import {
  BanIcon,
  BotIcon,
  CalendarDaysIcon,
  CheckIcon,
  CircleDashedIcon,
  DatabaseIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  GitMergeIcon,
  GlobeIcon,
  InboxIcon,
  LoaderIcon,
  type LucideIcon,
  MicIcon,
  SparklesIcon,
  SproutIcon,
  TagsIcon,
  TrendingDownIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react"
import type { CSSProperties } from "react"
import { type Phase, type StageNode, stageTitle } from "@/lib/pipeline-graph/graph"
import type { PortNode } from "@/lib/pipeline-graph/layout"
import {
  formatCount,
  formatDuration,
  type NodeState,
  type StageView,
  statusText,
} from "@/lib/pipeline-graph/status"
import { cn } from "@/lib/utils"

/**
 * One stage of the pipeline canvas (spec §5B): an n8n-style node with the
 * phase's icon, the stage's name, its status as an icon and a word, and the
 * newest yield and duration in mono. Colour never carries a state alone
 * (DESIGN.md): ok is an ink outline with a check, failed is destructive with
 * an alert and the word, not run is dashed, not requested is hatched, running
 * is apricot (`--today`, "happening now"), and a yield drop adds its own icon
 * and "yield ↓".
 *
 * Plain React: the canvas wraps it with the graph library's handles, so the
 * library stays out of everything but the canvas.
 */

export const PHASE_ICONS: Record<Phase, LucideIcon> = {
  seed: SproutIcon,
  harvest: DownloadIcon,
  resolve: GitMergeIcon,
  enrich: SparklesIcon,
  classify: TagsIcon,
  events: CalendarDaysIcon,
  inbox: InboxIcon,
  load: UploadIcon,
  talks: MicIcon,
  report: FileTextIcon,
}

export const STATE_ICONS: Record<NodeState, LucideIcon> = {
  ok: CheckIcon,
  failed: TriangleAlertIcon,
  not_run: CircleDashedIcon,
  not_requested: BanIcon,
  running: LoaderIcon,
}

/** The node frame per state. */
const FRAME: Record<NodeState, string> = {
  ok: "border-foreground",
  failed: "border-destructive border-2",
  not_run: "border-dashed border-faint",
  not_requested: "border-border text-muted-foreground",
  running: "border-today border-2",
}

const MARK: Record<NodeState, string> = {
  ok: "text-foreground",
  failed: "text-destructive",
  not_run: "text-muted-foreground",
  not_requested: "text-muted-foreground",
  running: "text-today-text",
}

/** Diagonal hatching for "not requested", from the theme's own tokens. */
export const HATCH: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--muted) 0 6px, var(--card) 6px 12px)",
}

/** The state as an icon and a word ("failed ×2"), plus the yield flag. */
export function StageStatusMark({
  view,
  className,
}: {
  view: Pick<StageView, "state" | "failStreak" | "yieldDrop">
  className?: string
}) {
  const Icon = STATE_ICONS[view.state]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", className)}>
      <span className={cn("inline-flex items-center gap-1", MARK[view.state])}>
        <Icon
          aria-hidden="true"
          className={cn("size-3.5", view.state === "running" && "motion-safe:animate-spin")}
        />
        {statusText({ ...view, yieldDrop: false })}
      </span>
      {view.yieldDrop && (
        <span className="inline-flex items-center gap-1 text-foreground">
          <TrendingDownIcon aria-hidden="true" className="size-3.5" />
          yield ↓
        </span>
      )}
    </span>
  )
}

export function StageNodeCard({
  stage,
  view,
  selected = false,
  onOpen,
  style,
}: {
  stage: StageNode
  view: StageView
  selected?: boolean
  onOpen?: () => void
  style?: CSSProperties
}) {
  const PhaseIcon = PHASE_ICONS[stage.phase]
  const title = stageTitle(stage)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${title}: ${statusText(view)}. Open details`}
      aria-haspopup="dialog"
      className={cn(
        "flex flex-col justify-between gap-1 rounded-lg border bg-card p-2.5 text-left text-card-foreground shadow-sm transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        FRAME[view.state],
        selected && "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
      style={{ ...(view.state === "not_requested" ? HATCH : {}), ...style }}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <PhaseIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm leading-tight font-semibold">{title}</span>
          <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
            {stage.phase}
            {stage.network && (
              <>
                <span aria-hidden="true">·</span>
                <GlobeIcon aria-hidden="true" className="size-3" />
                web
              </>
            )}
            {stage.llm && (
              <>
                <span aria-hidden="true">·</span>
                <BotIcon aria-hidden="true" className="size-3" />
                LLM
              </>
            )}
          </span>
        </span>
      </span>
      <span className="flex items-center justify-between gap-2">
        <StageStatusMark view={view} className="min-w-0 truncate" />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {view.yield !== null && `${formatCount(view.yield)} · `}
          {formatDuration(view.durationMs)}
        </span>
      </span>
    </button>
  )
}

/**
 * A staging directory or a sink (a Convex route) under its stage: an icon and
 * a word say which, the name is in mono. Not interactive; the stage's sheet
 * lists every read, write and post.
 */
export function StagePortChip({ node, style }: { node: PortNode; style?: CSSProperties }) {
  const isSink = node.kind === "sink"
  const Icon = isSink ? DatabaseIcon : FolderIcon
  const kind = isSink ? "Convex" : "staging"
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-md border bg-card px-2 text-[11px] text-card-foreground",
        isSink ? "border-foreground/40" : "border-border",
      )}
      title={isSink ? node.route : `staging directory ${node.name}`}
      style={style}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{kind}</span>
      <span className="min-w-0 truncate font-mono">{node.name}</span>
    </span>
  )
}

/** The key to the node encodings, drawn the way the nodes are. */
export function StageLegend({ className }: { className?: string }) {
  const states: NodeState[] = ["ok", "failed", "not_run", "not_requested", "running"]
  return (
    <ul
      aria-label="Key"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 text-xs", className)}
    >
      {states.map((state) => (
        <li key={state} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("inline-block h-3.5 w-6 rounded-sm border bg-card", FRAME[state])}
            style={state === "not_requested" ? HATCH : undefined}
          />
          <StageStatusMark view={{ state, failStreak: 0, yieldDrop: false }} />
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <TrendingDownIcon aria-hidden="true" className="size-3.5" />
        <span className="font-medium">yield ↓</span>
        <span className="text-muted-foreground">under a quarter of the median, or none</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <FolderIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">staging</span>
        <span className="text-muted-foreground">a directory a stage writes</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <DatabaseIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Convex</span>
        <span className="text-muted-foreground">a route a stage posts to or reads</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-6 rounded-full bg-muted-foreground"
        />
        <span className="font-medium">bus</span>
        <span className="text-muted-foreground">a selector many stages read</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block w-6 border-t border-dashed border-muted-foreground"
        />
        <span className="font-medium">requires</span>
        <span className="text-muted-foreground">waits for that stage</span>
      </li>
    </ul>
  )
}
