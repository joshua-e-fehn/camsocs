import { BanIcon, MapPinIcon, VideoIcon } from "lucide-react"
import {
  physicalVenue,
  SCHOOL_TONE,
  speakerLine,
  type TalkListItem,
  talkTimes,
  talkTiming,
} from "@/lib/talks"
import { cn } from "@/lib/utils"
import { TALK_KIND_LABELS } from "@/lib/vocab"

/**
 * One talk in a day-grouped agenda (talks-redesign-spec §6): a time column
 * (start over end, tabular), then the title in the serif (two lines at most),
 * "Speaker · Affiliation", and a line of chips — the series, the primary
 * department in its School's colours, the venue with a pin, and Online /
 * Cancelled marks with a word and an icon (never colour alone). No abstract.
 *
 * The whole row is one link to the talk's page; `onOpen` lets a plain click
 * open the details sheet in place instead (a modified click still opens the
 * page). `now` (client-only, after mount) adds a quiet "Now" / "in 25 min"
 * / "Finished" (no fading: faded chips would fail contrast).
 */
export function TalkRow({
  talk,
  href,
  onOpen,
  now,
  headingLevel = 3,
  className,
}: {
  talk: TalkListItem
  href: string
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>) => void
  now?: number
  headingLevel?: 2 | 3 | 4
  className?: string
}) {
  const { start, end } = talkTimes(talk)
  const department = talk.departments[0]
  const tone = department ? SCHOOL_TONE[department.school] : SCHOOL_TONE.other
  const speakers = speakerLine(talk.speakers)
  const timing = talkTiming(talk, now)
  const Heading = `h${headingLevel}` as const
  const hybrid = talk.online && physicalVenue(talk.venue) !== null

  return (
    <article
      className={cn(
        "group relative grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 py-3.5 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-x-5",
        className,
      )}
    >
      <div className="flex flex-col pt-0.5 font-mono text-[0.8125rem] leading-tight tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
          <span className={cn(talk.cancelled && "text-muted-foreground line-through")}>
            {start}
          </span>
        </span>
        {end && <span className="pl-3 text-muted-foreground">{end}</span>}
        {timing?.kind === "now" && (
          <span className="mt-1.5 inline-flex items-center gap-1 pl-3 font-sans text-[0.6875rem] font-medium text-talks">
            <span aria-hidden className="relative flex size-1.5">
              <span className="absolute inline-flex size-full rounded-full bg-talks opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-1.5 rounded-full bg-talks" />
            </span>
            Now
          </span>
        )}
        {timing?.kind === "past" && (
          <span className="mt-1.5 pl-3 font-sans text-[0.6875rem] text-muted-foreground">
            Finished
          </span>
        )}
        {timing?.kind === "soon" && (
          <span className="mt-1.5 pl-3 font-sans text-[0.6875rem] font-medium text-talks">
            in {timing.minutes} min
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="font-serif text-[1.0625rem] leading-snug font-medium text-pretty sm:text-lg">
          <a
            href={href}
            onClick={onOpen}
            className={cn(
              "line-clamp-2 rounded-sm decoration-1 underline-offset-4 after:absolute after:inset-0 after:rounded-lg group-hover:underline",
              "focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring",
              talk.cancelled && "text-muted-foreground line-through",
            )}
          >
            {talk.title}
          </a>
        </Heading>
        {speakers && <p className="truncate text-sm text-muted-foreground">{speakers}</p>}
        <ul className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
          {talk.cancelled && (
            <li className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 font-medium text-destructive">
              <BanIcon aria-hidden className="size-3" />
              Cancelled
            </li>
          )}
          {talk.series && (
            <li className="max-w-full truncate rounded-md border bg-card px-1.5 py-0.5 text-foreground/80">
              <span className="sr-only">Series: </span>
              {talk.series}
            </li>
          )}
          {department && (
            <li
              className={cn("max-w-full truncate rounded-md px-1.5 py-0.5 font-medium", tone.chip)}
            >
              <span className="sr-only">Department: </span>
              {department.shortName}
            </li>
          )}
          {talk.kind !== "seminar" && talk.kind !== "other" && (
            <li className="font-mono text-[0.6875rem] tracking-wide text-muted-foreground uppercase">
              {TALK_KIND_LABELS[talk.kind]}
            </li>
          )}
          {talk.venue && (
            <li className="inline-flex min-w-0 max-w-full items-center gap-1 text-muted-foreground">
              <MapPinIcon aria-hidden className="size-3 shrink-0" />
              <span className="sr-only">Venue: </span>
              <span className="truncate">{talk.venue}</span>
            </li>
          )}
          {talk.online && (
            <li className="inline-flex items-center gap-1 font-medium text-talks">
              <VideoIcon aria-hidden className="size-3.5" />
              {hybrid ? "Hybrid" : "Online"}
            </li>
          )}
        </ul>
      </div>
    </article>
  )
}

/** A row's shape while the agenda loads. */
export function TalkRowSkeleton() {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 py-3.5 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-x-5"
    >
      <div className="h-4 w-11 animate-pulse rounded bg-muted" />
      <div className="flex flex-col gap-2">
        <div className="h-5 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="flex gap-2">
          <div className="h-5 w-28 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  )
}
