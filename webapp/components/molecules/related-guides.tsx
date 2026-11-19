import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { useId } from "react"
import { GUIDES_PATH, type Guide } from "@/lib/guides"
import { cn } from "@/lib/utils"

/**
 * "Related guides" (lib/guide-links.ts): a few guides as ruled rows, each its
 * short name and what it covers, then "All guides". Static; the guides are
 * cached pages, so their links keep Next's default prefetch. `columns` sets
 * the rows side by side from `sm` (under a full-width page); the default is
 * one stack (a guide's aside).
 */
export function RelatedGuides({
  guides,
  title = "Related guides",
  columns = false,
  className,
}: {
  guides: readonly Guide[]
  title?: string
  columns?: boolean
  className?: string
}) {
  const headingId = useId()
  if (guides.length === 0) return null
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col", className)}>
      <h2
        id={headingId}
        className="border-t-2 border-foreground pt-3 pb-1 font-serif text-xl leading-tight"
      >
        {title}
      </h2>
      <ul className={cn("flex flex-col", columns && "sm:grid sm:grid-cols-3 sm:gap-x-8")}>
        {guides.map((entry) => (
          <li key={entry.slug} className="flex min-w-0">
            <Link
              href={entry.path}
              className="group flex min-h-12 min-w-0 flex-1 flex-col justify-center border-b py-2.5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="text-[0.9375rem] leading-snug font-semibold group-hover:text-brand-text group-hover:underline group-hover:underline-offset-[3px]">
                {entry.short}
              </span>
              <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                {entry.summary}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href={GUIDES_PATH}
        className="group mt-1 inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-brand-text focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="underline decoration-sky-line underline-offset-4 group-hover:decoration-current">
          All guides
        </span>
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </Link>
    </section>
  )
}
