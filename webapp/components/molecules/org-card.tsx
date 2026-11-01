import { ChevronRightIcon } from "lucide-react"
import Link from "next/link"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { TermDateBlock, termWeekShort } from "@/components/molecules/term-date-block"
import { formatInstantDate, londonIsoDate, weekdayShort } from "@/lib/calendar"
import type { OrgCard as OrgCardData } from "@/lib/public-api"
import { plainLine } from "@/lib/rich-text"
import { cn } from "@/lib/utils"
import {
  type BlueStatus,
  CATEGORY_LABELS,
  type Category,
  ORG_LEVEL_LABELS,
  ORG_STATUS_LABELS,
  ORG_TYPE_LABELS,
  type OrgStatus,
} from "@/lib/vocab"

/** The logo-or-monogram tile under its older name (the profile and other
 * pages used `OrgLogo`); see `OrgMonogram`. */
export function OrgLogo({
  category,
  ...props
}: Omit<React.ComponentProps<typeof OrgMonogram>, "categories"> & { category?: Category }) {
  return <OrgMonogram categories={category} {...props} />
}

const STATUS_DOT: Record<OrgStatus, string> = {
  active: "bg-primary",
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

/** Blues worth a badge on a card: a Full or Half Blue, not "No Blue". */
const BLUE_BADGES: Partial<Record<BlueStatus, string>> = {
  full: "Full Blue",
  full_some: "Full Blue",
  discretionary_full: "Full Blue",
  half: "Half Blue",
}

/** Where a listing sits: its colleges, else its level or type. */
export function placementOf(
  card: Pick<OrgCardData, "collegeKeys" | "level" | "orgType">,
  collegeNames: Record<string, string>,
): string | undefined {
  const colleges = card.collegeKeys.map((key) => collegeNames[key]).filter(Boolean)
  if (colleges.length > 0) return colleges.join(", ")
  if (card.level) return ORG_LEVEL_LABELS[card.level]
  return card.orgType ? ORG_TYPE_LABELS[card.orgType] : undefined
}

/** "4 events this term" / "1 event in the next 8 weeks" / undefined. */
export function activityText(activity: OrgCardData["activity"]): string | undefined {
  if (!activity || activity.count === 0) return undefined
  const events = `${activity.count} ${activity.count === 1 ? "event" : "events"}`
  return activity.inTerm ? `${events} this term` : `${events} in the next 8 weeks`
}

/** "Thu 5 Nov, Wk 4": the next event, in words, for screen readers. */
function nextEventWords(next: NonNullable<OrgCardData["activity"]>["next"]): string | undefined {
  if (!next) return undefined
  const week = termWeekShort(next.termWeekLabel)
  const day = `${weekdayShort(londonIsoDate(next.startsAt))} ${formatInstantDate(next.startsAt)}`
  return `Next event ${day}${week ? `, ${week}` : ""}`
}

/**
 * A directory entry. On a phone it is a dense row (tile, name, one meta line,
 * one line of description, the next event's date chip); from `sm` up it is a
 * card in a two-column grid. The whole entry is one link. The meta line says
 * what it is, where it sits and how busy it is this term; a Blue and the
 * college ride along as badges. A listing without a description just ends
 * sooner (the profile says what is unknown).
 */
export function OrgCard({
  card,
  collegeNames,
  className,
}: {
  card: OrgCardData
  collegeNames: Record<string, string>
  className?: string
}) {
  const placement = placementOf(card, collegeNames)
  const blue = card.sport?.blueStatus ? BLUE_BADGES[card.sport.blueStatus] : undefined
  const busy = activityText(card.activity)
  const next = card.activity?.next
  const meta = [
    card.categories[0] ? CATEGORY_LABELS[card.categories[0]] : undefined,
    placement,
    busy,
    card.status === "dormant" || card.status === "archived"
      ? ORG_STATUS_LABELS[card.status]
      : undefined,
  ].filter(Boolean)

  return (
    <Link
      href={`/societies/${card.slug}`}
      className={cn(
        "group flex h-full items-start gap-3 py-3 text-card-foreground outline-none transition-colors duration-150 focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "sm:gap-4 sm:rounded-xl sm:border sm:bg-card sm:p-4 sm:hover:border-primary/40 sm:hover:shadow-xs",
        className,
      )}
    >
      <OrgMonogram
        name={card.name}
        shortName={card.shortName}
        url={card.logoUrl}
        categories={card.categories}
        college={card.collegeKeys.length > 0}
        size={48}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="leading-snug font-semibold tracking-tight text-pretty group-hover:underline group-hover:decoration-primary/50 group-hover:underline-offset-4">
            {card.name}
          </h3>
          {blue && (
            <span className="rounded-sm bg-talks-tint px-1.5 text-[11px] leading-5 font-medium text-talks">
              {blue}
            </span>
          )}
        </div>
        {meta.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</p>
        )}
        {card.shortDescription && (
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground sm:line-clamp-2">
            {plainLine(card.shortDescription)}
          </p>
        )}
      </div>
      {next ? (
        <TermDateBlock
          startsAt={next.startsAt}
          termWeekLabel={next.termWeekLabel}
          size="sm"
          label={nextEventWords(next)}
          className="mt-0.5"
        />
      ) : (
        <ChevronRightIcon
          aria-hidden
          className="mt-3 size-4 shrink-0 text-muted-foreground/60 sm:hidden"
        />
      )}
    </Link>
  )
}
