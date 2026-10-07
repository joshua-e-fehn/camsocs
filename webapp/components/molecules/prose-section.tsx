import { cn } from "@/lib/utils"

/**
 * A titled block of running text for the About and Privacy pages: readable
 * measure, spaced paragraphs and lists, links underlined. Anchored by `id` so
 * other pages can link to a section (`/about#data`).
 */
export function ProseSection({
  id,
  title,
  children,
  className,
}: {
  id: string
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex scroll-mt-20 flex-col gap-3 text-sm leading-relaxed text-muted-foreground",
        "[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-medium [&_strong]:text-foreground",
        "[&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5",
        "[&_h3]:pt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground",
        className,
      )}
    >
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}
