"use client"

// MapLibre's structural styles only (DESIGN.md "Map canvas"): the controls
// and markers below are ours, styled with tokens.
import "maplibre-gl/dist/maplibre-gl.css"
import { MinusIcon, PlusIcon } from "lucide-react"
import type { Map as MapLibreMap, Marker } from "maplibre-gl"
import dynamic from "next/dynamic"
import { useEffect, useRef } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { CAMBRIDGE_BOUNDS, CITY_CENTRE, CITY_ZOOM, MAP_MAX_BOUNDS, mapStyle } from "@/lib/map-style"
import { cn } from "@/lib/utils"

/**
 * The map of one day (docs/locations-and-map.md §0.6, §0.7, §4): a MapLibre GL
 * canvas on OpenFreeMap's vector tiles in the River & ink style
 * (lib/map-style.ts), with one marker per venue. Generic: the caller owns the
 * pins, which one is highlighted or selected, and what a click does.
 *
 * `maplibre-gl` is imported here and nowhere else, through `next/dynamic`
 * with `ssr: false` (DESIGN.md "Map canvas", like React Flow's D10): it ships
 * in /map's chunk only and never renders on the server, where the skeleton
 * stands in.
 *
 * Pins are buttons (44 px targets) whose name says the venue, the counts and
 * whether it is on now or over, so the canvas is usable with a keyboard and
 * never colour alone; the page's list is its full text equivalent. Event pins
 * are teal circles, talk-only pins ink rounded squares, numbered when several
 * items share the venue; over is grey, on now has an apricot ring. With
 * `prefers-reduced-motion` the camera jumps instead of flying.
 */

export type DayMapPin = {
  id: string
  lat: number
  lng: number
  /** How many items share the pin (a number is drawn from 2). */
  count: number
  kind: "event" | "talk"
  status: "past" | "now" | "upcoming"
  /** The pin's accessible name: venue, counts, state. */
  label: string
}

export type DayMapCanvasProps = {
  pins: readonly DayMapPin[]
  /** The pin a list row points at (hovered or focused): raised. */
  active: string | null
  /** The open row's pin: raised and ringed in ink. */
  selected: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  /** Pan to this pin when `seq` changes (a row was opened). */
  focus: { id: string; seq: number } | null
  /** The view the pins are of (the day and the toggles): the camera fits
   * the pins again when it changes. */
  fitKey: string
  /** Room the camera leaves around the pins, in px (a bottom sheet). */
  padding?: { top: number; right: number; bottom: number; left: number }
  /** The region's accessible name. */
  label: string
  className?: string
}

const DEFAULT_PADDING = { top: 56, right: 56, bottom: 56, left: 56 }

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** The classes of a pin's visible mark (inside its 44 px button). */
function markClasses(pin: DayMapPin, raised: boolean, selected: boolean): string {
  return cn(
    "flex items-center justify-center font-mono text-[0.6875rem] font-semibold leading-none tabular-nums shadow-sm transition-transform duration-150 motion-reduce:transition-none",
    pin.count > 1 ? "size-7" : "size-5",
    pin.kind === "talk" ? "rounded-md" : "rounded-full",
    pin.status === "past"
      ? "bg-input text-faint"
      : pin.kind === "talk"
        ? "bg-foreground text-background"
        : "bg-brand text-brand-foreground",
    "ring-2 ring-background",
    pin.status === "now" && "ring-[3px] ring-today",
    selected && "outline-2 outline-offset-2 outline-foreground",
    raised && "scale-125",
  )
}

/** `padding` shrunk to leave at least 80 px of the canvas each way, so a
 * small canvas (a phone with the sheet up) can still fit the pins. */
function roomy(
  padding: { top: number; right: number; bottom: number; left: number },
  element: HTMLElement,
) {
  const scale = (total: number, room: number) => (total <= room ? 1 : Math.max(0, room) / total)
  const v = scale(padding.top + padding.bottom, element.clientHeight - 80)
  const h = scale(padding.left + padding.right, element.clientWidth - 80)
  return {
    top: padding.top * v,
    bottom: padding.bottom * v,
    left: padding.left * h,
    right: padding.right * h,
  }
}

function CanvasSkeleton() {
  return <Skeleton className="size-full min-h-64 rounded-none" />
}

export const DayMapCanvas = dynamic<DayMapCanvasProps>(
  async () => {
    const maplibre = await import("maplibre-gl")
    // The worker is a file of the package; the bundler emits it beside the
    // chunk and gives its URL (MapLibre would look next to its own module,
    // which a bundle does not keep).
    maplibre.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href)

    function Canvas({
      pins,
      active,
      selected,
      onSelect,
      onHover,
      focus,
      fitKey,
      padding = DEFAULT_PADDING,
      label,
      className,
    }: DayMapCanvasProps) {
      const container = useRef<HTMLDivElement>(null)
      const region = useRef<HTMLElement>(null)
      const mapRef = useRef<MapLibreMap | null>(null)
      const markers = useRef(new Map<string, { marker: Marker; button: HTMLButtonElement }>())
      // The latest callbacks, for listeners attached once.
      const handlers = useRef({ onSelect, onHover })
      handlers.current = { onSelect, onHover }
      // Whether the reader moved the camera since the last fit.
      const moved = useRef(false)
      const fitted = useRef<{ key: string; count: number } | null>(null)
      const paddingRef = useRef(padding)
      paddingRef.current = padding

      // The map, once.
      useEffect(() => {
        if (!container.current) return
        const map = new maplibre.Map({
          container: container.current,
          style: mapStyle(),
          center: CITY_CENTRE,
          zoom: CITY_ZOOM,
          minZoom: 11,
          maxZoom: 18.5,
          maxBounds: MAP_MAX_BOUNDS,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          fadeDuration: reducedMotion() ? 0 : 200,
        })
        // Top left, so a bottom sheet over the map never hides it.
        map.addControl(new maplibre.AttributionControl({ compact: false }), "top-left")
        map.touchZoomRotate.disableRotation()
        map.keyboard.disableRotation()
        // A reader's own gesture (not a resize or our own camera moves) stops
        // the camera following the pins as more arrive.
        const touched = () => {
          moved.current = true
        }
        const canvas = map.getCanvasContainer()
        for (const type of ["pointerdown", "wheel", "keydown", "touchstart"] as const) {
          canvas.addEventListener(type, touched, { passive: true })
        }
        // For screenshots and tests: the canvas has drawn what it has loaded.
        map.on("idle", () => {
          if (region.current) region.current.dataset.mapIdle = "true"
        })
        mapRef.current = map
        const owned = markers.current
        return () => {
          for (const { marker } of owned.values()) marker.remove()
          owned.clear()
          map.remove()
          mapRef.current = null
        }
      }, [])

      // The markers, kept in step with the pins.
      useEffect(() => {
        const map = mapRef.current
        if (!map) return
        const live = markers.current
        const ids = new Set(pins.map((pin) => pin.id))
        for (const [id, { marker }] of live) {
          if (!ids.has(id)) {
            marker.remove()
            live.delete(id)
          }
        }
        for (const pin of pins) {
          let entry = live.get(pin.id)
          if (!entry) {
            const button = document.createElement("button")
            button.type = "button"
            button.dataset.pin = pin.id
            button.className =
              "flex size-11 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            button.addEventListener("click", (event) => {
              event.stopPropagation()
              handlers.current.onSelect(pin.id)
            })
            button.addEventListener("mouseenter", () => handlers.current.onHover(pin.id))
            button.addEventListener("mouseleave", () => handlers.current.onHover(null))
            button.addEventListener("focus", () => handlers.current.onHover(pin.id))
            button.addEventListener("blur", () => handlers.current.onHover(null))
            const mark = document.createElement("span")
            mark.setAttribute("aria-hidden", "true")
            button.appendChild(mark)
            const marker = new maplibre.Marker({ element: button, anchor: "center" })
              .setLngLat([pin.lng, pin.lat])
              .addTo(map)
            entry = { marker, button }
            live.set(pin.id, entry)
          } else {
            entry.marker.setLngLat([pin.lng, pin.lat])
          }
          const raised = pin.id === active || pin.id === selected
          const { button } = entry
          button.setAttribute("aria-label", pin.label)
          button.setAttribute("aria-pressed", String(pin.id === selected))
          const mark = button.firstElementChild as HTMLElement
          mark.className = markClasses(pin, raised, pin.id === selected)
          mark.textContent = pin.count > 1 ? String(pin.count) : ""
          // Raised pins draw above their neighbours; past ones below.
          entry.marker.getElement().style.zIndex = raised ? "3" : pin.status === "past" ? "1" : "2"
        }
      }, [pins, active, selected])

      // Fit the camera to the pins for a new view, and again while more
      // arrive (the talks join after hydration) until the reader moves it.
      useEffect(() => {
        const map = mapRef.current
        if (!map) return
        const last = fitted.current
        const fresh = !last || last.key !== fitKey
        if (!fresh && (moved.current || pins.length <= last.count)) return
        if (fresh) moved.current = false
        fitted.current = { key: fitKey, count: pins.length }
        const duration = reducedMotion() || !last ? 0 : 450
        if (pins.length === 0) {
          map.easeTo({ center: CITY_CENTRE, zoom: CITY_ZOOM, duration })
          return
        }
        const bounds = new maplibre.LngLatBounds()
        for (const pin of pins) bounds.extend([pin.lng, pin.lat])
        const [west, south, east, north] = CAMBRIDGE_BOUNDS
        // A pin far outside the city would zoom the whole county in view.
        const inCity = bounds.getWest() >= west && bounds.getEast() <= east
        const inLat = bounds.getSouth() >= south && bounds.getNorth() <= north
        map.fitBounds(inCity && inLat ? bounds : [west, south, east, north], {
          padding: roomy(paddingRef.current, map.getContainer()),
          maxZoom: 16,
          duration,
        })
      }, [pins, fitKey])

      // Pan to an opened row's pin. Only a new focus moves the camera, not a
      // pin update, so the effect is keyed by `seq` alone.
      // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by `seq`
      useEffect(() => {
        const map = mapRef.current
        if (!map || !focus) return
        const pin = pins.find((candidate) => candidate.id === focus.id)
        if (!pin) return
        const zoom = Math.max(map.getZoom(), 15)
        const options = {
          center: [pin.lng, pin.lat] as [number, number],
          zoom,
          padding: roomy(padding, map.getContainer()),
        }
        if (reducedMotion()) map.jumpTo(options)
        else map.easeTo({ ...options, duration: 400 })
      }, [focus?.seq])

      const zoomBy = (delta: number) => {
        const map = mapRef.current
        if (!map) return
        map.easeTo({ zoom: map.getZoom() + delta, duration: reducedMotion() ? 0 : 200 })
      }

      return (
        <section
          ref={region}
          aria-label={label}
          className={cn(
            "relative size-full overflow-hidden bg-muted",
            // The attribution stays visible (OSM's licence asks for it), restyled.
            "[&_.maplibregl-ctrl-attrib]:bg-background/85 [&_.maplibregl-ctrl-attrib]:text-[0.6875rem] [&_.maplibregl-ctrl-attrib]:text-muted-foreground [&_.maplibregl-ctrl-attrib_a]:text-muted-foreground [&_.maplibregl-ctrl-attrib_a]:underline",
            className,
          )}
        >
          {/* Sized, not positioned: MapLibre makes its container `position: relative`. */}
          <div ref={container} className="h-full w-full" />
          <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
            <button
              type="button"
              onClick={() => zoomBy(1)}
              aria-label="Zoom in"
              className="flex size-11 items-center justify-center text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:size-9"
            >
              <PlusIcon aria-hidden className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => zoomBy(-1)}
              aria-label="Zoom out"
              className="flex size-11 items-center justify-center border-t text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:size-9"
            >
              <MinusIcon aria-hidden className="size-4" />
            </button>
          </div>
        </section>
      )
    }
    return Canvas
  },
  { ssr: false, loading: CanvasSkeleton },
)
