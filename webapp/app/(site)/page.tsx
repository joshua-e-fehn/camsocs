import { fetchQuery } from "convex/nextjs"
import { ArrowRightIcon, CalendarDaysIcon, LinkIcon, SearchIcon, UsersIcon } from "lucide-react"
import Link from "next/link"
import { CATEGORY_ICONS } from "@/components/molecules/category-icon"
import { EventItem } from "@/components/molecules/event-item"
import { Reveal } from "@/components/molecules/reveal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/convex/_generated/api"
import { addDays, londonIsoDate, londonMidnight } from "@/lib/calendar"
import { groupRuns, runSummary, splitOngoing } from "@/lib/event-runs"
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/vocab"

const THIS_WEEK_SHOWN = 6

const EXPLAINER = [
  {
    icon: UsersIcon,
    title: "One directory",
    body: "University societies, sports clubs, theatre companies, JCRs, MCRs and boat clubs, from the registers and from their own sites.",
  },
  {
    icon: CalendarDaysIcon,
    title: "One calendar",
    body: "Talks, socials, matches and shows, read from the feeds and listings societies already publish.",
  },
  {
    icon: LinkIcon,
    title: "Sourced, not guessed",
    body: "Every fact shows where it came from and when it was read. What nobody publishes is marked as missing, not filled in.",
  },
] as const

export default async function HomePage() {
  const today = londonIsoDate(Date.now())
  // Public data only (no token): the home page is the same for everyone.
  const [facets, events] = await Promise.all([
    fetchQuery(api.orgs.facets, {}),
    fetchQuery(api.events.list, {
      from: londonMidnight(today),
      to: londonMidnight(addDays(today, 7)),
    }),
  ])
  // What starts this week first; a long run that began weeks ago (a film
  // listed for months) only fills spare places.
  const { ongoing, starting } = splitOngoing(
    events.filter((event) => !event.cancelled),
    londonMidnight(today),
  )
  // A show's nights this week are one entry (lib/event-runs.ts).
  const thisWeek = groupRuns([...starting, ...ongoing]).slice(0, THIS_WEEK_SHOWN)

  return (
    <>
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-size-[48px_48px] mask-[radial-gradient(ellipse_at_top,black_30%,transparent_75%)] opacity-60"
        />
        <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 sm:py-24">
          <div className="flex max-w-3xl flex-col gap-4">
            <p className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
              Unofficial · every fact sourced
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
              Find your people in Cambridge.
            </h1>
            <p className="max-w-2xl text-lg text-muted-foreground">
              {facets.total > 0 ? (
                <>
                  <span className="font-mono text-foreground tabular-nums">{facets.total}</span>{" "}
                  {facets.total === 1 ? "society or club" : "societies and clubs"} in one place,
                  each fact linked to the page it came from.
                </>
              ) : (
                "Societies and clubs in one place, each fact linked to the page it came from. The directory is being filled from public sources now."
              )}
            </p>
          </div>
          <search className="w-full max-w-xl">
            <form action="/societies" className="flex w-full gap-2">
              <label htmlFor="home-search" className="sr-only">
                Search societies and clubs
              </label>
              <div className="relative flex-1">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="home-search"
                  name="q"
                  type="search"
                  placeholder="Chess, rowing, jazz, German…"
                  className="h-11 bg-background pl-9 text-base"
                  maxLength={200}
                />
              </div>
              <Button type="submit" size="lg" className="h-11 px-4">
                Search
              </Button>
            </form>
          </search>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href="/societies">
                Browse all societies
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/events">See the events calendar</Link>
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="categories" className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6">
        {/* Not revealed: it sits at the fold, and must be visible before scripts run. */}
        <div className="flex flex-col gap-6">
          <div className="flex items-end justify-between gap-4">
            <h2 id="categories" className="text-2xl font-semibold tracking-tight">
              Browse by category
            </h2>
            <Link href="/societies" className="text-sm text-muted-foreground hover:text-foreground">
              All filters
            </Link>
          </div>
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {CATEGORIES.map((category) => {
              const Icon = CATEGORY_ICONS[category]
              const count = facets.categories[category] ?? 0
              return (
                <li key={category}>
                  <Link
                    href={`/societies?cat=${category}`}
                    className="group flex h-full min-h-20 flex-col justify-between gap-3 rounded-xl border bg-card p-4 transition-colors duration-200 hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Icon aria-hidden className="size-5 text-muted-foreground" />
                    <span className="flex items-end justify-between gap-2">
                      <span className="text-sm leading-snug font-medium">
                        {CATEGORY_LABELS[category]}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {count}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      <section aria-labelledby="this-week" className="border-y bg-muted/30">
        <Reveal className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-14 sm:px-6">
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id="this-week" className="text-2xl font-semibold tracking-tight">
                Happening this week
              </h2>
              <p className="text-sm text-muted-foreground">Public events in the next seven days.</p>
            </div>
            <Link href="/events" className="text-sm text-muted-foreground hover:text-foreground">
              Full calendar
            </Link>
          </div>
          {thisWeek.length > 0 ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {thisWeek.map((run) => (
                <li key={run.key} className="min-w-0">
                  <EventItem
                    event={run.events[0]}
                    href={`/events?event=${run.key}`}
                    runLabel={run.events.length > 1 ? runSummary(run) : undefined}
                    className="h-full"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
              <CalendarDaysIcon aria-hidden className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No public events are listed for the next seven days yet. Societies&apos; calendars
                are added as their feeds are found.
              </p>
              <Button variant="outline" size="sm" asChild>
                <Link href="/events">Open the calendar</Link>
              </Button>
            </div>
          )}
        </Reveal>
      </section>

      <section aria-labelledby="how" className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6">
        <Reveal className="flex flex-col gap-8">
          <h2 id="how" className="text-2xl font-semibold tracking-tight">
            What camsocs is
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {EXPLAINER.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex flex-col gap-3 border-l-2 pl-4">
                <Icon aria-hidden className="size-5 text-muted-foreground" />
                <h3 className="font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
          {/* The full non-affiliation statement is in the footer of every page. */}
          <p className="text-sm text-muted-foreground">
            Unofficial and independent.{" "}
            <Link href="/about" className="underline underline-offset-4 hover:text-foreground">
              How we collect data
            </Link>
            .
          </p>
        </Reveal>
      </section>
    </>
  )
}
