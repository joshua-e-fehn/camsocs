import { CheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { humanize } from "@/lib/broker/format"
import type { NeedOfferItem } from "@/lib/vocab"

type Entry = { item: NeedOfferItem; status: "inferred" | "confirmed" | "rejected" }

/**
 * Needs and offers as compact chips. Confirmed ones carry a check (never
 * colour alone); inferred ones are outlined; rejected ones are not shown.
 */
export function NeedOfferChips({
  needs,
  offers,
  max = 4,
}: {
  needs: readonly Entry[]
  offers: readonly Entry[]
  max?: number
}) {
  const chips = [
    ...needs.filter((e) => e.status !== "rejected").map((e) => ({ ...e, kind: "needs" as const })),
    ...offers
      .filter((e) => e.status !== "rejected")
      .map((e) => ({ ...e, kind: "offers" as const })),
  ]
  if (chips.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {chips.slice(0, max).map((chip) => (
        <Badge
          key={`${chip.kind}-${chip.item}`}
          variant={chip.status === "confirmed" ? "secondary" : "outline"}
          title={`${chip.kind === "needs" ? "Needs" : "Offers"} ${humanize(chip.item).toLowerCase()} (${chip.status})`}
        >
          {chip.status === "confirmed" && <CheckIcon />}
          <span className="text-muted-foreground">
            {chip.kind === "needs" ? "needs" : "offers"}
          </span>
          {humanize(chip.item).toLowerCase()}
        </Badge>
      ))}
      {chips.length > max && (
        <Badge variant="ghost" className="text-muted-foreground">
          +{chips.length - max}
        </Badge>
      )}
    </div>
  )
}
