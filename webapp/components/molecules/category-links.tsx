import Link from "next/link"
import { CATEGORY_ICONS } from "@/components/molecules/category-icon"
import { TONE_CLASSES } from "@/components/molecules/org-monogram"
import { CATEGORY_TONE } from "@/lib/category-tone"
import { categoryHubPath } from "@/lib/directory-hubs"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/vocab"

/**
 * The category hubs as tiles with their icon and count: the `/categories`
 * index and the "Other categories" list under a hub. Plain links to the hub
 * pages (no in-place filtering), so every hub is one crawlable hop from the
 * next.
 */
export function CategoryLinks({
  counts,
  current,
}: {
  /** Listings per category; a category without any is left out. */
  counts?: Record<string, number>
  /** The hub this list sits on, left out of it. */
  current?: Category
}) {
  const categories = CATEGORIES.filter(
    (category) => category !== current && (counts === undefined || (counts[category] ?? 0) > 0),
  )
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {categories.map((category) => {
        const Icon = CATEGORY_ICONS[category]
        return (
          <li key={category}>
            <Link
              href={categoryHubPath(category)}
              className="group grid h-full min-h-14 grid-cols-[auto_1fr_auto] items-center gap-x-3 rounded-xl border bg-card p-2.5 pr-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  TONE_CLASSES[CATEGORY_TONE[category]],
                )}
              >
                <Icon className="size-4.5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 text-sm leading-tight font-medium text-pretty">
                {CATEGORY_LABELS[category]}
              </span>
              {counts && (
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {counts[category]}
                </span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
