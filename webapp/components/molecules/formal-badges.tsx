import { AwardIcon, CircleDashedIcon } from "lucide-react"
import type { BadgeProgress } from "@/lib/formal-ranks"
import { cn } from "@/lib/utils"

/** The tracker's badges with how far along each is: earned ones in teal
 * with "Earned", the rest "n of m". */
export function FormalBadges({ progress }: { progress: readonly BadgeProgress[] }) {
  return (
    <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
      {progress.map(({ badge, have, total, earned }) => (
        <li key={badge.id} className="flex items-start gap-3 border-t py-3">
          {earned ? (
            <AwardIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-text" />
          ) : (
            <CircleDashedIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-faint" />
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{badge.title}</span>
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  earned ? "text-brand-text" : "text-muted-foreground",
                )}
              >
                {earned ? "Earned" : `${have} of ${total}`}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">{badge.description}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
