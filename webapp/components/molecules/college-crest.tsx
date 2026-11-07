import type { CollegeCrest as Crest } from "@/lib/colleges"
import { cn } from "@/lib/utils"

/**
 * A college's crest (lib/colleges.ts): a small static WebP, sized by height so
 * the shields of different shapes line up. Decorative where the college's
 * name sits beside it (`decorative`), else it carries the alt text.
 */
export function CollegeCrest({
  crest,
  size = 48,
  decorative = false,
  className,
}: {
  crest: Crest
  size?: number
  decorative?: boolean
  className?: string
}) {
  return (
    // biome-ignore lint/performance/noImgElement: a tiny static file in public/, no optimiser needed
    <img
      src={crest.src}
      alt={decorative ? "" : crest.alt}
      height={size}
      width={Math.round(size * 0.85)}
      loading="lazy"
      decoding="async"
      className={cn("shrink-0 object-contain", className)}
      style={{ height: size, width: "auto" }}
    />
  )
}
