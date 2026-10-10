import Image from "next/image"
import Link from "next/link"
import { CATEGORY_ICONS } from "@/components/molecules/category-icon"
import { Badge } from "@/components/ui/badge"
import { monogram } from "@/lib/monogram"
import type { OrgCard as OrgCardData } from "@/lib/public-api"
import { plainLine } from "@/lib/rich-text"
import { cn } from "@/lib/utils"
import {
  CATEGORY_LABELS,
  type Category,
  ORG_LEVEL_LABELS,
  ORG_STATUS_LABELS,
  ORG_TYPE_LABELS,
  type OrgStatus,
} from "@/lib/vocab"

/**
 * The organisation's own logo (our stored copy), or — for the ~92% without
 * one — its initials (lib/monogram.ts) with the icon of its first category in
 * the corner, so a grid of fallbacks still reads at a glance. Decorative: the
 * name is always next to it.
 */
export function OrgLogo({
  name,
  shortName,
  url,
  category,
  size = 48,
  className,
}: {
  name: string
  shortName?: string
  url?: string
  /** The first category, for the fallback's corner icon. */
  category?: Category
  size?: number
  className?: string
}) {
  const Icon = category ? CATEGORY_ICONS[category] : undefined
  const initials = monogram(name, shortName)
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border",
        url ? "bg-white" : "bg-linear-to-br from-muted to-background text-foreground/75",
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
          className="size-full object-contain p-1"
        />
      ) : (
        <>
          <span
            className="font-semibold tracking-tight"
            style={{ fontSize: Math.round(size * (initials.length > 2 ? 0.28 : 0.36)) }}
          >
            {initials}
          </span>
          {Icon && (
            <Icon
              className="absolute right-[7%] bottom-[7%] text-muted-foreground"
              style={{ width: Math.round(size * 0.28), height: Math.round(size * 0.28) }}
              strokeWidth={1.75}
            />
          )}
        </>
      )}
    </div>
  )
}

const STATUS_DOT: Record<OrgStatus, string> = {
  active: "bg-success-foreground",
  dormant: "bg-muted-foreground/60",
  archived: "bg-muted-foreground/30",
  unknown: "border border-muted-foreground/50",
}

/** Active / dormant / archived / unknown, as a dot and a word. */
export function OrgStatusLabel({ status, className }: { status: OrgStatus; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {ORG_STATUS_LABELS[status]}
    </span>
  )
}

/** A directory entry: logo, name, short description, level or college,
 * categories and activity status. The whole card is one link. A card without
 * a short description just ends sooner (the profile says what is unknown). */
export function OrgCard({
  card,
  collegeNames,
}: {
  card: OrgCardData
  collegeNames: Record<string, string>
}) {
  const colleges = card.collegeKeys.map((key) => collegeNames[key]).filter(Boolean)
  const placement =
    colleges.length > 0
      ? colleges.join(", ")
      : card.level
        ? ORG_LEVEL_LABELS[card.level]
        : card.orgType
          ? ORG_TYPE_LABELS[card.orgType]
          : undefined

  return (
    <Link
      href={`/societies/${card.slug}`}
      className="group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors duration-200 hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start gap-3">
        <OrgLogo
          name={card.name}
          shortName={card.shortName}
          url={card.logoUrl}
          category={card.categories[0]}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="font-semibold leading-snug tracking-tight group-hover:underline group-hover:underline-offset-4">
            {card.name}
          </h3>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {placement && <span className="text-xs text-muted-foreground">{placement}</span>}
            <OrgStatusLabel status={card.status} />
          </div>
        </div>
      </div>
      {card.shortDescription && (
        <p className="line-clamp-3 text-sm text-muted-foreground">
          {plainLine(card.shortDescription)}
        </p>
      )}
      {card.categories.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1">
          {card.categories.slice(0, 3).map((category) => (
            <Badge key={category} variant="secondary" className="font-normal">
              {CATEGORY_LABELS[category]}
            </Badge>
          ))}
          {card.categories.length > 3 && (
            <Badge variant="outline" className="font-normal">
              +{card.categories.length - 3}
            </Badge>
          )}
        </div>
      )}
    </Link>
  )
}
