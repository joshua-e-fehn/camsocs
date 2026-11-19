"use client"

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { FormalNightRow } from "@/components/molecules/formal-night-row"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { Weekday } from "@/lib/colleges"
import {
  byWeekday,
  collegeCount,
  DEFAULT_FILTERS,
  dayFromId,
  dayId,
  type FormalFilters,
  type FormalSlot,
  initialSelection,
  londonWeekday,
  WEEK,
  WEEKDAY_NAMES,
} from "@/lib/formal-week"
import { cn } from "@/lib/utils"

type Selection = Weekday | "all"

/** The picker's options in order: the seven days, then the whole week. */
const OPTIONS: readonly Selection[] = [...WEEK, "all"]

function countText(count: number): string {
  return `${count} ${count === 1 ? "college" : "colleges"}`
}

/**
 * The week of formals (/formals, ENG-272). The server's HTML lists every
 * day's section (ids `monday` … `sunday`), and the page keeps the whole week
 * once mounted, so nothing moves on hydration (formals SEO audit 2026-11-19:
 * CLS) and a searcher sees every night; today is marked. A day in the URL's
 * hash (on load or a later `#saturday` link) shows that day alone and
 * scrolls to it. The day picker is a radio group of real `#monday` links
 * (crawlers and "open in new tab" get the fragment), handled in place: a tap
 * shows that day alone and writes it to the URL with `history.replaceState`,
 * so a shared link keeps the day. Arrow keys and Home/End move the choice,
 * and a choice is announced politely. The filters are local state.
 */
export function FormalsWeek({
  slots,
  serverDay,
}: {
  slots: readonly FormalSlot[]
  /** The London weekday the server rendered on: today is marked from the
   * first paint, and the browser corrects it only on a page cached from an
   * earlier day, so the "Today" label never moves a heading on hydration. */
  serverDay: Weekday
}) {
  const [selected, setSelected] = useState<Selection>("all")
  const [today, setToday] = useState<Weekday>(serverDay)
  const [filters, setFilters] = useState<FormalFilters>(DEFAULT_FILTERS)
  const [announcement, setAnnouncement] = useState("")
  const scrollTo = useRef<Weekday | null>(null)
  const picker = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setToday(londonWeekday(Date.now()))
    const initial = initialSelection(window.location.hash)
    if (initial !== "all") {
      scrollTo.current = initial
      setSelected(initial)
    }
    const onHash = () => {
      if (window.location.hash === "#week") {
        scrollTo.current = null
        setSelected("all")
        return
      }
      const hashDay = dayFromId(window.location.hash)
      if (!hashDay) return
      scrollTo.current = hashDay
      setSelected(hashDay)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  // After the chosen section is shown (it had no box while hidden), scroll to it.
  useEffect(() => {
    const day = scrollTo.current
    if (!day || selected !== day) return
    scrollTo.current = null
    document.getElementById(dayId(day))?.scrollIntoView({ block: "start" })
  }, [selected])

  const days = useMemo(() => byWeekday(slots, filters), [slots, filters])

  /** A choice by the reader: select it, keep it in the URL and announce it
   * (never on mount). */
  function choose(option: Selection) {
    setSelected(option)
    const { pathname, search } = window.location
    window.history.replaceState(
      window.history.state,
      "",
      option === "all" ? `${pathname}${search}` : `${pathname}${search}#${dayId(option)}`,
    )
    setAnnouncement(
      option === "all"
        ? "The whole week"
        : `${WEEKDAY_NAMES[option]}: ${countText(collegeCount(days[option]))}`,
    )
  }

  function onPickerKey(event: KeyboardEvent<HTMLDivElement>) {
    const at = OPTIONS.indexOf(selected)
    const last = OPTIONS.length - 1
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? at === 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    choose(OPTIONS[next])
    picker.current?.querySelectorAll<HTMLAnchorElement>("[role=radio]")[next]?.focus()
  }

  return (
    <div id="week" className="flex scroll-mt-20 flex-col gap-5">
      <div className="flex flex-col gap-4">
        <div
          ref={picker}
          role="radiogroup"
          aria-label="Night of the week"
          onKeyDown={onPickerKey}
          className="grid grid-cols-4 gap-1.5 sm:grid-cols-8"
        >
          {WEEK.map((day) => (
            <DayLink
              key={day}
              href={`#${dayId(day)}`}
              label={WEEKDAY_NAMES[day].slice(0, 3)}
              name={WEEKDAY_NAMES[day]}
              count={collegeCount(days[day])}
              controls={dayId(day)}
              pressed={selected === day}
              today={today === day}
              onPress={() => choose(day)}
            />
          ))}
          <DayLink
            href="#week"
            label="Week"
            name="The whole week"
            pressed={selected === "all"}
            today={false}
            onPress={() => choose("all")}
          />
        </div>
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <FilterCheckbox
            id="formals-visitors"
            label="Visitors can go"
            checked={filters.visitorsOnly}
            onChange={(visitorsOnly) => setFilters((f) => ({ ...f, visitorsOnly }))}
          />
          <FilterCheckbox
            id="formals-graduate"
            label="Include graduate formals"
            checked={filters.includeGraduate}
            onChange={(includeGraduate) => setFilters((f) => ({ ...f, includeGraduate }))}
          />
        </div>
      </div>

      {WEEK.map((day) => {
        const rows = days[day]
        const shown = selected === "all" || selected === day
        return (
          <section
            key={day}
            id={dayId(day)}
            hidden={!shown}
            aria-labelledby={`${dayId(day)}-title`}
            className="flex scroll-mt-20 flex-col gap-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-2 border-foreground pt-3">
              <h2
                id={`${dayId(day)}-title`}
                className="font-serif text-2xl font-medium tracking-tight"
              >
                Formals on {WEEKDAY_NAMES[day]}
              </h2>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {countText(collegeCount(rows))}
              </span>
              {today === day && <span className="text-sm font-medium text-today-text">Today</span>}
            </div>
            {rows.length > 0 ? (
              <ul className="flex flex-col divide-y rounded-xl border">
                {rows.map((slot) => (
                  <FormalNightRow
                    // Unique per college and weekday (lib/colleges.test.ts).
                    key={`${slot.collegeKey}-${slot.night.kind}-${slot.night.audience}`}
                    slot={slot}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No college publishes a formal on {WEEKDAY_NAMES[day]}s
                {filters.includeGraduate && !filters.visitorsOnly ? "" : " with these filters"}.
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}

function DayLink({
  href,
  label,
  name,
  count,
  controls,
  pressed,
  today,
  onPress,
}: {
  /** The day section's fragment (`#saturday`), or `#week` for all of them. */
  href: string
  label: string
  name: string
  count?: number
  /** The id of the day section this option shows. */
  controls?: string
  pressed: boolean
  today: boolean
  onPress: () => void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a styled single-choice picker of real fragment links; the radiogroup handles arrow keys, Home/End and the roving tabindex.
    <a
      href={href}
      role="radio"
      aria-checked={pressed}
      aria-controls={controls}
      tabIndex={pressed ? 0 : -1}
      aria-label={`${name}${today ? " (today)" : ""}${count === undefined ? "" : `, ${countText(count)}`}`}
      onClick={(event) => {
        // A plain click is handled in place; a modified one opens the link.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        onPress()
      }}
      onKeyDown={(event) => {
        // A radio is chosen with Space, as a button would be.
        if (event.key === " ") {
          event.preventDefault()
          onPress()
        }
      }}
      className={cn(
        "relative flex min-h-11 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        pressed
          ? "border-brand bg-brand text-brand-foreground"
          : "bg-background hover:bg-muted hover:text-foreground",
      )}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            pressed ? "text-brand-foreground/85" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
      {today && (
        <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-today" />
      )}
    </a>
  )
}

function FilterCheckbox({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="flex min-h-11 cursor-pointer items-center text-sm">
        {label}
      </Label>
    </div>
  )
}
