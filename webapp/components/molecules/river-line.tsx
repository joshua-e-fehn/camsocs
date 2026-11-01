import { cn } from "@/lib/utils"

/**
 * The Cam as a line: one meandering stroke in `--backs`, the site's recurring
 * motif (spec §5 "Motifs") — under the hero, between sections, above the
 * footer. Pure decoration (`aria-hidden`), never a shield or heritage shape.
 *
 * It stretches to any width while the stroke keeps its weight
 * (`non-scaling-stroke`). With motion allowed it draws itself once, by CSS
 * alone; the path is complete in the server HTML whatever happens.
 */

const PATHS = {
  // A full meander: two big bends and a backwater.
  river:
    "M0 26 C 90 8, 170 40, 280 26 S 460 6, 560 18 S 700 40, 800 30 S 960 4, 1060 16 S 1160 30, 1200 22",
  // Flatter, for a divider between sections.
  divider: "M0 20 C 150 14, 250 26, 400 20 S 650 13, 800 20 S 1050 27, 1200 20",
} as const

export function RiverLine({
  variant = "river",
  className,
  strokeClassName = "stroke-backs",
  draw = true,
}: {
  variant?: keyof typeof PATHS
  className?: string
  /** A `stroke-*` utility; the default is the decorative `--backs`. */
  strokeClassName?: string
  /** Draw in once (only under `prefers-reduced-motion: no-preference`). */
  draw?: boolean
}) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 1200 40"
      preserveAspectRatio="none"
      className={cn(
        "block h-6 w-full overflow-visible sm:h-8",
        draw && "motion-safe:animate-[river-draw_2.4s_cubic-bezier(0.33,1,0.68,1)_both]",
        className,
      )}
    >
      <path
        d={PATHS[variant]}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className={strokeClassName}
      />
    </svg>
  )
}

/** The wordmark's glyph: a short bend of the river, 20 × 12. */
export function RiverGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 20 12"
      className={cn("h-3 w-5 shrink-0 overflow-visible", className)}
    >
      <path
        d="M1 8.5 C 4 2, 7 2, 10 6 S 16 10.5, 19 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  )
}
