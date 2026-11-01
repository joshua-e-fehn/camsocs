import { fetchQuery } from "convex/nextjs"
import { ArrowRightIcon, CalendarDaysIcon, ChevronRightIcon, PresentationIcon } from "lucide-react"
import Link from "next/link"
import { unstable_rethrow } from "next/navigation"
import { type AgendaDay, type AgendaItem, AgendaList } from "@/components/molecules/agenda-list"
import { HeroSearch } from "@/components/molecules/hero-search"
import { RiverLine } from "@/components/molecules/river-line"
import { AgendaTabs } from "@/components/organisms/agenda-tabs"
import { api } from "@/convex/_generated/api"
import { addDays, formatDayShort, londonIsoDate, londonMidnight, londonTime } from "@/lib/calendar"
import { type EventRun, groupRuns, runSummary, splitOngoing } from "@/lib/event-runs"
import type { EventListItem, TalkListItem } from "@/lib/public-api"
import { schoolColumns, talkHref, talkMeta, talkTime } from "@/lib/talk-display"
import { SCHOOL_STYLES } from "@/lib/talk-schools"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, TALK_SCHOOL_LABELS } from "@/lib/vocab"

/** Rows per day in "This week"; the rest is one "N more" link. */
const PER_DAY = 3
const NEXT_UP = 4
const LONG_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const

/** Departments per School column in "Talks by department", and on phones. */
const DEPARTMENTS_PER_SCHOOL = 5
const PHONE_DEPARTMENTS = 3
/** Talks read per day for "This week": the rows shown plus room for a few
 * cancelled ones; the day counts (`talks.dayCounts`) are exact. Read day by
 * day, so a busy Monday cannot crowd the rest of the week out of one page. */
const DAY_TALKS = PER_DAY + 5

/** Tile rules rotate through the decorative pillar tints (never 16 colours). */
const TILE_RULES = ["bg-primary", "bg-events", "bg-talks", "bg-gilt"] as const

/**
 * The talks pillar for the home page: its numbers, this week's talks with
 * exact per-day counts, and the departments. Null when the talks module
 * cannot be read — the page then shows no Talks counter, tab or index
 * rather than zeros (DESIGN.md "no fake numbers").
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

function dayLabel(day: string, today: string): string {
  if (day === today) return "Today"
  if (day === addDays(today, 1)) return "Tomorrow"
  return LONG_DAY_NAMES[new Date(`${day}T12:00:00Z`).getUTCDay()]
}

/** "Christ's College" → "Christ's"; "Trinity Hall" stays. */
function collegeShortName(name: string): string {
  return name.replace(/\s+College$/, "")
}

function agendaItem(run: EventRun<EventListItem>, today: string): AgendaItem {
  const event = run.events[0]
  const startedEarlier = londonIsoDate(event.startsAt) < today
  return {
    key: run.key,
    href: `/events/${run.key}`,
    time: startedEarlier ? "On" : event.allDay ? "All day" : londonTime(event.startsAt),
    title: event.title,
    meta: [event.organisers[0]?.name, event.venueText].filter(Boolean).join(" · ") || undefined,
    tag: run.events.length > 1 ? runSummary(run) : undefined,
    cancelled: event.cancelled,
  }
}

function talkAgendaItem(talk: TalkListItem, today: string): AgendaItem {
  return {
    key: talk.key,
    href: talkHref(talk.key),
    time: talkTime(talk, today),
    title: talk.title,
    meta: talkMeta(talk),
    tag: talk.online ? "Online" : undefined,
  }
}

export default async function HomePage() {
  const now = Date.now()
  const today = londonIsoDate(now)
  // Public data only (no token): the home page is the same for everyone.
  const [{ facets, categoryExamples: examples }, events, colleges, talks] = await Promise.all([
    fetchQuery(api.orgs.home, {}),
    fetchQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, 7)),
    }),
    fetchQuery(api.orgs.colleges, {}),
    loadTalks(today),
  ])

  const listed = events.filter((event) => !event.cancelled)
  // What starts this week first; a long run that began weeks ago (a film
  // listed for months) does not count as this week's.
  const { starting } = splitOngoing(listed, londonMidnight(today))
  // A show's nights this week are one entry (lib/event-runs.ts).
  const runs = groupRuns(starting)

  const days: AgendaDay[] = []
  for (let offset = 0; offset < 7; offset++) {
    const day = addDays(today, offset)
    // Timed events first, by time; all-day ones (often a vague listing)
    // after them.
    const dayRuns = runs
      .filter((run) => londonIsoDate(run.events[0].startsAt) === day)
      .sort((a, b) => Number(a.events[0].allDay) - Number(b.events[0].allDay))
    if (dayRuns.length === 0) continue
    days.push({
      day,
      label: dayLabel(day, today),
      date: formatDayShort(day),
      stamp: dayRuns[0].events[0].termWeekLabel,
      items: dayRuns.slice(0, PER_DAY).map((run) => agendaItem(run, today)),
      more:
        dayRuns.length > PER_DAY
          ? { count: dayRuns.length - PER_DAY, href: `/events?date=${day}` }
          : undefined,
    })
  }

  // A day's term-week stamp, as its events carry it (talks have none of their own).
  const stamps = new Map(
    listed.map((event) => [londonIsoDate(event.startsAt), event.termWeekLabel]),
  )

  const talksThisWeek = talks?.dayCounts.reduce((sum, day) => sum + day.count, 0) ?? 0
  const talkDays: AgendaDay[] = []
  for (const { day, count } of talks?.dayCounts ?? []) {
    // Timed talks first, by time; all-day ones (a conference) after them.
    const dayTalks = (talks?.week ?? [])
      .filter((talk) => !talk.cancelled && londonIsoDate(talk.startsAt) === day)
      .sort((a, b) => Number(a.allDay) - Number(b.allDay))
    if (dayTalks.length === 0) continue
    const shown = dayTalks.slice(0, PER_DAY)
    talkDays.push({
      day,
      label: dayLabel(day, today),
      date: formatDayShort(day),
      stamp: stamps.get(day),
      items: shown.map((talk) => talkAgendaItem(talk, today)),
      more:
        count > shown.length
          ? // The talks agenda from that day (lib/talks-url-state.ts reads `from`).
            { count: count - shown.length, href: `/talks?from=${day}` }
          : undefined,
    })
  }
  const columns = talks ? schoolColumns(talks.departments, DEPARTMENTS_PER_SCHOOL) : []
  const hasTalks = talks !== null && talks.overview.next28Days > 0

  const nextUp = runs
    .filter((run) => run.events[0].startsAt >= now && !run.events[0].allDay)
    .slice(0, NEXT_UP)

  const collegeRows = colleges
    .map((college) => ({ ...college, count: facets.collegeKeys[college.key] ?? 0 }))
    .sort((a, b) => collegeShortName(a.name).localeCompare(collegeShortName(b.name)))
  const collegesWithSocieties = collegeRows.filter((college) => college.count > 0).length

  const pillars = [
    {
      href: "/societies",
      value: facets.total,
      label: facets.total === 1 ? "society or club" : "societies and clubs",
      caption:
        collegesWithSocieties > 0
          ? `University-wide and across ${collegesWithSocieties} colleges`
          : "University-wide and in the colleges",
      rule: "bg-primary",
      ink: "text-primary",
    },
    {
      href: "/events",
      value: runs.length,
      label: runs.length === 1 ? "event this week" : "events this week",
      // Runs, not listings: /events lists each night of a show, so its
      // count for the same seven days is higher.
      caption:
        "Socials, shows, matches and society talks in the next seven days; a show’s run counts once",
      rule: "bg-events",
      ink: "text-events",
    },
    ...(talks && hasTalks
      ? [
          {
            href: "/talks",
            value: talks.overview.next28Days,
            label:
              talks.overview.next28Days === 1
                ? "talk in the next four weeks"
                : "talks in the next four weeks",
            caption:
              talks.overview.departments > 0
                ? `Seminars and lectures from ${talks.overview.departments} departments and institutes`
                : "Seminars and lectures across the University",
            rule: "bg-talks",
            ink: "text-talks",
          },
        ]
      : []),
  ]

  const chips = [
    { href: "/events", label: "What's on this week" },
    ...(facets.beginnerFriendly.true
      ? [{ href: "/societies?beginner=yes", label: "Beginners welcome" }]
      : []),
    { href: "/societies?q=rowing", label: "Rowing" },
    { href: "/societies?cat=music", label: "Music" },
    { href: "/societies?cat=politics_debate", label: "Debating" },
    hasTalks
      ? { href: "/talks", label: "Seminars and lectures" }
      : { href: "/events?type=talk", label: "Society talks" },
  ]

  return (
    <>
      {/* Hero ------------------------------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 pt-12 pb-10 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16 lg:pt-20">
          <div className="flex min-w-0 flex-col gap-7">
            <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase">
              Unofficial · for students in Cambridge
            </p>
            <h1 className="max-w-3xl font-serif text-[clamp(2.6rem,7.2vw,4.75rem)] leading-[1.02] font-normal tracking-[-0.025em] text-balance">
              Everything on in Cambridge, <em className="text-primary">this&nbsp;term.</em>
            </h1>
            <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
              {facets.total > 0 ? (
                <>
                  <span className="font-mono text-foreground tabular-nums">
                    {facets.total.toLocaleString("en-GB")}
                  </span>{" "}
                  societies and clubs,{" "}
                  <span className="font-mono text-foreground tabular-nums">{runs.length}</span>{" "}
                  events this week
                  {talksThisWeek > 0 && (
                    <>
                      {" "}
                      and{" "}
                      <span className="font-mono text-foreground tabular-nums">
                        {talksThisWeek}
                      </span>{" "}
                      talks
                    </>
                  )}
                  , from boat clubs to book clubs to Babbage. Every fact links to the page it was
                  read from.
                </>
              ) : (
                "Societies, clubs and their events in one place, each fact linked to the page it came from. The directory is being filled from public sources now."
              )}
            </p>
            <HeroSearch className="max-w-2xl" />
            <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0 no-scrollbar">
              {chips.map((chip) => (
                <li key={chip.href} className="shrink-0">
                  <Link
                    href={chip.href}
                    className="inline-flex min-h-11 items-center rounded-full border border-dashed px-3.5 text-sm text-muted-foreground transition-colors hover:border-solid hover:border-primary/40 hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9"
                  >
                    {chip.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {nextUp.length > 0 && (
            <aside
              aria-labelledby="next-up"
              className="hidden self-end rounded-xl border bg-card/80 p-5 shadow-[0_18px_40px_-28px_color-mix(in_oklab,var(--foreground)_45%,transparent)] lg:block"
            >
              <h2
                id="next-up"
                className="flex items-center justify-between font-mono text-[0.6875rem] tracking-[0.16em] text-muted-foreground uppercase"
              >
                Next up
                <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-events motion-safe:animate-pulse"
                  />
                  from now
                </span>
              </h2>
              <ol className="mt-3 flex flex-col">
                {nextUp.map((run) => {
                  const event = run.events[0]
                  const day = londonIsoDate(event.startsAt)
                  return (
                    <li key={run.key} className="border-t border-dashed first:border-t-0">
                      <Link
                        href={`/events/${run.key}`}
                        className="group flex gap-3 py-3 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <span className="flex w-12 shrink-0 flex-col font-mono text-xs leading-tight tabular-nums">
                          <span className="text-foreground">{londonTime(event.startsAt)}</span>
                          <span className="text-muted-foreground">
                            {day === today ? "today" : formatDayShort(day).split(" ")[0]}
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                            {event.title}
                          </span>
                          {event.organisers[0] && (
                            <span className="truncate text-xs text-muted-foreground">
                              {event.organisers[0].name}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ol>
            </aside>
          )}
        </div>
        <RiverLine />
      </section>

      {/* Pillar counters --------------------------------------------------------------------- */}
      <section aria-label="In numbers" className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6">
        <ul
          className={cn(
            "grid divide-y sm:divide-x sm:divide-y-0",
            pillars.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
          )}
        >
          {pillars.map((pillar) => (
            <li key={pillar.href}>
              <Link
                href={pillar.href}
                className="group grid grid-cols-[auto_1fr] items-center gap-x-5 py-5 transition-colors focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-1 sm:gap-y-2 sm:px-8 sm:py-6 sm:first:pl-0"
              >
                <span
                  className={cn(
                    "min-w-[2.4ch] font-serif text-[clamp(3rem,7vw,4.5rem)] leading-none font-light tracking-[-0.03em] tabular-nums sm:min-w-0",
                    pillar.ink,
                  )}
                >
                  {pillar.value.toLocaleString("en-GB")}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 font-medium">
                    <span aria-hidden className={cn("h-0.5 w-5 rounded-full", pillar.rule)} />
                    {pillar.label}
                    <ArrowRightIcon
                      aria-hidden
                      className="size-4 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                    />
                  </span>
                  <span className="text-sm text-muted-foreground">{pillar.caption}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* This week --------------------------------------------------------------------------- */}
      <section
        aria-labelledby="this-week"
        className="mx-auto w-full max-w-7xl px-4 pt-14 pb-4 sm:px-6"
      >
        <AgendaTabs
          heading={
            <div className="flex flex-col gap-1">
              <h2
                id="this-week"
                className="font-serif text-[2rem] leading-tight tracking-[-0.01em]"
              >
                This week
              </h2>
              <p className="text-sm text-muted-foreground">
                Public events and talks starting in the next seven days, day by day.
              </p>
            </div>
          }
          tabs={[
            {
              id: "events",
              label: "Events",
              accent: "events",
              count: runs.length,
              link: { href: "/events", label: "The full calendar" },
              content:
                days.length > 0 ? (
                  <AgendaList days={days} accent="events" />
                ) : (
                  <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
                    <CalendarDaysIcon aria-hidden className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Nothing listed for the next seven days yet — quiet for term time. Societies’
                      calendars are added as their feeds are found.
                    </p>
                    <Link
                      href="/events"
                      className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
                    >
                      Open the calendar
                    </Link>
                  </div>
                ),
            },
            ...(talks
              ? [
                  {
                    id: "talks",
                    label: "Talks",
                    accent: "talks" as const,
                    count: talksThisWeek,
                    link: { href: "/talks", label: "All talks" },
                    content:
                      talkDays.length > 0 ? (
                        <div className="flex flex-col gap-5">
                          <AgendaList days={talkDays} accent="talks" />
                          <Link
                            href="/talks"
                            className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-talks transition-colors hover:underline hover:underline-offset-4"
                          >
                            Every talk this week
                            <ArrowRightIcon aria-hidden className="size-4" />
                          </Link>
                        </div>
                      ) : (
                        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
                          <PresentationIcon aria-hidden className="size-8 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">
                            No talks listed for the next seven days. Departments publish their
                            termcards in batches, so this fills up week by week.
                          </p>
                          <Link
                            href="/talks"
                            className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
                          >
                            See what is coming up
                          </Link>
                        </div>
                      ),
                  },
                ]
              : []),
          ]}
        />
      </section>

      {/* Categories -------------------------------------------------------------------------- */}
      <section
        id="categories"
        aria-labelledby="categories-heading"
        className="mx-auto w-full max-w-7xl scroll-mt-28 px-4 pt-14 sm:px-6"
      >
        <RiverLine variant="divider" draw={false} className="mb-10 opacity-80" />
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2
              id="categories-heading"
              className="font-serif text-[2rem] leading-tight tracking-[-0.01em]"
            >
              Browse by kind
            </h2>
            <p className="text-sm text-muted-foreground">
              Sixteen shelves, from subject societies to Bumps crews.
            </p>
          </div>
          <Link
            href="/societies"
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary transition-colors hover:underline hover:underline-offset-4"
          >
            Every society
            <ArrowRightIcon aria-hidden className="size-4" />
          </Link>
        </div>
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORIES.map((category, index) => {
            const count = facets.categories[category] ?? 0
            const picks = examples[category] ?? []
            const more = Math.max(0, count - picks.length)
            return (
              <li key={category} className="relative bg-card">
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 top-0 h-[3px] opacity-80",
                    TILE_RULES[index % TILE_RULES.length],
                  )}
                />
                <div className="flex h-full flex-col gap-3 p-4 sm:p-5">
                  <Link
                    href={`/societies?cat=${category}`}
                    className="group flex min-h-11 items-start justify-between gap-3 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="font-serif text-lg leading-snug group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">
                      {CATEGORY_LABELS[category]}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 pt-1 font-mono text-xs text-muted-foreground tabular-nums">
                      {count}
                      <ChevronRightIcon aria-hidden className="size-3.5 sm:hidden" />
                    </span>
                  </Link>
                  {picks.length > 0 && (
                    <>
                      {/* Phones: one run-on line of names, two lines at most. */}
                      <p className="-mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground sm:hidden">
                        {picks.map((org, i) => (
                          <span key={org.key}>
                            {i > 0 && <span aria-hidden> · </span>}
                            <Link
                              href={`/societies/${org.slug}`}
                              className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {org.name}
                            </Link>
                          </span>
                        ))}
                        {more > 0 && (
                          <span className="font-mono text-xs text-primary"> +{more}</span>
                        )}
                      </p>
                      <ul className="hidden flex-col gap-1 text-sm sm:flex">
                        {picks.map((org) => (
                          <li key={org.key} className="min-w-0">
                            <Link
                              href={`/societies/${org.slug}`}
                              className="block truncate text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              {org.name}
                            </Link>
                          </li>
                        ))}
                        {more > 0 && (
                          <li>
                            <Link
                              href={`/societies?cat=${category}`}
                              className="font-mono text-xs text-primary hover:underline hover:underline-offset-4"
                            >
                              +{more} more
                            </Link>
                          </li>
                        )}
                      </ul>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      {/* Talks by department --------------------------------------------------------------- */}
      {talks && hasTalks && (
        <section
          id="talks-by-department"
          aria-labelledby="talks-by-department-heading"
          className="mx-auto w-full max-w-7xl scroll-mt-28 px-4 pt-16 sm:px-6"
        >
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2
                id="talks-by-department-heading"
                className="font-serif text-[2rem] leading-tight tracking-[-0.01em]"
              >
                Talks by department
              </h2>
              <p className="text-sm text-muted-foreground">
                Seminars, lectures and workshops in the next four weeks, School by School — from the
                Sidgwick Site to West Cambridge.
              </p>
            </div>
            <Link
              href="/talks/departments"
              className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-talks transition-colors hover:underline hover:underline-offset-4"
            >
              All departments
              <ArrowRightIcon aria-hidden className="size-4" />
            </Link>
          </div>
          <ul className="grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {columns.map((column) => {
              const style = SCHOOL_STYLES[column.school]
              const label = TALK_SCHOOL_LABELS[column.school]
              return (
                <li key={column.school} className="flex min-w-0 flex-col">
                  <Link
                    href={`/talks?school=${column.school}`}
                    className="group flex min-h-11 items-end justify-between gap-3 border-b border-foreground/70 pb-2 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "size-2.5 shrink-0 translate-y-[-0.1em] rounded-[2px]",
                          style.rule,
                        )}
                      />
                      <span className="font-serif text-lg leading-snug group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">
                        {label}
                      </span>
                    </span>
                    <span className={cn("shrink-0 font-mono text-xs tabular-nums", style.ink)}>
                      {column.total}
                      <span className="sr-only"> upcoming talks</span>
                    </span>
                  </Link>
                  {column.top.length > 0 ? (
                    <ol className="flex flex-col">
                      {column.top.map((department, index) => (
                        <li
                          key={department.key}
                          className={cn(index >= PHONE_DEPARTMENTS && "max-sm:hidden")}
                        >
                          <Link
                            href={`/talks?dept=${department.slug}`}
                            className="group flex min-h-11 items-baseline gap-2 border-b border-dashed py-2.5 focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <span className="w-8 shrink-0 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                              <span aria-hidden>N°</span>
                              {index + 1}
                            </span>
                            <span
                              className={cn(
                                "truncate text-[0.9375rem] group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4",
                                department.virtual && "italic",
                              )}
                            >
                              {department.shortName}
                            </span>
                            <span
                              aria-hidden
                              className="mx-1 min-w-4 flex-1 translate-y-[-0.2em] border-b border-dotted border-muted-foreground/40"
                            />
                            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                              {department.upcomingCount}
                              <span className="sr-only"> talks</span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="py-3 text-sm text-muted-foreground">
                      Nothing listed for the next four weeks yet.
                    </p>
                  )}
                  {column.active > Math.min(PHONE_DEPARTMENTS, column.top.length) && (
                    // Phones list fewer rows, so they count more as hidden.
                    <Link
                      href={`/talks?school=${column.school}`}
                      className={cn(
                        "mt-1 inline-flex min-h-11 items-center gap-1 self-start text-xs text-muted-foreground transition-colors hover:text-foreground",
                        column.active === column.top.length && "sm:hidden",
                      )}
                    >
                      <span className="sm:hidden">
                        and {column.active - Math.min(PHONE_DEPARTMENTS, column.top.length)} more
                      </span>
                      <span className="max-sm:hidden">
                        and {column.active - column.top.length} more
                      </span>
                      <ArrowRightIcon aria-hidden className="size-3" />
                    </Link>
                  )}
                </li>
              )
            })}
            <li className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border border-dashed p-5">
              <p className="font-serif text-lg leading-snug text-balance">
                Every department, institute and lecture series,{" "}
                <em className="text-talks">in one index.</em>
              </p>
              <p className="text-sm text-muted-foreground">
                {talks.overview.departmentsTotal > 0
                  ? `${talks.overview.departmentsTotal} departments and institutes, ${talks.overview.departments} with talks coming up. `
                  : ""}
                Subscribe to any of them as a calendar.
              </p>
              <Link
                href="/talks/departments"
                className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-talks hover:underline hover:underline-offset-4"
              >
                Open the index
                <ArrowRightIcon aria-hidden className="size-4" />
              </Link>
            </li>
          </ul>
        </section>
      )}

      {/* Colleges ---------------------------------------------------------------------------- */}
      {collegeRows.length > 0 && (
        <section
          id="colleges"
          aria-labelledby="colleges-heading"
          className="mx-auto w-full max-w-7xl scroll-mt-28 px-4 pt-16 sm:px-6"
        >
          <div className="mb-6 flex flex-col gap-1">
            <h2
              id="colleges-heading"
              className="font-serif text-[2rem] leading-tight tracking-[-0.01em]"
            >
              By college
            </h2>
            <p className="text-sm text-muted-foreground">
              JCRs, MCRs, boat clubs and college societies, college by college.
            </p>
          </div>
          <ol className="columns-2 gap-x-5 sm:gap-x-10 lg:columns-3 xl:columns-4">
            {collegeRows.map((college, index) => (
              <li key={college.key} className="break-inside-avoid">
                <Link
                  href={`/societies?college=${college.key}`}
                  className="group flex min-h-11 items-baseline gap-2 border-b border-dashed py-2 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="hidden w-6 shrink-0 font-mono text-[0.625rem] text-muted-foreground tabular-nums sm:inline">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="truncate font-serif text-[1.0625rem] group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">
                    {collegeShortName(college.name)}
                  </span>
                  <span
                    aria-hidden
                    className="mx-1 min-w-4 flex-1 translate-y-[-0.2em] border-b border-dotted border-muted-foreground/40"
                  />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {college.count > 0 ? college.count : "–"}
                    <span className="sr-only"> societies</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Method note ------------------------------------------------------------------------- */}
      <section
        aria-labelledby="method"
        className="mx-auto w-full max-w-7xl px-4 pt-16 pb-20 sm:px-6"
      >
        <div className="max-w-2xl border-t pt-5">
          <h2 id="method" className="sr-only">
            How this is made
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            <sup className="mr-1 font-mono text-primary">†</sup>
            <span className="font-serif text-base text-foreground italic">
              Sourced, not guessed.
            </span>{" "}
            Listings and events are read from the registers, the societies’ own sites and the feeds
            they publish; each fact on a society’s page says where it came from and when it was
            read. Talks come from talks.cam and departments’ own listings, read by parsers alone —
            no AI model sees them. What nobody publishes is marked as missing, not filled in.
            camsocs is an independent student project, not an official listing.{" "}
            <Link
              href="/about"
              className="inline-flex min-h-6 items-center text-foreground underline underline-offset-4 hover:text-primary"
            >
              How we collect data
            </Link>
          </p>
          <p className="mt-2 font-mono text-[0.6875rem] tracking-wide text-muted-foreground">
            Shown in London time · counts as of {formatDayShort(today)}, {londonTime(now)}
          </p>
        </div>
      </section>
    </>
  )
}
