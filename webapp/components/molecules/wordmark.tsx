import { RiverGlyph } from "@/components/molecules/river-line"
import { cn } from "@/lib/utils"

/**
 * The camsocs wordmark: "camsocs" in Newsreader italic with a short bend of
 * the river in sage. Text and our own glyph only — deliberately no crest,
 * arms, shield or "University of Cambridge" styling: the project is
 * unofficial (AGENTS.md, spec §1).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-serif text-[1.4rem] leading-none font-medium tracking-[-0.01em] italic",
        className,
      )}
    >
      <RiverGlyph className="translate-y-[-0.05em] text-primary" />
      camsocs
    </span>
  )
}
