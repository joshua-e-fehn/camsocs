import { cn } from "@/lib/utils"

/**
 * The camsocs wordmark — text and a neutral glyph only. Deliberately no crest,
 * arms or "University of Cambridge" styling: the project is unofficial
 * (AGENTS.md, landscape brief §5.5).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <span
        aria-hidden
        className="grid size-6 grid-cols-2 gap-0.5 rounded-md bg-primary p-1 [&>span]:rounded-[2px] [&>span]:bg-primary-foreground"
      >
        <span />
        <span className="opacity-60" />
        <span className="opacity-60" />
        <span />
      </span>
      camsocs
    </span>
  )
}
