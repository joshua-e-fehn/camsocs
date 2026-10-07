import { SourceLine } from "@/components/molecules/source-line"
import { hasValue, type PublicFieldMeta } from "@/lib/source-line"
import { cn } from "@/lib/utils"

/**
 * One fact on a public page: a label, its value and the SourceLine beneath.
 * Render inside a `<dl>`. A field that does not apply (`not_applicable`) is
 * left out entirely; a missing one keeps its row and says so — unknown is
 * shown as unknown, never as an empty space.
 */
export function Fact({
  label,
  meta,
  children,
  className,
}: {
  label: string
  meta: PublicFieldMeta | undefined
  children?: React.ReactNode
  className?: string
}) {
  if (meta?.status === "not_applicable") return null
  const known = hasValue(meta)

  return (
    <div className={cn("grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4", className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1.5">
        {known && children !== undefined && children !== null && children !== false && (
          <div className="text-sm leading-relaxed">{children}</div>
        )}
        <SourceLine meta={meta} />
      </dd>
    </div>
  )
}
