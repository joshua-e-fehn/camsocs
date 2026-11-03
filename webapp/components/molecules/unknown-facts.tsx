import { ChevronDownIcon, CircleDashedIcon } from "lucide-react"
import Link from "next/link"
import { requestLinkRel } from "@/lib/request-link"
import { type PublicFieldMeta, sourceLine } from "@/lib/source-line"
import { cn } from "@/lib/utils"

export type UnknownFact = { label: string; meta: PublicFieldMeta | undefined }

/** The facts grouped by why they are unknown, in first-seen order. */
function byReason(facts: UnknownFact[]): { label: string; detail: string; labels: string[] }[] {
  const groups = new Map<string, { label: string; detail: string; labels: string[] }>()
  for (const fact of facts) {
    const model = sourceLine(fact.meta)
    const reason =
      model.kind === "missing"
        ? model
        : { label: "Not published yet", detail: "No public source gives this." }
    const group = groups.get(reason.label) ?? { ...reason, labels: [] }
    group.labels.push(fact.label)
    groups.set(reason.label, group)
  }
  return [...groups.values()]
}

/** How many labels the closed line names before "+N more". */
const NAMED = 3

/**
 * The facts of a section nobody publishes, folded into one line — "Not yet
 * known: Beginner-friendly, Languages, Termcard +2" — that opens to the
 * facts grouped by reason (not published, not public, source unreachable,
 * not checked yet) and the way to supply it. Unknown is still shown as unknown (PLAN
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
        <span data-nosnippet className="min-w-0 flex-1">
          <span className="font-medium">Not yet known:</span> {named.join(", ")}
          {more > 0 && ` +${more} more`}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
        />
      </summary>
      {/* The facts by reason, names only: the explanation is said once per
          reason, not once per fact, so on a thin page this is not most of
          the text; data-nosnippet keeps it out of search snippets (SEO audit
          2026-11-02, profile-unknown-boilerplate). */}
      <div data-nosnippet className="flex flex-col gap-3 border-t border-dashed px-3 py-3">
        <dl className="flex flex-col gap-1.5">
          {byReason(facts).map((group) => (
            <div key={group.label} className="flex flex-wrap gap-x-2">
              <dt className="text-xs text-muted-foreground" title={group.detail}>
                {group.label}:<span className="sr-only"> {group.detail}</span>
              </dt>
              <dd>{group.labels.join(", ")}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          We only show what a public source states.{" "}
          <Link
            href={correctHref}
            rel={requestLinkRel(correctHref)}
            className="text-foreground underline underline-offset-4"
          >
            Know any of these? Tell us
          </Link>
          .
        </p>
      </div>
    </details>
  )
}
