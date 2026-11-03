import Link from "next/link"
import type { HubCard } from "@/lib/directory-hubs"
import { ORG_LEVEL_LABELS, ORG_TYPE_LABELS, type OrgLevel } from "@/lib/vocab"

export type HubListCard = HubCard & { sport?: { sport?: string } }

/** A listing's second line on a hub: its college or level, its kind and sport. */
function hubMeta(card: HubListCard, collegeNames: Record<string, string>): string {
  const colleges = card.collegeKeys.map((key) => collegeNames[key]).filter(Boolean)
  const place =
    colleges.length > 0
      ? colleges.join(", ")
      : card.level
        ? ORG_LEVEL_LABELS[card.level as OrgLevel]
        : undefined
  const kind = card.orgType ? ORG_TYPE_LABELS[card.orgType] : undefined
  return [place, kind, card.sport?.sport].filter(Boolean).join(" · ")
}

/**
 * A hub's listings as plain links in two or three columns: name, then where
 * and what it is. Server-rendered and light on purpose (no logos, no
 * activity), because a hub lists every member on one page for readers and
 * crawlers alike (SEO audit 2026-11-02, no-category-college-hubs).
 */
export function HubList({
  cards,
  collegeNames,
}: {
  cards: readonly HubListCard[]
  collegeNames: Record<string, string>
}) {
  return (
    <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => {
        const meta = hubMeta(card, collegeNames)
        return (
          <li key={card.key} className="min-w-0 border-b py-2.5">
            {/* No viewport prefetch: a sport or college hub lists hundreds,
                and each prefetch is a server render (Fluid CPU; robots.ts). */}
            <Link
              href={`/societies/${card.slug}`}
              prefetch={false}
              className="flex min-h-11 flex-col justify-center underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-0"
            >
              <span className="font-medium text-pretty">{card.name}</span>
              {meta && <span className="text-sm text-muted-foreground">{meta}</span>}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
