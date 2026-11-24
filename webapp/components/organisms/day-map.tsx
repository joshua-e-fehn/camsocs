"use client"

import type { Preloaded } from "convex/react"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DayMapCanvas, type DayMapPin } from "@/components/molecules/day-map-canvas"
import { MapItemRow } from "@/components/molecules/map-item-row"
import { WeekStrip } from "@/components/molecules/week-strip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { api } from "@/convex/_generated/api"
import { mergeMapDays, useMapDay, useMapDayTalksSide, useMapWeekCounts } from "@/hooks/convex/map"
import { track } from "@/lib/analytics"
import type { MapDayDirection } from "@/lib/analytics-events"
import { addDays, dayWindow, formatDayShort, startOfWeek } from "@/lib/calendar"
import { FILM_ICON, itemIconKey } from "@/lib/item-icons"
import {
  countPhrase,
  farAway,
  itemId,
  itemStatus,
  type MapPin,
  type MapStatus,
  mapPins,
  mapSections,
  shownItems,
} from "@/lib/map-day"
import { type MapShow, type MapState, mapDate, mapHref, parseMapParams } from "@/lib/map-url-state"
import { directionsHref } from "@/lib/maps-link"
import type { MapItem } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { relativeDay } from "@/lib/week-strip"

/**
 * /map (docs/locations-and-map.md §0.4–0.7, §4): one London day of events and
 * talks on a map of Cambridge, and the same items as a time-ordered list.
 *
 *  - Desktop: the map on the left, the list on the right. Hovering a row
 *    raises its pin (or the cluster holding it); clicking a pin opens and
 *    scrolls to its rows. Pins close together at the current zoom merge into
 *    a cluster (lib/map-cluster.ts): clicking it zooms in, or, when zooming
 *    cannot part them, opens all their rows.
 *  - Mobile: the map fills the screen under a bottom sheet holding the list,
 *    dragged by its header between peek, half and full; a sideways swipe on
 *    the header changes the day.
 *  - Days: ‹ › arrows, the 7-day strip with counts, a date picker, ←/→ keys
 *    (not while typing or panning the map). `?d=` and `?show=` live in the URL
 *    (lib/map-url-state.ts), written with `history.replaceState` as the
 *    calendar does (no router round trip).
 *  - Past and now (owner decision 5): a 30-second clock greys what has ended
 *    and rings what is on, in words as well.
 *  - Far venues (an away fixture, a tour abroad: beyond `MAP_PIN_BOUNDS`)
 *    get no pin, so the camera never fits the county or the continent; their
 *    items are listed under "Away from Cambridge" with their place, address
 *    and Directions.
 *  - Films with no screening venue (precision `film`: a short film, a
 *    shoot) get no pin either; they are listed under "Films" with the film
 *    icon, and the counts line says how many.
 *
 * The talks boundary (G1): the server preloads the day's events only; the
 * talks and talks.cam-derived events join here once hydrated
 * (`useMapDayTalksSide`).
 */

const CLOCK_MS = 30_000
/** Sideways travel, in px, that makes a swipe a day change. */
const SWIPE_PX = 56

type Snap = "peek" | "half" | "full"

function searchParamsObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params.entries())
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Whether a key press belongs to a field or the map's own keyboard. */
function typingOrPanning(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest("input, textarea, select, [role='combobox'], [role='slider']")) return true
  return target.closest(".maplibregl-canvas-container, .maplibregl-canvas") !== null
}

export function DayMap({
  today,
  serverNow,
  preloadedDay,
  preloadedWeek,
}: {
  /** London's today, from the server, so both renders agree. */
  today: string
  /** The server's clock, for the first render's Now / Ended. */
  serverNow: number
  preloadedDay: Preloaded<typeof api.map.day>
  preloadedWeek: Preloaded<typeof api.map.weekCounts>
}) {
  const searchParams = useSearchParams()
  const state = useMemo(
    () => parseMapParams(searchParamsObject(new URLSearchParams(searchParams.toString()))),
    [searchParams],
  )
  const date = mapDate(state, today)
  const window_ = useMemo(() => dayWindow(date, 1), [date])

  // --- the clock -----------------------------------------------------------------------------
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => window.clearInterval(timer)
  }, [])
  const [userAgent, setUserAgent] = useState("")
  useEffect(() => setUserAgent(navigator.userAgent), [])

  // --- navigation ----------------------------------------------------------------------------
  const apply = useCallback(
    (next: MapState) => window.history.replaceState(null, "", mapHref(next, today)),
    [today],
  )
  const goTo = useCallback(
    (next: string, direction: MapDayDirection) => {
      if (next === date) return
      apply({ ...state, date: next })
      track("map_day_changed", { direction })
    },
    [apply, date, state],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.defaultPrevented || typingOrPanning(event.target)) return
      event.preventDefault()
      goTo(addDays(date, event.key === "ArrowLeft" ? -1 : 1), "key")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [date, goTo])

  // --- data ----------------------------------------------------------------------------------
  // The preload's own arguments (G1: events only), so it seeds the first paint.
  const loaded = useMapDay({ date, talks: "exclude", talksCam: "exclude" }, preloadedDay)
  const side = useMapDayTalksSide(date)
  // While a new day loads, the last one stays on screen alone (`stale`).
  const day = useMemo(
    () =>
      loaded.data && loaded.data.date === date
        ? mergeMapDays(loaded.data, side?.date === date ? side : undefined)
        : loaded.data,
    [loaded.data, side, date],
  )
  const stale = loaded.stale || (day !== undefined && day.date !== date)
  const weekStart = startOfWeek(date)
  const week = useMapWeekCounts({ from: weekStart, days: 7 }, preloadedWeek)

  const bounds = useMemo(
    () => ({ from: day?.from ?? window_.from, to: day?.to ?? window_.to }),
    [day?.from, day?.to, window_.from, window_.to],
  )
  const items = useMemo(() => shownItems(day?.items ?? [], state.show), [day, state.show])
  const pins = useMemo(
    () => mapPins(items, day?.venues ?? [], now, bounds),
    [items, day?.venues, now, bounds],
  )
  const pinByVenue = useMemo(() => new Map(pins.map((pin) => [pin.venueKey, pin])), [pins])
  const venues = useMemo(
    () => new Map((day?.venues ?? []).map((venue) => [venue.key, venue])),
    [day?.venues],
  )
  const sections = useMemo(() => mapSections(items, day?.venues ?? []), [items, day?.venues])
  const canvasPins = useMemo<DayMapPin[]>(
    () =>
      pins.map((pin: MapPin) => ({
        id: pin.venueKey,
        lat: pin.lat,
        lng: pin.lng,
        count: pin.items.length,
        kind: pin.kind,
        status: pin.status,
        label: pin.label,
        ...(pin.items.length === 1 && pin.items[0] ? { icon: itemIconKey(pin.items[0]) } : {}),
      })),
    [pins],
  )

  // --- pins and rows ---------------------------------------------------------------------------
  const [pointedVenue, setPointedVenue] = useState<string | null>(null)
  const [hoveredPins, setHoveredPins] = useState<string[] | null>(null)
  const [openVenues, setOpenVenues] = useState<string[]>([])
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // A new day or view closes the open row.
  const viewKey = `${date}|${state.show}`
  const [seenView, setSeenView] = useState(viewKey)
  if (seenView !== viewKey) {
    setSeenView(viewKey)
    setOpenVenues([])
    setPointedVenue(null)
    setHoveredPins(null)
  }

  // --- the mobile sheet ------------------------------------------------------------------------
  const frame = useRef<HTMLDivElement>(null)
  const sheetHead = useRef<HTMLDivElement>(null)
  const [frameHeight, setFrameHeight] = useState(0)
  const [headHeight, setHeadHeight] = useState(0)
  const [desktop, setDesktop] = useState(false)
  const [snap, setSnap] = useState<Snap>("peek")
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)")
    const update = () => setDesktop(query.matches)
    update()
    query.addEventListener("change", update)
    const observer = new ResizeObserver(() => {
      setFrameHeight(frame.current?.clientHeight ?? 0)
      setHeadHeight(sheetHead.current?.offsetHeight ?? 0)
    })
    if (frame.current) observer.observe(frame.current)
    if (sheetHead.current) observer.observe(sheetHead.current)
    return () => {
      query.removeEventListener("change", update)
      observer.disconnect()
    }
  }, [])
  // The sheet's top, in px from the frame's top, at each snap point.
  const snaps = useMemo(() => {
    const peek = Math.max(frameHeight - headHeight - 12, frameHeight * 0.35)
    return { full: 12, half: Math.round(frameHeight * 0.45), peek: Math.round(peek) }
  }, [frameHeight, headHeight])
  const sheetTop = dragOffset ?? snaps[snap]
  const measured = frameHeight > 0

  const drag = useRef<{
    id: number
    x: number
    y: number
    top: number
    mode: "v" | "h" | null
  } | null>(null)
  const onSheetDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (desktop || event.button !== 0) return
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      top: sheetTop,
      mode: null,
    }
  }
  const onSheetMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.mode) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) current.mode = "v"
      else if (Math.abs(dx) > 16 && Math.abs(dx) > 1.5 * Math.abs(dy)) current.mode = "h"
      else return
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    if (current.mode === "v") {
      setDragOffset(Math.min(Math.max(current.top + dy, snaps.full), snaps.peek))
    }
  }
  const onSheetUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    drag.current = null
    if (!current || current.id !== event.pointerId || !current.mode) return
    if (current.mode === "h") {
      const dx = event.clientX - current.x
      if (Math.abs(dx) >= SWIPE_PX) goTo(addDays(date, dx < 0 ? 1 : -1), "swipe")
      return
    }
    const top = dragOffset ?? snaps[snap]
    const nearest = (Object.entries(snaps) as [Snap, number][]).reduce((best, entry) =>
      Math.abs(entry[1] - top) < Math.abs(best[1] - top) ? entry : best,
    )
    setSnap(nearest[0])
    setDragOffset(null)
  }
  // The pointer release after a drag must not click what it started on.
  const onSheetClickCapture = (event: React.MouseEvent) => {
    if (dragOffset !== null) event.stopPropagation()
  }

  // --- actions ---------------------------------------------------------------------------------
  /** Open the rows of one pin, or of every pin in a cluster zooming cannot
   * part, and scroll to the first of them in the list. */
  const openPins = (venueKeys: string[]) => {
    setOpenVenues(venueKeys)
    if (!desktop && snap === "peek") setSnap("half")
    const keys = new Set(venueKeys)
    const first = sections.placed.find((item) => item.venueKey && keys.has(item.venueKey))
    if (!first) return
    // After the sheet has moved and the row has opened.
    window.requestAnimationFrame(() => {
      document
        .getElementById(`map-row-${first.kind}-${first.key}`)
        ?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
    })
  }
  const showOnMap = (item: MapItem) => {
    if (!item.venueKey) return
    setOpenVenues([item.venueKey])
    setFocus((last) => ({ id: item.venueKey as string, seq: (last?.seq ?? 0) + 1 }))
    if (!desktop) setSnap("peek")
  }
  const setShow = (values: string[]) => {
    const events = values.includes("events")
    const talks = values.includes("talks")
    if (!events && !talks) return
    const show: MapShow = events && talks ? "all" : events ? "events" : "talks"
    apply({ ...state, show })
  }

  // --- words -----------------------------------------------------------------------------------
  const relative =
    relativeDay(date, today) ?? (date === addDays(today, -1) ? "Yesterday" : undefined)
  const dateText = formatDayShort(date)
  const past = now >= bounds.to
  const counts =
    week?.map(({ date: stripDate, events, talks }) => ({
      date: stripDate,
      count: (state.show === "talks" ? 0 : events) + (state.show === "events" ? 0 : talks),
    })) ?? Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekStart, i), count: 0 }))
  const noun: [string, string] =
    state.show === "events"
      ? ["event", "events"]
      : state.show === "talks"
        ? ["talk", "talks"]
        : ["event or talk", "events and talks"]
  const films = sections.films.length
  // Films with no screening venue have no pin: the line says so.
  const filmPhrase =
    films === 0 ? "" : `, ${films === 1 ? "one film" : `${films} films`} with no screening venue`
  const summary =
    day === undefined
      ? "Loading…"
      : items.length === 0
        ? `Nothing listed${past ? "" : " yet"}.`
        : `${countPhrase(items)}${pins.length > 0 ? ` at ${pins.length} ${pins.length === 1 ? "place" : "places"}` : ""}${filmPhrase}${past ? ", all ended" : ""}.`
  const toggleValue = state.show === "all" ? ["events", "talks"] : [state.show]

  const statusOf = (item: MapItem): MapStatus => itemStatus(item, now, bounds)
  const row = (item: MapItem) => {
    const venue = item.venueKey ? venues.get(item.venueKey) : undefined
    const pin = item.venueKey ? pinByVenue.get(item.venueKey) : undefined
    // A far venue (an away fixture, a town abroad) has no pin: its directions
    // are the way to find it, even when only its town is known.
    const away = farAway(venue)
    const directions =
      venue &&
      venue.lat !== undefined &&
      venue.lng !== undefined &&
      (item.precision !== "area" || away)
        ? directionsHref(
            {
              name: venue.name,
              address: venue.address,
              lat: venue.lat,
              lng: venue.lng,
              googlePlaceId: venue.googlePlaceId,
            },
            userAgent,
          )
        : undefined
    return (
      <li key={itemId(item)}>
        <MapItemRow
          item={item}
          day={date}
          status={statusOf(item)}
          open={pin !== undefined && openVenues.includes(pin.venueKey)}
          pointed={pin !== undefined && (hoveredPins?.includes(pin.venueKey) ?? false)}
          address={venue?.address}
          showAddress={away}
          directions={directions}
          pinCount={pin?.items.length}
          onShow={pin ? () => showOnMap(item) : undefined}
          onPoint={(pointing) =>
            setPointedVenue((last) =>
              pointing ? (pin?.venueKey ?? null) : last === pin?.venueKey ? null : last,
            )
          }
          onOpenPage={() => track("map_item_opened", { kind: item.kind })}
        />
      </li>
    )
  }

  return (
    <div
      ref={frame}
      className="relative h-[calc(100dvh-var(--site-header-height,4rem))] min-h-[32rem] overflow-clip lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] lg:grid-rows-[minmax(0,1fr)]"
    >
      <div className="absolute inset-0 lg:static lg:h-full">
        <DayMapCanvas
          pins={canvasPins}
          active={pointedVenue ?? hoveredPins?.[0] ?? null}
          selected={openVenues}
          onSelect={openPins}
          onHover={setHoveredPins}
          focus={focus}
          fitKey={viewKey}
          padding={
            desktop || !measured
              ? undefined
              : {
                  top: 64,
                  right: 64,
                  left: 40,
                  bottom: Math.max(48, frameHeight - snaps.peek + 24),
                }
          }
          label={`Map of ${countPhrase(items) || "nothing"} ${relative ? `${relative.toLowerCase()}, ` : "on "}${dateText}. The list beside it has every item.`}
        />
      </div>

      <aside
        aria-label="The day’s events and talks"
        onClickCapture={onSheetClickCapture}
        style={
          measured && !desktop
            ? ({ "--sheet-y": `${sheetTop}px` } as React.CSSProperties)
            : undefined
        }
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex h-full flex-col rounded-t-2xl border-t bg-background shadow-[0_-8px_24px_-12px_color-mix(in_oklab,var(--foreground)_25%,transparent)]",
          "max-lg:translate-y-[var(--sheet-y,calc(100%-17rem))]",
          dragOffset === null &&
            "transition-transform duration-300 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none",
          "lg:static lg:min-h-0 lg:rounded-none lg:border-t-0 lg:border-l lg:shadow-none",
        )}
      >
        <div
          ref={sheetHead}
          onPointerDown={onSheetDown}
          onPointerMove={onSheetMove}
          onPointerUp={onSheetUp}
          onPointerCancel={() => {
            drag.current = null
            setDragOffset(null)
          }}
          className="flex shrink-0 flex-col gap-3 border-b px-4 pt-2 pb-3 max-lg:touch-none sm:px-5 lg:pt-5"
        >
          <button
            type="button"
            onClick={() => setSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "peek")}
            aria-label={snap === "full" ? "Lower the list" : "Raise the list"}
            className="mx-auto -my-2 flex h-11 w-20 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
          >
            <span aria-hidden className="h-1 w-10 rounded-full bg-input" />
          </button>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-mono text-[0.6875rem] font-medium tracking-[0.14em] text-events uppercase">
              <span aria-hidden className="h-px w-6 bg-events" />
              Map
            </p>
            <ToggleGroup
              type="multiple"
              value={toggleValue}
              onValueChange={setShow}
              aria-label="Show"
              className="shrink-0 rounded-full border bg-card p-0.5"
            >
              <ToggleGroupItem
                value="events"
                className="h-11 rounded-full px-3 text-[13px] data-[state=on]:bg-foreground data-[state=on]:text-background sm:h-8"
              >
                <span aria-hidden className="size-2 rounded-full bg-brand" />
                Events
              </ToggleGroupItem>
              <ToggleGroupItem
                value="talks"
                className="h-11 rounded-full px-3 text-[13px] data-[state=on]:bg-foreground data-[state=on]:text-background sm:h-8"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-[2px] bg-foreground ring-1 ring-background"
                />
                Talks
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <h1 className="-mt-1 font-serif text-[1.75rem] leading-none font-normal tracking-[-0.02em] sm:text-3xl">
            What’s on where<span className="text-events">.</span>
          </h1>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goTo(addDays(date, -1), "prev")}
              aria-label="Previous day"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border bg-card transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:size-9"
            >
              <ChevronLeftIcon aria-hidden className="size-4" />
            </button>
            <h2 className="min-w-0 flex-1 px-2" aria-live="polite">
              <span className="block truncate font-serif text-xl leading-tight">
                {relative ?? dateText}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {relative ? `${dateText} · ` : ""}
                {summary}
              </span>
            </h2>
            <label className="relative inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border bg-card transition-colors duration-150 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring hover:bg-muted sm:size-9">
              <CalendarIcon aria-hidden className="size-4" />
              <span className="sr-only">Pick a day</span>
              <input
                type="date"
                value={date}
                min={addDays(today, -366)}
                max={addDays(today, 366)}
                onClick={(event) => {
                  // The field is invisible: open the picker itself (Chromium
                  // opens it only from its own, hidden, indicator).
                  try {
                    event.currentTarget.showPicker()
                  } catch {
                    // Not supported, or not from a user gesture: the field still works.
                  }
                }}
                onChange={(event) => {
                  const value = event.target.value
                  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) goTo(value, "picker")
                }}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <button
              type="button"
              onClick={() => goTo(addDays(date, 1), "next")}
              aria-label="Next day"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border bg-card transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:size-9"
            >
              <ChevronRightIcon aria-hidden className="size-4" />
            </button>
          </div>

          <WeekStrip
            days={counts}
            selected={date}
            onSelect={(next) => goTo(next, "strip")}
            today={today}
            onPrev={() => goTo(addDays(date, -7), "strip")}
            onNext={() => goTo(addDays(date, 7), "strip")}
            noun={noun}
            accent="events"
            className="[&_ol_button]:min-h-[3.5rem]"
          />
        </div>

        <div
          ref={listRef}
          aria-busy={stale}
          // On a phone the sheet is moved down by --sheet-y but keeps the
          // frame's height: the padding lets its last rows scroll into view.
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 max-lg:pb-[calc(var(--sheet-y,17rem)+1.5rem)]"
        >
          <div
            aria-hidden
            className={cn(
              "pointer-events-none sticky top-0 z-10 h-0.5 origin-left bg-events transition-[opacity,transform] duration-500 motion-reduce:transition-none",
              stale ? "scale-x-75 opacity-100" : "scale-x-0 opacity-0 duration-150",
            )}
          />
          {day !== undefined && items.length === 0 && (
            <div className="flex flex-col items-start gap-3 px-4 py-8 sm:px-5">
              <p className="font-serif text-xl">
                Nothing on the map {relative ? relative.toLowerCase() : `on ${dateText}`}
              </p>
              <p className="text-sm text-muted-foreground">
                No {noun[1]} are listed for this day. Try the next one, or another day in the strip.
              </p>
              <button
                type="button"
                onClick={() => goTo(addDays(date, 1), "next")}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-9"
              >
                Next day
                <ChevronRightIcon aria-hidden className="size-4" />
              </button>
            </div>
          )}
          {sections.placed.length > 0 && (
            <ul className="flex flex-col divide-y divide-dashed">{sections.placed.map(row)}</ul>
          )}
          {sections.away.length > 0 && (
            <section aria-labelledby="map-away" className="pt-4">
              <h2
                id="map-away"
                className="mx-4 border-t-2 border-foreground pt-2 pb-1 font-mono text-[0.6875rem] font-medium tracking-[0.14em] uppercase sm:mx-5"
              >
                Away from Cambridge · {sections.away.length}
              </h2>
              <ul className="flex flex-col divide-y divide-dashed">{sections.away.map(row)}</ul>
            </section>
          )}
          {sections.online.length > 0 && (
            <section aria-labelledby="map-online" className="pt-4">
              <h2
                id="map-online"
                className="mx-4 border-t-2 border-foreground pt-2 pb-1 font-mono text-[0.6875rem] font-medium tracking-[0.14em] uppercase sm:mx-5"
              >
                Online · {sections.online.length}
              </h2>
              <ul className="flex flex-col divide-y divide-dashed">{sections.online.map(row)}</ul>
            </section>
          )}
          {sections.films.length > 0 && (
            <section aria-labelledby="map-films" className="pt-4">
              <h2
                id="map-films"
                className="mx-4 flex items-center gap-1.5 border-t-2 border-foreground pt-2 pb-1 font-mono text-[0.6875rem] font-medium tracking-[0.14em] uppercase sm:mx-5"
              >
                <FILM_ICON aria-hidden className="size-3.5" />
                Films · {sections.films.length}
              </h2>
              <ul className="flex flex-col divide-y divide-dashed">{sections.films.map(row)}</ul>
            </section>
          )}
          {sections.tbc.length > 0 && (
            <section aria-labelledby="map-tbc" className="pt-4">
              <h2
                id="map-tbc"
                className="mx-4 border-t-2 border-foreground pt-2 pb-1 font-mono text-[0.6875rem] font-medium tracking-[0.14em] uppercase sm:mx-5"
              >
                Location TBC · {sections.tbc.length}
              </h2>
              <ul className="flex flex-col divide-y divide-dashed">{sections.tbc.map(row)}</ul>
            </section>
          )}
          <p className="px-4 pt-6 text-xs text-muted-foreground sm:px-5">
            Places are matched from each listing’s own words; check the item’s page before you go.
            Map data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap. Some places are
            placed by postcode via postcodes.io: contains OS data © Crown copyright and database
            right; contains Royal Mail data © Royal Mail copyright and database right; source:
            Office for National Statistics, licensed under the Open Government Licence v3.0.
          </p>
        </div>
      </aside>
    </div>
  )
}
