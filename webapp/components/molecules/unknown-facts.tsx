import { ChevronDownIcon, CircleDashedIcon } from "lucide-react"
import Link from "next/link"
import { type PublicFieldMeta, sourceLine } from "@/lib/source-line"
import { cn } from "@/lib/utils"

export type UnknownFact = { label: string; meta: PublicFieldMeta | undefined }

/** How many labels the closed line names before "+N more". */
const NAMED = 3

/**
 * The facts of a section nobody publishes, folded into one line — "Not yet
 * known: Beginner-friendly, Languages, Termcard +2" — that opens to each
 * fact's reason (not published, not public, source unreachable, not checked
 * yet) and the way to supply it. Unknown is still shown as unknown (PLAN
 * §2.3), once per section instead of once per row. A `<details>`: no script,
 * keyboard-operable, closed by default.
 */
export function UnknownFacts({
  facts,
  correctHref,
  className,
}: {
  facts: UnknownFact[]
  /** The request form, preset to correct this listing. */
  correctHref: string
  className?: string
}) {
  if (facts.length === 0) return null
  const named = facts.slice(0, NAMED).map((fact) => fact.label)
  const more = facts.length - named.length

  return (
    <details className={cn("group rounded-lg border border-dashed text-sm", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <CircleDashedIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Not yet known:</span> {named.join(", ")}
          {more > 0 && ` +${more} more`}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-3 border-t border-dashed px-3 py-3">
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {facts.map((fact) => {
            const model = sourceLine(fact.meta)
            const reason =
              model.kind === "missing"
                ? model
                : { label: "Not published yet", detail: "No public source gives this." }
            return (
              <li key={fact.label} className="flex flex-wrap items-baseline gap-x-2">
                <span>{fact.label}</span>
                <span className="text-xs text-muted-foreground" title={reason.detail}>
                  {reason.label.toLowerCase()}
                  <span className="sr-only">: {reason.detail}</span>
                </span>
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          We only show what a public source states.{" "}
          <Link href={correctHref} className="text-foreground underline underline-offset-4">
            Know any of these? Tell us
          </Link>
          .
        </p>
      </div>
    </details>
  )
}
