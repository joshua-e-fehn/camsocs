import { ArrowUpRightIcon, InfoIcon, MapPinIcon, VideoIcon } from "lucide-react"
import Link from "next/link"
import { AddToCalendar, type CalendarLinks } from "@/components/molecules/add-to-calendar"
import { ClampedText } from "@/components/molecules/clamped-text"
import { ShareAction } from "@/components/molecules/share-action"
import { SourcedChip } from "@/components/molecules/sourced-chip"
import { TermDateBlock } from "@/components/molecules/term-date-block"
import { analyticsAttrs } from "@/lib/analytics-events"
import { formatInstantDate, londonIsoDate } from "@/lib/calendar"
import { linkProps } from "@/lib/crawl-traps"
import { displayHost } from "@/lib/source-line"
import {
  googleCalendarUrl,
  outlookCalendarUrl,
  physicalVenue,
  SCHOOL_TONE,
  type TalkPublic,
  talkTimes,
} from "@/lib/talks"
import { talksHref } from "@/lib/talks-url-state"
import { cn } from "@/lib/utils"
import { TALK_KIND_LABELS } from "@/lib/vocab"

const LONG_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "Tuesday 3 November". */
function longDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  return `${LONG_WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()} ${LONG_MONTHS[date.getUTCMonth()]}`
}

/** The calendar links for one talk (its `.ics` is `/talks/<key>/ics`). */
export function talkCalendarLinks(talk: TalkPublic, pageUrl: string): CalendarLinks {
  return {
    google: googleCalendarUrl(talk, pageUrl),
    ics: `/talks/${talk.key}/ics`,
    outlook: outlookCalendarUrl(talk, pageUrl),
    office365: outlookCalendarUrl(talk, pageUrl, "outlook.office.com"),
  }
}

/** The series over the title, in the talks indigo: "Engineering Research
 * Colloquium · Lecture". */
export function TalkEyebrow({ talk, className }: { talk: TalkPublic; className?: string }) {
  const kind = talk.kind === "other" ? undefined : TALK_KIND_LABELS[talk.kind]
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-talks uppercase",
        className,
      )}
    >
      <span>{talk.series ?? talk.departments[0]?.shortName ?? "Talk"}</span>
      {kind && (
        <>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <span>{kind}</span>
        </>
      )}
    </p>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof MapPinIcon
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="sr-only">{label}: </span>
        {children}
      </div>
    </div>
  )
}

function initials(name: string): string {
  const words = name
    .replace(/^(prof(essor)?|dr|sir|dame|mr|mrs|ms)\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
  const first = words[0]?.[0] ?? ""
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : ""
  return `${first}${last}`.toUpperCase()
}

/**
 * Everything public about one talk (talks-redesign-spec §6), for the details
 * sheet on /talks and the shareable /talks/[key] page: the series eyebrow and
 * serif title (`showTitle`; the sheet puts its own in the sheet header), a
 * date tile with the term week, the venue, the speakers, the abstract
 * (clamped), departments, the actions — Add to calendar ▾, Read at source,
 * Share — and the listing's provenance as one "Sourced" chip.
 *
 * The talk's own page (`talk.url`) is the source: it has the joining link of
 * an online talk and any change the organisers make.
 */
export function TalkDetails({
  talk,
  pageUrl,
  termWeek,
  showTitle = false,
  actions = "inline",
  className,
}: {
  talk: TalkPublic
  /** Absolute URL of the talk's page here, for calendar entries. */
  pageUrl: string
  /** "Mich · Wk 5", when the day is in term. */
  termWeek?: string
  /** Render the eyebrow and an h1 title (the page); the sheet has its own. */
  showTitle?: boolean
  /** The action row: always, from `sm` up (the page's phone layout has
   * `TalkActionBar` instead), or not at all. */
  actions?: "inline" | "from-sm" | "none"
  className?: string
}) {
  const day = londonIsoDate(talk.startsAt)
  const { start, end } = talkTimes(talk)
  const time = talk.allDay ? "All day" : end ? `${start}–${end}` : start
  const sourceHost = displayHost(talk.url)
  const room = physicalVenue(talk.venue)
  const mapsUrl = room
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${room}, Cambridge`)}`
    : undefined
  const path = new URL(pageUrl).pathname

  return (
    <div className={cn("flex flex-col gap-7", className)}>
      {showTitle && (
        <header className="flex flex-col gap-3">
          <TalkEyebrow talk={talk} />
          <h1
            className={cn(
              "font-serif text-[clamp(1.85rem,4.6vw,3rem)] leading-[1.08] font-normal tracking-[-0.02em] text-balance",
              talk.cancelled && "text-muted-foreground line-through decoration-2",
            )}
          >
            {talk.title}
          </h1>
        </header>
      )}

      {talk.cancelled && (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive">
          <InfoIcon aria-hidden className="size-4" />
          The organisers have cancelled this talk.
        </p>
      )}

      <div className="flex items-start gap-4">
        <TermDateBlock
          startsAt={talk.startsAt}
          termWeekLabel={termWeek}
          accent="talks"
          size="lg"
          label={`${longDay(day)}, ${time}`}
        />
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          <p aria-hidden className="font-serif text-xl leading-tight">
            {longDay(day)}
          </p>
          <p className="font-mono text-sm tabular-nums">
            {time} <span className="text-muted-foreground">UK time</span>
          </p>
          {termWeek && (
            <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
              {termWeek}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 text-[0.9375rem]">
        {talk.venue && (
          <Row icon={MapPinIcon} label="Where">
            <span className="font-medium">{talk.venue}</span>
            {mapsUrl && (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground sm:min-h-8 underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Open in Maps
                <ArrowUpRightIcon aria-hidden className="size-3.5" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </Row>
        )}
        {talk.online && (
          <Row icon={VideoIcon} label="Online">
            <span className="font-medium">{room ? "Hybrid: in the room or online" : "Online"}</span>
            <span className="text-sm text-muted-foreground">
              The joining link is on the talk’s own page at {sourceHost}.
            </span>
          </Row>
        )}
      </div>

      {talk.speakers.length > 0 && (
        <section aria-labelledby={`speakers-${talk.key}`} className="flex flex-col gap-2.5">
          <h2
            id={`speakers-${talk.key}`}
            className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
          >
            {talk.speakers.length === 1 ? "Speaker" : "Speakers"}
          </h2>
          <ul className="flex flex-col gap-2.5">
            {talk.speakers.map((speaker) => (
              <li
                key={`${speaker.name}-${speaker.affiliation ?? ""}`}
                className="flex items-center gap-3"
              >
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-talks-tint font-serif text-[0.9375rem] text-talks"
                >
                  {initials(speaker.name)}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{speaker.name}</span>
                  {speaker.affiliation && (
                    <span className="text-sm text-muted-foreground">{speaker.affiliation}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {talk.specialMessage && (
        <p className="flex gap-2.5 rounded-xl border bg-muted/50 px-4 py-3 text-sm whitespace-pre-line">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-talks" />
          <span>
            <span className="sr-only">Note from the organisers: </span>
            {talk.specialMessage}
          </span>
        </p>
      )}

      {talk.abstract && (
        <section aria-labelledby={`abstract-${talk.key}`} className="flex flex-col gap-2.5">
          <h2
            id={`abstract-${talk.key}`}
            className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase"
          >
            Abstract
          </h2>
          <ClampedText lines={7}>
            <p className="text-[0.9375rem] leading-7 whitespace-pre-line text-pretty">
              {talk.abstract}
            </p>
          </ClampedText>
        </section>
      )}

      {talk.departments.length > 0 && (
        <section aria-label="Departments" className="flex flex-wrap gap-1.5">
          {talk.departments.map((department) => (
            <Link
              key={department.key}
              {...linkProps(talksHref({ dept: department.slug }))}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium sm:min-h-8 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                SCHOOL_TONE[department.school].chip,
              )}
            >
              More from {department.shortName}
            </Link>
          ))}
        </section>
      )}

      {actions !== "none" && (
        <div
          className={cn(
            "flex-wrap items-center gap-2",
            actions === "from-sm" ? "hidden sm:flex" : "flex",
          )}
        >
          <AddToCalendar
            links={talkCalendarLinks(talk, pageUrl)}
            item={{ feed: "talk", key: talk.key }}
          />
          <a
            href={talk.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            {...analyticsAttrs("outbound_link_clicked", { kind: "source" })}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border bg-card px-4 text-sm font-medium transition-colors duration-150 hover:border-foreground/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-10"
          >
            Read at source
            <ArrowUpRightIcon aria-hidden className="size-4" />
            <span className="sr-only"> (opens {sourceHost} in a new tab)</span>
          </a>
          <div className="hidden sm:block">
            <ShareAction title={talk.title} path={path} />
          </div>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed pt-4 text-xs text-muted-foreground">
        <p>
          Listed at <span className="font-mono text-foreground/80">{sourceHost}</span> · read{" "}
          <span className="font-mono">{formatInstantDate(talk.retrievedAt)}</span>
        </p>
        <SourcedChip
          section="This listing"
          facts={[
            {
              label: "The talk’s listing (title, time, place, speakers, abstract)",
              meta: {
                status: "found",
                sourceUrl: talk.sourceUrl,
                retrievedAt: talk.retrievedAt,
                method: "parser",
              },
            },
          ]}
        />
      </footer>
    </div>
  )
}

/** The page's phone action bar: Add to calendar, the source, Share — fixed
 * to the bottom edge, above the home indicator. */
export function TalkActionBar({ talk, pageUrl }: { talk: TalkPublic; pageUrl: string }) {
  const sourceHost = displayHost(talk.url)
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-background/85 sm:hidden">
      <div className="flex items-center gap-3">
        <AddToCalendar
          links={talkCalendarLinks(talk, pageUrl)}
          item={{ feed: "talk", key: talk.key }}
          className="flex-1"
        />
        <a
          href={talk.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          {...analyticsAttrs("outbound_link_clicked", { kind: "source" })}
          className="flex flex-col items-center gap-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="flex size-11 items-center justify-center rounded-full border bg-card">
            <ArrowUpRightIcon aria-hidden className="size-5" />
          </span>
          Source
          <span className="sr-only"> (opens {sourceHost} in a new tab)</span>
        </a>
        <ShareAction title={talk.title} path={new URL(pageUrl).pathname} />
      </div>
    </div>
  )
}
