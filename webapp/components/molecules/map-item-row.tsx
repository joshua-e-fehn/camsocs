import { ArrowUpRightIcon, LocateFixedIcon, MapPinIcon, VideoIcon } from "lucide-react"
import Link from "next/link"
import { formatDayShort, formatEventTime, londonIsoDate } from "@/lib/calendar"
import { linkProps } from "@/lib/crawl-traps"
import { type MapStatus, STATUS_LABELS } from "@/lib/map-day"
import type { MapItem } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { EVENT_TYPE_LABELS, TALK_KIND_LABELS } from "@/lib/vocab"

/**
 * One row of the map's list (docs/locations-and-map.md §0.6): when, what
 * (a link to its page), where, who, and its state in words ("Now", "Ended",
 * "Cancelled") beside the colour. Rows at a pin can be shown on the map
 * ("Show on map", which the caller pans to) and carry a Directions link to
 * the venue in the visitor's maps app. The open row (its pin was clicked, or
 * "Show on map") is ruled in ink and shows the venue's address.
 *
 * Hover and focus inside the row call `onPoint`, so the caller can raise the
 * row's pin.
 */
export function MapItemRow({
  item,
  day,
  status,
  open,
  pointed,
  address,
  directions,
  pinCount,
  onShow,
  onPoint,
  onOpenPage,
}: {
  item: MapItem
  /** The London date the map shows (a multi-day item started before it says so). */
  day: string
  status: MapStatus
  /** Its pin was clicked or "Show on map" chosen. */
  open: boolean
  /** Its pin is hovered or focused. */
  pointed: boolean
  /** The venue's address, shown on the open row. */
  address?: string
  /** A Directions link to the venue (lib/maps-link.ts), when it has one. */
  directions?: string
  /** How many items share its pin, from 2 (drawn beside "Show on map"). */
  pinCount?: number
  /** "Show on map"; absent for an item with no pin. */
  onShow?: () => void
  onPoint: (pointing: boolean) => void
  /** The row's link to its page was followed. */
  onOpenPage: () => void
}) {
  const startDay = londonIsoDate(item.startsAt)
  const time = item.allDay
    ? "All day"
    : startDay < day
      ? `From ${formatDayShort(startDay)}`
      : formatEventTime({
          startsAt: item.startsAt,
          endsAt: item.endsAt ?? undefined,
          allDay: false,
        }).replace(/ – .*$/, "")
  const kindLabel =
    item.kind === "talk"
      ? item.talkKind
        ? TALK_KIND_LABELS[item.talkKind]
        : "Talk"
      : item.eventType
        ? EVENT_TYPE_LABELS[item.eventType]
        : "Event"
  const statusLabel = item.cancelled ? "Cancelled" : STATUS_LABELS[status]
  const place =
    item.precision === "online"
      ? item.placeLabel || "Online"
      : item.precision === "unknown" && !item.venueKey
        ? item.placeLabel
          ? `${item.placeLabel} (to be confirmed)`
          : "Location to be confirmed"
        : item.placeLabel || "Location to be confirmed"
  const PlaceIcon = item.precision === "online" ? VideoIcon : MapPinIcon

  return (
    <article
      id={`map-row-${item.kind}-${item.key}`}
      aria-labelledby={`map-title-${item.kind}-${item.key}`}
      onMouseEnter={() => onPoint(true)}
      onMouseLeave={() => onPoint(false)}
      onFocus={() => onPoint(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPoint(false)
      }}
      className={cn(
        "relative grid scroll-mt-4 grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 border-l-2 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none sm:px-5",
        open
          ? "border-l-foreground bg-muted"
          : pointed
            ? "border-l-brand bg-muted/60"
            : "border-l-transparent",
        status === "past" && !open && "text-muted-foreground",
      )}
    >
      <p className="pt-0.5 font-mono text-[0.75rem] leading-snug tabular-nums">{time}</p>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.625rem] font-medium tracking-[0.12em] uppercase">
          <span className={cn(item.kind === "talk" ? "text-foreground" : "text-events")}>
            <span
              aria-hidden
              className={cn(
                "mr-1.5 inline-block size-2 align-[1px]",
                item.kind === "talk" ? "rounded-[2px] bg-foreground" : "rounded-full bg-brand",
                status === "past" && "bg-input",
              )}
            />
            {kindLabel}
          </span>
          {statusLabel && (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 tracking-[0.08em]",
                item.cancelled
                  ? "bg-destructive/10 text-destructive"
                  : status === "now"
                    ? "bg-today/20 text-today-text ring-1 ring-today"
                    : "bg-secondary text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
          )}
          {item.visibility === "cam_only" && (
            <span className="text-muted-foreground">Cambridge only</span>
          )}
        </p>
        <h3
          id={`map-title-${item.kind}-${item.key}`}
          className={cn(
            "text-[0.9375rem] leading-snug font-medium text-pretty",
            item.cancelled && "line-through decoration-1",
          )}
        >
          <Link
            {...linkProps(item.href)}
            onClick={onOpenPage}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {item.title}
          </Link>
        </h3>
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <PlaceIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">
            {place}
            {open && address && <span className="block text-xs">{address}</span>}
          </span>
        </p>
        {item.orgLabel && <p className="truncate text-xs text-muted-foreground">{item.orgLabel}</p>}
        {(onShow || directions) && (
          <div className="-ml-2 flex flex-wrap items-center gap-x-1">
            {onShow && (
              <button
                type="button"
                onClick={onShow}
                aria-pressed={open}
                className="inline-flex h-11 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring sm:h-8"
              >
                <LocateFixedIcon aria-hidden className="size-3.5" />
                Show on map
                {pinCount && pinCount > 1 && (
                  <span className="font-mono text-muted-foreground tabular-nums">
                    · {pinCount} here
                  </span>
                )}
              </button>
            )}
            {directions && (
              <a
                href={directions}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-brand-text transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring sm:h-8"
              >
                Directions
                <ArrowUpRightIcon aria-hidden className="size-3.5" />
                <span className="sr-only">(opens your maps app)</span>
              </a>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
