"use client"

import { type Preloaded, usePreloadedQuery } from "convex/react"
import {
  ArrowUpRightIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  LockIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState, useTransition } from "react"
import { EventDetails } from "@/components/molecules/event-details"
import { EventChip, EventItem } from "@/components/molecules/event-item"
import { FacetPopover } from "@/components/molecules/facet-popover"
import { OrgPicker } from "@/components/molecules/org-picker"
import { SearchField } from "@/components/molecules/search-field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { api } from "@/convex/_generated/api"
import { useEvent, useVenues } from "@/hooks/convex"
import {
  type CalendarView,
  formatDayShort,
  formatRange,
  shiftAnchor,
  viewWindow,
  WEEKDAYS,
} from "@/lib/calendar"
import { eventsByDay, lastDayOf, splitOngoing } from "@/lib/event-runs"
import type { EventListItem, OrgRef } from "@/lib/public-api"
import { camSignInHref } from "@/lib/site"
import { type EventsState, serializeEventsState } from "@/lib/url-state"
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_LABELS, EVENT_TYPE_LABELS, EVENT_TYPES } from "@/lib/vocab"

const VIEWS: { value: CalendarView; label: string; icon: typeof ListIcon }[] = [
  { value: "list", label: "List", icon: ListIcon },
  { value: "week", label: "Week", icon: CalendarRangeIcon },
  { value: "month", label: "Month", icon: CalendarDaysIcon },
]

const MONTH_CELL_CHIPS = 3

/** "N Cambridge-only events in these weeks — sign in": rendered only when the
 * server could count them; the count itself stays live. The server counts
 * whole weeks and ignores the filters (so the count cannot reveal what it
 * counts), hence "around these dates", not "in this view". */
function CamOnlyNote({
  preloaded,
  next,
}: {
  preloaded: Preloaded<typeof api.events.restrictedCount>
  next: string
}) {
  const { camOnly } = usePreloadedQuery(preloaded)
  if (camOnly === 0) return null
  return (
    <Alert>
      <LockIcon />
      <AlertDescription className="text-foreground">
        <span>
          <span className="font-mono tabular-nums">{camOnly}</span> Cambridge-only{" "}
          {camOnly === 1 ? "event is" : "events are"} listed in the weeks around these dates —{" "}
          <Link href={camSignInHref(next)}>sign in with your @cam.ac.uk email</Link> to see{" "}
          {camOnly === 1 ? "it" : "them"}.
        </span>
      </AlertDescription>
    </Alert>
  )
}

/** Events that began before the dates on screen and are still on (a film
 * listed for months, a month-long competition, lib/event-runs.ts): one folded
 * row, "N ongoing", above the days instead of a card on each. Opened, it lists
 * them as chips, soonest to end first. */
function Ongoing({
  events,
  hrefFor,
  onSelect,
}: {
  events: EventListItem[]
  hrefFor: (event: EventListItem) => string
  onSelect: (event: EventListItem) => void
}) {
  const [open, setOpen] = useState(false)
  if (events.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <h3 className="text-sm">
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:rounded-b-none">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 font-medium">
            <span className="font-mono tabular-nums">{events.length}</span> ongoing
            <span className="sr-only"> {events.length === 1 ? "event" : "events"}</span>
          </span>
          {!open && (
            <span aria-hidden className="min-w-0 truncate text-muted-foreground">
              {events.map((event) => event.title).join(" · ")}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent>
        <ul className="grid grid-cols-1 gap-1.5 border-t p-2 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <li key={event.key} className="min-w-0">
              <EventChip
                event={event}
                href={hrefFor(event)}
                onSelect={() => onSelect(event)}
                when={`until ${formatDayShort(lastDayOf(event))}`}
                className="px-2 py-3 text-sm sm:py-1.5"
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One event's details, read with `events.get` (lists carry no descriptions).
 * The list item it was opened from gives the title at once.
 */
function EventSheet({
  eventKey,
  placeholder,
  onClose,
  signInNext,
}: {
  eventKey: string | undefined
  placeholder: EventListItem | undefined
  onClose: () => void
  /** Where a Cambridge sign-in lands: this view, with the event open. */
  signInNext: string
}) {
  const event = useEvent(eventKey)
  const venues = useVenues(Boolean(event?.venueKey && !event.venueText))
  const venueName = venues?.find((venue) => venue.key === event?.venueKey)?.name
  const title = event?.title ?? placeholder?.title

  return (
    <Sheet open={eventKey !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {event ? (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className={cn("text-xl", event.cancelled && "line-through")}>
                {event.title}
              </SheetTitle>
              <SheetDescription className="sr-only">Event details</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-8">
              <EventDetails event={event} venueName={venueName} />
            </div>
          </>
        ) : event === null ? (
          <SheetHeader>
            <SheetTitle>Event not available</SheetTitle>
            <SheetDescription>
              It may have been removed, or it is a Cambridge-only event:{" "}
              <Link href={camSignInHref(signInNext)} className="underline underline-offset-4">
                sign in with your @cam.ac.uk email
              </Link>{" "}
              to see those.
            </SheetDescription>
          </SheetHeader>
        ) : (
          <div className="flex flex-col gap-4 p-4" aria-busy>
            <SheetHeader className="p-0 pr-12">
              <SheetTitle className={cn("text-xl", !title && "sr-only")}>
                {title ?? "Loading event"}
              </SheetTitle>
              <SheetDescription className="sr-only">Loading the details</SheetDescription>
            </SheetHeader>
            {!title && <Skeleton className="h-7 w-3/4" />}
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The events calendar: list (default), week and month views of what the
 * viewer may see, with filters by category, type, college and society, and a
 * search. View, range and filters live in the URL and are preloaded by the
 * server page; opening an event only adds `event=` to the URL (no reload).
 */
export function EventsCalendar({
  state,
  today,
  org,
  preloadedEvents,
  preloadedColleges,
  preloadedRestricted,
}: {
  state: EventsState
  today: string
  org: OrgRef | null
  preloadedEvents: Preloaded<typeof api.events.list>
  preloadedColleges: Preloaded<typeof api.orgs.colleges>
  preloadedRestricted: Preloaded<typeof api.events.restrictedCount> | null
}) {
  const events = usePreloadedQuery(preloadedEvents)
  const colleges = usePreloadedQuery(preloadedColleges)
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const anchor = state.date ?? today
  const range = viewWindow(state.view, anchor)
  const base: EventsState = { ...state, event: undefined }
  const hrefFor = (next: EventsState) => `/events${serializeEventsState(next)}`
  const navigate = (next: EventsState) =>
    startTransition(() => router.push(hrefFor({ ...next, event: undefined }), { scroll: false }))

  // The open event lives only in the URL, changed without a server round trip.
  const selectedKey = searchParams.get("event") ?? undefined
  const select = (key: string | undefined) =>
    window.history.pushState(null, "", hrefFor({ ...base, event: key }))
  const eventHref = (event: EventListItem) => hrefFor({ ...base, event: event.key })

  const toggle = (
    facet: "categories" | "eventTypes" | "collegeKeys",
    value: string,
    on: boolean,
  ) => {
    const current = state[facet] as string[]
    navigate({ ...base, [facet]: on ? [...current, value] : current.filter((v) => v !== value) })
  }

  const filtered =
    state.categories.length +
      state.eventTypes.length +
      state.collegeKeys.length +
      (state.org ? 1 : 0) +
      (state.q ? 1 : 0) +
      (state.takingPart ? 0 : 1) >
    0
  const { ongoing, starting } = splitOngoing(events, range.from)
  const byDay = eventsByDay(starting, range.days, state.view !== "list")
  const ongoingSection = (
    <Ongoing events={ongoing} hrefFor={eventHref} onSelect={(event) => select(event.key)} />
  )

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchField
          className="lg:max-w-sm"
          value={state.q ?? ""}
          label="Search events by title"
          placeholder="Search event titles"
          onSearch={(q) => navigate({ ...base, q: q || undefined })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <FacetPopover
            label="Category"
            options={CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))}
            selected={state.categories}
            onToggle={(value, on) => toggle("categories", value, on)}
          />
          <FacetPopover
            label="Type"
            options={EVENT_TYPES.map((value) => ({ value, label: EVENT_TYPE_LABELS[value] }))}
            selected={state.eventTypes}
            onToggle={(value, on) => toggle("eventTypes", value, on)}
          />
          <FacetPopover
            label="College"
            options={colleges.map((college) => ({ value: college.key, label: college.name }))}
            selected={state.collegeKeys}
            onToggle={(value, on) => toggle("collegeKeys", value, on)}
          />
          <OrgPicker
            className="w-56"
            value={org}
            label="Society"
            placeholder="Any society"
            onChange={(next) => navigate({ ...base, org: next?.slug })}
          />
          {/* Someone else's events the societies only take part in (D6): on by
              default, dashed like the events it adds. */}
          <Toggle
            variant="outline"
            pressed={state.takingPart}
            onPressedChange={(on) => navigate({ ...base, takingPart: on })}
            className="h-9 border-dashed font-normal"
          >
            <ArrowUpRightIcon aria-hidden />
            Include events societies take part in
          </Toggle>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate({
                  view: state.view,
                  date: state.date,
                  categories: [],
                  eventTypes: [],
                  collegeKeys: [],
                  takingPart: true,
                })
              }
            >
              <XIcon data-icon="inline-start" />
              Clear filters
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-y py-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={state.view}
          onValueChange={(value) => value && navigate({ ...base, view: value as CalendarView })}
          aria-label="Calendar view"
        >
          {VIEWS.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value} aria-label={`${label} view`}>
              <Icon aria-hidden />
              <span className="hidden sm:inline">{label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" asChild>
            <Link
              href={hrefFor({ ...base, date: shiftAnchor(state.view, anchor, -1) })}
              scroll={false}
              aria-label="Earlier"
            >
              <ChevronLeftIcon />
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={hrefFor({ ...base, date: undefined })} scroll={false}>
              Today
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild>
            <Link
              href={hrefFor({ ...base, date: shiftAnchor(state.view, anchor, 1) })}
              scroll={false}
              aria-label="Later"
            >
              <ChevronRightIcon />
            </Link>
          </Button>
        </div>
        <h2 className="font-mono text-sm font-medium tabular-nums" aria-live="polite">
          {formatRange(state.view, range, anchor)}
        </h2>
        <p className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          {isPending ? (
            <>
              <Spinner /> Updating…
            </>
          ) : (
            <>
              <span className="font-mono text-foreground tabular-nums">{events.length}</span>
              {events.length === 1 ? "event" : "events"}
            </>
          )}
        </p>
      </div>

      {preloadedRestricted && <CamOnlyNote preloaded={preloadedRestricted} next={hrefFor(base)} />}

      <div
        aria-busy={isPending}
        className={cn("transition-opacity duration-200", isPending && "opacity-60")}
      >
        {state.view === "list" &&
          (events.length > 0 ? (
            <div className="flex flex-col gap-8">
              {ongoingSection}
              {[...byDay.entries()].map(([day, dayEvents]) => (
                <section key={day} aria-labelledby={`day-${day}`} className="flex flex-col gap-2">
                  <h3
                    id={`day-${day}`}
                    className="sticky top-14 z-10 bg-background/95 py-1 font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase backdrop-blur"
                  >
                    {formatDayShort(day)}
                    {day === today && <span className="ml-2 text-foreground">Today</span>}
                  </h3>
                  <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {dayEvents.map((event) => (
                      <li key={event.key} className="min-w-0">
                        <EventItem
                          event={event}
                          href={eventHref(event)}
                          onSelect={() => select(event.key)}
                          className="h-full"
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <Empty className="rounded-xl border border-dashed py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarDaysIcon />
                </EmptyMedia>
                <EmptyTitle>No events in this range</EmptyTitle>
                <EmptyDescription>
                  {filtered
                    ? "Nothing matches these filters. Try fewer, or a later range."
                    : "No events are listed for these weeks yet. Calendars are added as societies' feeds are found."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                <Button variant="outline" size="sm" asChild>
                  <Link href={hrefFor({ ...base, date: shiftAnchor(state.view, anchor, 1) })}>
                    Later
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          ))}

        {state.view === "week" && (
          <div className="flex flex-col gap-4">
            {ongoingSection}
            <ol className="grid grid-cols-1 gap-2 md:grid-cols-7">
              {range.days.map((day) => {
                const dayEvents = byDay.get(day) ?? []
                return (
                  <li
                    key={day}
                    className={cn(
                      "flex min-w-0 flex-col gap-1.5 rounded-xl border p-2 md:min-h-28",
                      day === today && "border-primary/40 bg-muted/40",
                    )}
                  >
                    <h3 className="font-mono text-xs font-medium text-muted-foreground uppercase">
                      {formatDayShort(day)}
                      {day === today && <span className="sr-only"> (today)</span>}
                    </h3>
                    {dayEvents.length === 0 && (
                      <p className="text-xs text-muted-foreground">No events</p>
                    )}
                    {dayEvents.map((event) => (
                      <EventChip
                        key={event.key}
                        event={event}
                        href={eventHref(event)}
                        onSelect={() => select(event.key)}
                      />
                    ))}
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        {state.view === "month" && (
          <div className="flex flex-col gap-4">
            {ongoingSection}
            <div className="flex flex-col gap-1">
              <div
                aria-hidden
                className="grid grid-cols-7 gap-1 font-mono text-xs text-muted-foreground uppercase"
              >
                {WEEKDAYS.map((name) => (
                  <span key={name} className="px-1 text-center md:text-left">
                    {name}
                  </span>
                ))}
              </div>
              <ol className="grid grid-cols-7 gap-1">
                {range.days.map((day) => {
                  const dayEvents = byDay.get(day) ?? []
                  const inMonth = day.slice(0, 7) === anchor.slice(0, 7)
                  const dayHref = hrefFor({ ...base, view: "list", date: day })
                  const dayLabel = `${formatDayShort(day)}: ${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`
                  return (
                    <li
                      key={day}
                      className={cn(
                        "flex min-w-0 flex-col rounded-lg border md:min-h-28 md:gap-1 md:p-1",
                        !inMonth && "bg-muted/30 text-muted-foreground",
                        day === today && "border-primary/50",
                      )}
                    >
                      {/* Phones: the whole cell is the day — its number and how
                          many events — and opens that day in the list. */}
                      <Link
                        href={dayHref}
                        aria-label={dayLabel}
                        className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg font-mono text-xs tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:hidden"
                      >
                        <span className={cn(day === today && "font-semibold text-foreground")}>
                          {Number(day.slice(8, 10))}
                        </span>
                        <span
                          aria-hidden
                          className={cn(
                            "h-1.5 rounded-full",
                            dayEvents.length === 0
                              ? "w-1.5 bg-transparent"
                              : dayEvents.length < 3
                                ? "w-1.5 bg-primary/70"
                                : "w-3.5 bg-primary",
                          )}
                        />
                      </Link>
                      <Link
                        href={dayHref}
                        aria-label={dayLabel}
                        className="hidden rounded px-1 font-mono text-xs tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:block"
                      >
                        <span className={cn(day === today && "font-semibold text-foreground")}>
                          {Number(day.slice(8, 10))}
                        </span>
                      </Link>
                      <div className="hidden min-w-0 flex-col gap-1 md:flex">
                        {dayEvents.slice(0, MONTH_CELL_CHIPS).map((event) => (
                          <EventChip
                            key={event.key}
                            event={event}
                            href={eventHref(event)}
                            onSelect={() => select(event.key)}
                          />
                        ))}
                        {dayEvents.length > MONTH_CELL_CHIPS && (
                          <Link
                            href={dayHref}
                            className="px-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            +{dayEvents.length - MONTH_CELL_CHIPS} more
                          </Link>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
              <p className="text-xs text-muted-foreground md:hidden">
                A bar under a day means events; tap a day to list them.
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Times are UK time. Events come from societies’ own calendars, listings and mailing lists;
        each shows its source. Dashed events, marked “Taking part”, are someone else’s events a
        society lists because it takes part.
      </p>

      <EventSheet
        eventKey={selectedKey}
        placeholder={events.find((event) => event.key === selectedKey)}
        onClose={() => select(undefined)}
        signInNext={hrefFor({ ...base, event: selectedKey })}
      />
    </div>
  )
}
