import Image from "next/image"
import { type CategoryTone, categoryTone } from "@/lib/category-tone"
import { monogram } from "@/lib/monogram"
import { cn } from "@/lib/utils"
import type { Category } from "@/lib/vocab"

/**
 * Tint and ink per category family (lib/category-tone.ts), from the design
 * tokens only: the pillar tints as they are, and mixes of two of them for
 * teal and plum. Gilt is decoration, never text, so its ink is the
 * foreground.
 */
export const TONE_CLASSES: Record<CategoryTone, string> = {
  sage: "bg-accent text-primary",
  teal: "bg-[color-mix(in_oklab,var(--accent)_55%,var(--talks-tint))] text-[color-mix(in_oklch,var(--primary)_60%,var(--talks))]",
  indigo: "bg-talks-tint text-talks",
  plum: "bg-[color-mix(in_oklab,var(--events-tint)_50%,var(--talks-tint))] text-[color-mix(in_oklch,var(--events)_50%,var(--talks))]",
  brick: "bg-events-tint text-events",
  gilt: "bg-[color-mix(in_oklab,var(--gilt)_22%,var(--card))] text-foreground",
  neutral: "bg-muted text-foreground/80",
}

/**
 * An organisation's tile: its own logo (our stored copy) on a neutral paper
 * tile — never forced white, so a logo with its own dark ground reads as a
 * framed mark, not a black square — or, for the ~92% without one, its
 * initials (lib/monogram.ts) set in the serif on its category's tint. A
 * college society carries a thin gilt stripe along the foot. Decorative: the
 * name is always next to it.
 */
export function OrgMonogram({
  name,
  shortName,
  url,
  categories,
  college = false,
  size = 48,
  className,
}: {
  name: string
  shortName?: string
  url?: string
  categories?: readonly Category[] | Category
  /** A college society: the stripe. */
  college?: boolean
  size?: number
  className?: string
}) {
  const initials = monogram(name, shortName)
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[22%] ring-1 ring-foreground/5 ring-inset",
        url
          ? "bg-muted dark:bg-[color-mix(in_oklab,var(--foreground)_86%,var(--muted))]"
          : TONE_CLASSES[categoryTone(categories)],
        className,
      )}
      style={{ width: size, height: size }}
    >
      {url ? (
        <Image
          src={url}
          alt=""
          width={size}
          height={size}
          sizes={`${size}px`}
          className="size-full object-contain p-[12%]"
        />
      ) : (
        <span
          className="font-serif leading-none font-medium tracking-tight"
          style={{ fontSize: Math.round(size * (initials.length > 2 ? 0.32 : 0.42)) }}
        >
          {initials}
        </span>
      )}
      {college && (
        <span
          className="absolute inset-x-0 bottom-0 bg-gilt"
          style={{ height: Math.max(3, Math.round(size * 0.08)) }}
        />
      )}
    </div>
  )
}
