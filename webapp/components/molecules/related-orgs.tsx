import Link from "next/link"
import { placementOf } from "@/components/molecules/org-card"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import type { OrgRelated } from "@/lib/public-api"
import { CATEGORY_LABELS } from "@/lib/vocab"

/** Related societies on a profile: small rows (tile, name, category and
 * place), two columns from `sm` up. */
export function RelatedOrgs({
  orgs,
  collegeNames,
}: {
  orgs: OrgRelated
  collegeNames: Record<string, string>
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {orgs.map((card) => (
        <li key={card.key} className="min-w-0">
          <Link
            href={`/societies/${card.slug}`}
            className="group flex items-center gap-3 rounded-xl border bg-card p-2.5 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <OrgMonogram
              name={card.name}
              shortName={card.shortName}
              url={card.logoUrl}
              categories={card.categories}
              college={card.collegeKeys.length > 0}
              size={40}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium group-hover:underline group-hover:underline-offset-4">
                {card.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {[
                  card.categories[0] && CATEGORY_LABELS[card.categories[0]],
                  placementOf(card, collegeNames),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
