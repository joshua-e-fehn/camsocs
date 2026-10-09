import {
  BadgeCheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  LockIcon,
  PencilIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { ExternalLink } from "@/components/molecules/external-link"
import {
  type KnownStatus,
  type PublicFieldMeta,
  type SourceLineModel,
  type SourceRef,
  type SourceTone,
  STATUS_DETAILS,
  sourceLine,
} from "@/lib/source-line"
import { cn } from "@/lib/utils"

/**
 * The provenance line under a public fact (PLAN §2.3): status chip, source
 * host, retrieval date, confidence — and, when sources disagree, every other
 * reading with its own source. What it says is decided in lib/source-line.ts;
 * this only draws it. Colour is never the only signal: each chip has an icon
 * and a word.
 */

const TONE: Record<SourceTone, string> = {
  positive: "bg-success text-success-foreground",
  caution: "bg-warning text-warning-foreground",
  neutral: "bg-muted text-foreground",
  muted: "border-dashed text-muted-foreground",
}

const ICON = {
  found: CircleCheckIcon,
  owner_confirmed: BadgeCheckIcon,
  inferred: CircleHelpIcon,
  manual: PencilIcon,
  conflicting: TriangleAlertIcon,
} as const

/** The status chip: icon, word and a tone — never colour alone. */
export function StatusChip({ status, className }: { status: KnownStatus; className?: string }) {
  const Icon = ICON[status]
  const details = STATUS_DETAILS[status]
  return (
    <span
      title={details.description}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-px font-sans text-xs font-medium",
        TONE[details.tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {details.label}
      <span className="sr-only">: {details.description}</span>
    </span>
  )
}

function Source({ source }: { source: SourceRef }) {
  if (source.kind === "private") {
    return (
      <span className="inline-flex items-center gap-1">
        <LockIcon aria-hidden className="size-3" />
        private source
      </span>
    )
  }
  return (
    <ExternalLink href={source.url} className="text-foreground/80">
      <span className="sr-only">Source: </span>
      {source.host}
    </ExternalLink>
  )
}

export function SourceLine({
  meta,
  className,
}: {
  meta: PublicFieldMeta | undefined
  className?: string
}) {
  const model: SourceLineModel = sourceLine(meta)
  if (model.kind === "hidden") return null

  if (model.kind === "missing") {
    return (
      <p
        className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}
        title={model.detail}
      >
        <CircleDashedIcon aria-hidden className="size-3.5" />
        <span>{model.label}</span>
        <span className="sr-only">: {model.detail}</span>
      </p>
    )
  }

  // Parts are spaced, not separated: a wrapped line never starts with a "/".
  return (
    <div className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusChip status={model.status} />
        <span className="font-mono">
          <Source source={model.source} />
        </span>
        {model.retrievedOn && (
          <span className="font-mono whitespace-nowrap">
            <span className="sr-only">retrieved </span>
            {model.retrievedOn}
          </span>
        )}
        {model.confidence !== undefined && (
          <span
            className="font-mono whitespace-nowrap"
            title="Confidence, computed by rule from how the value was read"
          >
            {model.confidence}%<span className="sr-only"> confidence</span>
          </span>
        )}
        {model.agreeing !== undefined && (
          <span className="whitespace-nowrap" title="Independent sources that give the same value">
            {model.agreeing} sources agree
          </span>
        )}
      </p>
      {model.conflicts.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-warning pl-2">
          {model.conflicts.map((reading) => (
            <li
              key={`${reading.value}|${reading.source.kind === "link" ? reading.source.url : "private"}|${reading.retrievedOn}`}
              className="flex flex-wrap items-center gap-x-2"
            >
              <span>Also reported:</span>
              <span className="font-medium wrap-anywhere text-foreground">{reading.value}</span>
              <span className="font-mono">
                <Source source={reading.source} />
              </span>
              {reading.retrievedOn && (
                <span className="font-mono whitespace-nowrap">{reading.retrievedOn}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
