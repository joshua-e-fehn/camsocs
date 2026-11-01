import { fetchQuery } from "convex/nextjs"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { Crest } from "@/components/molecules/crest"
import { HeroSearch } from "@/components/molecules/hero-search"
import {
  HomeOverview,
  MoreLink,
  type OverviewDay,
  type OverviewItem,
  type OverviewSlice,
  type OverviewSociety,
} from "@/components/organisms/home-overview"
import { api } from "@/convex/_generated/api"
import {
  addDays,
  formatDayShort,
  londonIsoDate,
  londonMidnight,
  londonTime,
  weekdayShort,
} from "@/lib/calendar"
import { type EventRun, groupRuns, splitOngoing } from "@/lib/event-runs"
import type { EventListItem, TalkListItem } from "@/lib/public-api"
import { schoolColumns, talkHref, talkMeta, talkTime } from "@/lib/talk-display"
import { loadTermClock } from "@/lib/term-dates"
import { TERM_NAMES, type TermClock, weekOfTerm } from "@/lib/term-week"
import { CATEGORIES, CATEGORY_LABELS, TALK_SCHOOL_LABELS } from "@/lib/vocab"

/** Rows per column in the overview; the rest is one "N more" link. */
const ROWS = 5
/** Talks read per day: the rows shown plus room for cancelled ones. The day
 * counts (`talks.dayCounts`) are exact. Read day by day, so a busy Monday
 * cannot crowd the rest of the week out of one page. */
const DAY_TALKS = ROWS + 5
/** Departments named under each School. */
const DEPARTMENTS_PER_SCHOOL = 3
/** An event or talk with no end time still counts as on for this long. */
const DEFAULT_LENGTH_MS = 2 * 60 * 60 * 1000
/** The hero's "Try" links. */
const TRY = [
  { href: "/societies?q=jazz", label: "Jazz" },
  { href: "/societies?q=rowing", label: "Rowing" },
  { href: "/societies?cat=politics_debate", label: "Debating" },
  { href: "/societies?beginner=yes", label: "Beginners welcome" },
  { href: "/talks", label: "Seminars" },
] as const

/**
 * The talks pillar for the home page: its numbers, the week's talks with
 * exact per-day counts, and the departments. Null when the talks module
 * cannot be read — the page then shows no Talks column rather than zeros
 * (DESIGN.md "no fake numbers").
 */
async function loadTalks(today: string) {
  const from = londonMidnight(today)
  const to = londonMidnight(addDays(today, 7))
  try {
    const days = Array.from({ length: 7 }, (_, offset) => addDays(today, offset))
    const [overview, dayCounts, departments, ...perDay] = await Promise.all([
      fetchQuery(api.talks.overview, {}),
      fetchQuery(api.talks.dayCounts, { from, to }),
      fetchQuery(api.talks.departments, {}),
      ...days.map((day) =>
        fetchQuery(api.talks.list, {
          from: londonMidnight(day),
          to: londonMidnight(addDays(day, 1)),
          paginationOpts: { numItems: DAY_TALKS, cursor: null },
        }),
      ),
    ])
    return { overview, week: perDay.flatMap((page) => page.page), dayCounts, departments }
  } catch (error) {
    unstable_rethrow(error)
    console.error("talks queries failed; the home page without its talks", error)
    return null
  }
}

const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
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

/** "Wednesday 4 November". */
function longDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`)
  return `${LONG_WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${LONG_MONTHS[date.getUTCMonth()]}`
}

function greeting(now: number): string {
  const hour = Number(londonTime(now).slice(0, 2))
  if (hour < 5) return "Good evening"
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/** "Michaelmas · week 4", or "Vacation · Lent from Tue 19 Jan". */
function termLine(clock: TermClock | null): string | undefined {
  if (!clock) return undefined
  if (clock.kind === "term")
    return `${TERM_NAMES[clock.term]} · ${weekOfTerm(clock.week).toLowerCase()}`
  return clock.next
    ? `Vacation · ${TERM_NAMES[clock.next.term]} from ${formatDayShort(clock.next.fullTermStart)}`
    : "Vacation"
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`
}

/** Timed first, by time; all-day ones (often a vague listing) after them. */
function byTime<T extends { startsAt: number; allDay: boolean }>(a: T, b: T): number {
  return Number(a.allDay) - Number(b.allDay) || a.startsAt - b.startsAt
}

function eventItem(run: EventRun<EventListItem>, today: string, weekday: boolean): OverviewItem {
  const event = run.events[0]
  const day = londonIsoDate(event.startsAt)
  return {
    key: run.key,
    href: `/events/${run.key}`,
    time: day < today ? "On" : event.allDay ? "All day" : londonTime(event.startsAt),
    weekday: weekday ? (day === today ? "Today" : weekdayShort(day)) : undefined,
    isToday: weekday && day === today,
    title: event.title,
    meta: [event.organisers[0]?.name, event.venueText].filter(Boolean).join(" · ") || undefined,
  }
}

function talkItem(talk: TalkListItem, today: string, weekday: boolean): OverviewItem {
  const day = londonIsoDate(talk.startsAt)
  return {
    key: talk.key,
    href: talkHref(talk.key),
    time: talkTime(talk, today),
    weekday: weekday ? (day === today ? "Today" : weekdayShort(day)) : undefined,
    isToday: weekday && day === today,
    title: talk.title,
    meta: talkMeta(talk),
  }
}

/** The societies with events among these runs, busiest first. */
function hosts(runs: readonly EventRun<EventListItem>[]): OverviewSociety[] {
  const counts = new Map<string, OverviewSociety>()
  for (const run of runs) {
    for (const organiser of run.events[0].organisers) {
      const row = counts.get(organiser.key)
      if (row) row.count += 1
      else
        counts.set(organiser.key, {
          key: organiser.key,
          href: `/societies/${organiser.slug}`,
          name: organiser.name,
          count: 1,
        })
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "en-GB"),
  )
}

function summary(events: number, talks: number | null, societies: number): string {
  return [
    plural(events, "event", "events"),
    talks === null ? undefined : plural(talks, "talk", "talks"),
    `${plural(societies, "society", "societies")} hosting`,
  ]
    .filter(Boolean)
    .join(" · ")
}

export default async function HomePage() {
  const now = Date.now()
  const today = londonIsoDate(now)
  const days = Array.from({ length: 7 }, (_, offset) => addDays(today, offset))
  // Public data only (no token): the home page is the same for everyone.
  const [{ facets, categoryExamples: examples }, events, talks, { clock }] = await Promise.all([
    fetchQuery(api.orgs.home, {}),
    fetchQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, 7)),
    }),
    loadTalks(today),
    loadTermClock(),
  ])

  // What starts in these seven days; a long run that began weeks ago (a film
  // listed for months) is not this week's.
  const { starting } = splitOngoing(
    events.filter((event) => !event.cancelled),
    londonMidnight(today),
  )
  const liveTalks = (talks?.week ?? []).filter((talk) => !talk.cancelled).sort(byTime)
  const talkCount = new Map(talks?.dayCounts.map((row) => [row.day, row.count]))

  /** Today: what has not finished yet, so the evening view is not the morning's. */
  const notOver = (item: { startsAt: number; endsAt?: number | null; allDay: boolean }) =>
    item.allDay || (item.endsAt ?? item.startsAt + DEFAULT_LENGTH_MS) > now

  /** Today's rows from the first one still on: what is over drops off the
   * top, but a quiet evening still shows the day's last few. */
  const fromNow = <T,>(
    rows: T[],
    timing: (row: T) => { startsAt: number; endsAt?: number | null; allDay: boolean },
  ): T[] => {
    const first = rows.findIndex((row) => notOver(timing(row)))
    const start = Math.max(0, Math.min(first === -1 ? rows.length : first, rows.length - ROWS))
    return rows.slice(start)
  }

  const daySlice = (
    day: string,
  ): { slice: OverviewSlice; events: number; talks: number | null } => {
    const isToday = day === today
    const dayEvents = starting.filter((event) => londonIsoDate(event.startsAt) === day)
    // One entry per show, even across its nights that day.
    const runs = groupRuns(dayEvents).sort((a, b) => byTime(a.events[0], b.events[0]))
    const shownRuns = isToday ? fromNow(runs, (run) => run.events[0]) : runs
    const dayTalks = liveTalks.filter((talk) => londonIsoDate(talk.startsAt) === day)
    const shownTalks = isToday ? fromNow(dayTalks, (talk) => talk) : dayTalks
    const talkTotal = talks ? (talkCount.get(day) ?? dayTalks.length) : null
    const societies = hosts(runs)
    return {
      events: runs.length,
      talks: talkTotal,
      slice: {
        heading: isToday ? "Today" : longDay(day),
        summary: summary(runs.length, talkTotal, societies.length),
        events: {
          items: shownRuns.slice(0, ROWS).map((run) => eventItem(run, today, false)),
          total: runs.length,
          href: `/events?date=${day}`,
        },
        talks:
          talkTotal === null
            ? null
            : {
                items: shownTalks.slice(0, ROWS).map((talk) => talkItem(talk, today, false)),
                total: talkTotal,
                href: `/talks?from=${day}`,
              },
        societies: { items: societies.slice(0, ROWS), total: societies.length, href: "/societies" },
      },
    }
  }

  const perDay = days.map((day) => ({ day, ...daySlice(day) }))
  const overviewDays: OverviewDay[] = perDay.map(({ day, slice, events, talks }) => ({
    iso: day,
    weekday: weekdayShort(day),
    date: String(Number(day.slice(8))),
    isToday: day === today,
    events,
    talks,
    slice,
  }))
  const todaySlice = perDay[0].slice

  // The week: a show's run counts once, and the lists are what comes next.
  const weekRuns = groupRuns(starting).sort((a, b) => byTime(a.events[0], b.events[0]))
  const upcomingRuns = weekRuns.filter((run) => notOver(run.events[0]) && !run.events[0].allDay)
  const weekTalkTotal = talks ? talks.dayCounts.reduce((sum, row) => sum + row.count, 0) : null
  const weekHosts = hosts(weekRuns)
  const weekSlice: OverviewSlice = {
    heading: "This week",
    summary: summary(weekRuns.length, weekTalkTotal, weekHosts.length),
    events: {
      items: upcomingRuns.slice(0, ROWS).map((run) => eventItem(run, today, true)),
      total: weekRuns.length,
      href: "/events",
    },
    talks:
      weekTalkTotal === null
        ? null
        : {
            items: liveTalks
              .filter((talk) => notOver(talk) && !talk.allDay)
              .slice(0, ROWS)
              .map((talk) => talkItem(talk, today, true)),
            total: weekTalkTotal,
            href: "/talks",
          },
    societies: { items: weekHosts.slice(0, ROWS), total: weekHosts.length, href: "/societies" },
  }

  const eventsToday = perDay[0].events
  const talksToday = perDay[0].talks ?? 0
  const departments = talks?.overview.departments ?? 0
  const columns = talks ? schoolColumns(talks.departments, DEPARTMENTS_PER_SCHOOL) : []
  const hasTalks = talks !== null && talks.overview.next28Days > 0
  const term = termLine(clock)

  return (
    <>
      {/* Hero: the one sky band ------------------------------------------------------------ */}
      <div className="border-b border-sky-line bg-sky">
        <section
          aria-labelledby="home-heading"
          className="mx-auto grid w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 pt-6 pb-8 sm:px-8 md:gap-x-16 md:pt-[52px] md:pb-[46px]"
        >
          <p className="col-start-1 row-start-1 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 font-mono text-xs tracking-[0.02em] text-muted-foreground tabular-nums sm:text-[0.8125rem]">
            <span className="inline-flex items-center gap-2 font-medium text-foreground">
              <span aria-hidden className="size-[9px] rounded-full bg-today" />
              {longDay(today)}
            </span>
            {term && (
              <>
                <span aria-hidden className="h-3.5 w-px bg-sky-line max-sm:hidden" />
                <span>{term}</span>
              </>
            )}
          </p>
          <div className="col-span-2 row-start-2 flex min-w-0 flex-col md:col-span-1 md:col-start-1">
            <h1
              id="home-heading"
              className="mt-[18px] mb-3 max-w-[12em] font-serif text-[clamp(2.5rem,11.6vw,3.25rem)] leading-[1.03] tracking-[-0.02em] text-balance md:mt-5 md:mb-5 md:text-[clamp(2.75rem,6.2vw,5rem)]"
            >
              What’s on in Cambridge{" "}
              <span className="underline decoration-today decoration-[0.09em] underline-offset-[0.14em] [text-decoration-skip-ink:none]">
                today
              </span>
            </h1>
            <p className="max-w-[34em] text-[1.0625rem] leading-[1.55] text-muted-foreground md:text-[1.1875rem]">
              {facets.total > 0 ? (
                <>
                  {greeting(now)}.{" "}
                  <strong className="font-semibold text-foreground">
                    {plural(eventsToday, "event", "events")}
                  </strong>
                  {talks && (
                    <>
                      {" "}
                      and{" "}
                      <strong className="font-semibold text-foreground">
                        {plural(talksToday, "talk", "talks")}
                      </strong>
                    </>
                  )}{" "}
                  {eventsToday + talksToday === 1 ? "is" : "are"} on today, across{" "}
                  {plural(facets.total, "society and club", "societies and clubs")}
                  {departments > 0 && <> and {plural(departments, "department", "departments")}</>}.
                </>
              ) : (
                "Societies, clubs, their events and the University’s talks in one place. The directory is being filled from public sources now."
              )}
            </p>
            <HeroSearch className="mt-5 max-w-[600px] md:mt-[30px]" />
            <p className="mt-2 flex flex-wrap items-center gap-x-4 text-sm text-muted-foreground">
              <span>Try</span>
              {TRY.filter((link) => hasTalks || link.href !== "/talks").map((link, index) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    "inline-flex min-h-11 items-center font-medium text-brand-text underline decoration-sky-line decoration-1 underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9" +
                    (index >= 3 ? " max-sm:hidden" : "")
                  }
                >
                  {link.label}
                </Link>
              ))}
            </p>
          </div>
          <figure className="col-start-2 row-start-1 m-0 w-16 self-center text-center md:row-span-2 md:w-[196px] lg:w-[228px]">
            <Crest className="w-full md:drop-shadow-[0_18px_22px_rgba(15,42,51,0.12)]" />
            <figcaption className="mt-4 font-mono text-xs tracking-[0.04em] text-muted-foreground max-md:sr-only">
              <span className="font-serif text-[0.9375rem] tracking-normal text-foreground">
                omnia hic
              </span>{" "}
              · all of it, here
            </figcaption>
          </figure>
        </section>
      </div>

      <HomeOverview
        today={todaySlice}
        week={weekSlice}
        days={overviewDays}
        weekRange={`${formatDayShort(days[0])} – ${formatDayShort(days[6])}`}
      />

      {/* Find your people -------------------------------------------------------------------- */}
      <section
        id="categories"
        aria-labelledby="categories-heading"
        className="mx-auto w-full max-w-7xl scroll-mt-24 px-4 pb-11 sm:px-8"
      >
        <RowHead
          id="categories-heading"
          title="Find your people"
          sub={`${plural(facets.total, "society and club", "societies and clubs")} in ${CATEGORIES.length} kinds`}
          link={{ href: "/societies", label: "Every society" }}
        />
        <ul className="grid grid-cols-2 gap-x-[18px] sm:gap-x-8 md:grid-cols-3 lg:grid-cols-4">
          {CATEGORIES.map((category) => (
            <li key={category} className="flex min-w-0">
              <Link
                href={`/societies?cat=${category}`}
                className="group flex min-h-12 min-w-0 flex-1 flex-col justify-center border-b py-3 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="flex items-baseline justify-between gap-2.5">
                  <span className="min-w-0 text-[0.9375rem] leading-snug font-semibold group-hover:text-brand-text group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px] sm:text-[0.96875rem]">
                    {CATEGORY_LABELS[category]}
                  </span>
                  <span className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground tabular-nums">
                    {facets.categories[category] ?? 0}
                  </span>
                </span>
                {(examples[category]?.length ?? 0) > 0 && (
                  <span className="mt-0.5 truncate text-[0.84375rem] text-muted-foreground max-sm:hidden">
                    {examples[category]
                      ?.slice(0, 3)
                      .map((org) => org.name)
                      .join(", ")}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Talks by School --------------------------------------------------------------------- */}
      {talks && hasTalks && (
        <section
          id="talks-by-school"
          aria-labelledby="schools-heading"
          className="mx-auto w-full max-w-7xl scroll-mt-24 px-4 pb-11 sm:px-8"
        >
          <RowHead
            id="schools-heading"
            title="Talks by School"
            sub={`${plural(talks.overview.next28Days, "talk", "talks")} in the next four weeks, from ${plural(talks.overview.departments, "department", "departments")}`}
            link={{ href: "/talks/departments", label: "All departments" }}
          />
          <ul className="grid grid-cols-2 gap-x-[18px] sm:gap-x-8 md:grid-cols-3">
            {columns
              .filter((column) => column.total > 0)
              .map((column) => (
                <li key={column.school} className="flex min-w-0">
                  <Link
                    href={`/talks?school=${column.school}`}
                    className="group flex min-h-12 min-w-0 flex-1 flex-col justify-center border-b py-3 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex items-baseline justify-between gap-2.5">
                      <span className="min-w-0 text-[0.9375rem] leading-snug font-semibold group-hover:text-brand-text group-hover:underline group-hover:decoration-1 group-hover:underline-offset-[3px] sm:text-[0.96875rem]">
                        {TALK_SCHOOL_LABELS[column.school]}
                      </span>
                      <span className="shrink-0 font-mono text-[0.8125rem] text-muted-foreground tabular-nums">
                        {column.total}
                        <span className="max-sm:hidden">
                          {" "}
                          {column.total === 1 ? "talk" : "talks"}
                        </span>
                      </span>
                    </span>
                    {column.top.length > 0 && (
                      <span className="mt-0.5 truncate text-[0.84375rem] text-muted-foreground max-sm:hidden">
                        {column.top.map((department) => department.shortName).join(", ")}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* How this is made -------------------------------------------------------------------- */}
      <section aria-label="How this is made" className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-8">
        <p className="max-w-3xl border-t pt-5 text-sm leading-relaxed text-muted-foreground">
          <span className="font-serif text-base text-foreground">Sourced, not guessed.</span> Every
          fact on a society’s page links to where it was read. Talks come from talks.cam and
          departments’ own listings, read by parsers alone — no AI model sees them.{" "}
          <Link
            href="/about"
            className="inline-flex min-h-6 items-center text-foreground underline underline-offset-4 hover:text-brand-text"
          >
            How camsocs works
          </Link>
        </p>
        <p className="mt-2 font-mono text-[0.6875rem] tracking-wide text-muted-foreground">
          London time · counts as of {formatDayShort(today)}, {londonTime(now)}
        </p>
      </section>
    </>
  )
}

function RowHead({
  id,
  title,
  sub,
  link,
}: {
  id: string
  title: string
  sub: string
  link: { href: string; label: string }
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 border-t border-foreground pt-[22px]">
      <div className="min-w-0">
        <h2 id={id} className="font-serif text-[1.45rem] leading-tight sm:text-[1.625rem]">
          {title}
        </h2>
        <p className="mt-1.5 font-mono text-[0.8125rem] text-muted-foreground tabular-nums">
          {sub}
        </p>
      </div>
      <MoreLink href={link.href}>{link.label}</MoreLink>
    </div>
  )
}
