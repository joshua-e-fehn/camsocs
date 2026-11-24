"use client"

// MapLibre's structural styles only (DESIGN.md "Map canvas"): the controls
// and markers below are ours, styled with tokens.
import "maplibre-gl/dist/maplibre-gl.css"
import { MinusIcon, PlusIcon } from "lucide-react"
import type { Map as MapLibreMap, Marker } from "maplibre-gl"
import dynamic from "next/dynamic"
import { useEffect, useMemo, useRef, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { ITEM_ICONS, type ItemIconKey } from "@/lib/item-icons"
import { clusterLook, clusterPins, type PinCluster, sameSpot } from "@/lib/map-cluster"
import { CAMBRIDGE_BOUNDS, CITY_CENTRE, CITY_ZOOM, MAP_MAX_BOUNDS, mapStyle } from "@/lib/map-style"
import { cn } from "@/lib/utils"

/**
 * The map of one day (docs/locations-and-map.md §0.6, §0.7, §4): a MapLibre GL
 * canvas on OpenFreeMap's vector tiles in the River & ink style
 * (lib/map-style.ts), with one marker per venue. Generic: the caller owns the
 * pins, which are highlighted or selected, and what a click does.
 *
 * Venues drawn within 36 px of each other at the current zoom merge into one
 * cluster bubble (lib/map-cluster.ts, regrouped when a move or zoom ends) so a
 * busy day in the centre stays readable and the DOM holds few markers. A
 * cluster shows its items' total, keeps the pins' colour rules (ink when all
 * talks, else teal; the Now ring if any is on now; grey when all are over)
 * and has a soft halo. Activating it zooms to its members; at the closest
 * zoom, or when they share one spot, it hands all of them to `onSelect`
 * instead (the list opens their rows).
 *
 * `maplibre-gl` is imported here and nowhere else, through `next/dynamic`
 * with `ssr: false` (DESIGN.md "Map canvas", like React Flow's D10): it ships
 * in /map's chunk only and never renders on the server, where the skeleton
 * stands in.
 *
 * A pin of one item carries its type's icon (decorative: the name and the
 * list say the type); a pin of several, and a cluster, its number.
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
  /** A lone item's type icon (lib/item-icons.ts), drawn in white inside the
   * pin; a pin of several items shows their number instead. */
  icon?: ItemIconKey
}

export type DayMapCanvasProps = {
  pins: readonly DayMapPin[]
  /** The pin a list row points at (hovered or focused): it, or the cluster
   * holding it, is raised. */
  active: string | null
  /** The open rows' pins: raised and ringed in ink (or their cluster). */
  selected: readonly string[]
  /** A pin, or the members of a cluster zooming cannot part, was activated. */
  onSelect: (ids: string[]) => void
  /** The pointer or focus is on a pin or cluster (its pins' ids), or left. */
  onHover: (ids: string[] | null) => void
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

/** The closest zoom the map allows. */
const MAX_ZOOM = 18.5
/** The initial fit never comes closer than this (a day all in the centre
 * opens on the centre, streets still in view). */
const FIT_MAX_ZOOM = 15
/** How long after a move ends the markers regroup. */
const REGROUP_MS = 80

/** [west, south, east, north]. */
type Region = [number, number, number, number]

/** Whether a marker is inside `region` (everywhere, before the first move ends). */
function inRegion(region: Region | null, at: { lat: number; lng: number }): boolean {
  if (!region) return true
  const [west, south, east, north] = region
  return at.lng >= west && at.lng <= east && at.lat >= south && at.lat <= north
}

type Look = Pick<DayMapPin, "count" | "kind" | "status"> & { cluster: boolean }

/** The classes of a pin's or a cluster's visible mark (inside its 44 px button). */
function markClasses(pin: Look, raised: boolean, selected: boolean): string {
  return cn(
    "flex items-center justify-center font-mono text-[0.6875rem] font-semibold leading-none tabular-nums shadow-sm transition-transform duration-150 motion-reduce:transition-none",
    pin.cluster ? "size-8" : pin.count > 1 ? "size-7" : "size-5",
    pin.kind === "talk" ? "rounded-md" : "rounded-full",
    pin.status === "past"
      ? "bg-input text-faint"
      : pin.kind === "talk"
        ? "bg-foreground text-background"
        : "bg-brand text-brand-foreground",
    // A cluster's halo: several places, not one.
    pin.cluster &&
      (pin.status === "past"
        ? "shadow-[0_0_0_6px_color-mix(in_oklab,var(--input)_55%,transparent)]"
        : pin.kind === "talk"
          ? "shadow-[0_0_0_6px_color-mix(in_oklab,var(--foreground)_22%,transparent)]"
          : "shadow-[0_0_0_6px_color-mix(in_oklab,var(--brand)_28%,transparent)]"),
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
      // The type icons, rendered once and hidden: a marker (plain DOM that
      // MapLibre owns) takes a copy of its item's.
      const sprite = useRef<HTMLDivElement>(null)
      const mapRef = useRef<MapLibreMap | null>(null)
      // Each drawn marker, with its cluster's first pin (to find where focus
      // goes when the marker is regrouped away).
      const markers = useRef(
        new Map<string, { marker: Marker; button: HTMLButtonElement; first: string }>(),
      )
      // Whether the reader moved the camera since the last fit.
      const moved = useRef(false)
      const fitted = useRef<{ key: string; count: number } | null>(null)
      const paddingRef = useRef(padding)
      paddingRef.current = padding
      // The zoom the markers are grouped at and the region they are drawn
      // in (the view and half of it again each way), set when a move ends.
      const [view, setView] = useState<{ zoom: number; region: Region | null }>({
        zoom: CITY_ZOOM,
        region: null,
      })
      const zoom = view.zoom
      const clusters = useMemo(() => clusterPins(pins, zoom), [pins, zoom])
      const clusterById = useRef(new Map<string, PinCluster<DayMapPin>>())
      clusterById.current = new Map(clusters.map((cluster) => [cluster.id, cluster]))
      // Only markers near the view are in the DOM.
      const drawn = useMemo(
        () => clusters.filter((cluster) => inRegion(view.region, cluster)),
        [clusters, view.region],
      )

      /** A marker was activated: select a lone pin; zoom to a cluster's
       * members, or select them all when zooming cannot part them. */
      const activate = (id: string) => {
        const map = mapRef.current
        const cluster = clusterById.current.get(id)
        if (!map || !cluster) return
        const ids = cluster.members.map((pin) => pin.id)
        if (ids.length === 1) {
          onSelect(ids)
          return
        }
        if (map.getZoom() >= MAX_ZOOM - 0.25 || sameSpot(cluster.members)) {
          onSelect(ids)
          return
        }
        const bounds = new maplibre.LngLatBounds()
        for (const pin of cluster.members) bounds.extend([pin.lng, pin.lat])
        const camera = map.cameraForBounds(bounds, {
          padding: roomy(paddingRef.current, map.getContainer()),
          maxZoom: MAX_ZOOM,
        })
        const options = {
          center: camera?.center ?? bounds.getCenter(),
          // At least one step closer, so a click always parts something.
          zoom: Math.min(MAX_ZOOM, Math.max(camera?.zoom ?? 0, map.getZoom() + 1)),
        }
        moved.current = true
        if (reducedMotion()) map.jumpTo(options)
        else map.easeTo({ ...options, duration: 450 })
      }
      // The latest callbacks, for listeners attached once.
      const handlers = useRef({ activate, onHover })
      handlers.current = { activate, onHover }

      // The map, once.
      useEffect(() => {
        if (!container.current) return
        const map = new maplibre.Map({
          container: container.current,
          style: mapStyle(),
          center: CITY_CENTRE,
          zoom: CITY_ZOOM,
          minZoom: 11,
          maxZoom: MAX_ZOOM,
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
        // Regroup the markers once a move or zoom has settled (the groups
        // depend on the zoom alone; a pan only changes which are drawn).
        let timer: number | undefined
        const regroup = () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            const next = map.getZoom()
            const bounds = map.getBounds()
            const dx = (bounds.getEast() - bounds.getWest()) / 2
            const dy = (bounds.getNorth() - bounds.getSouth()) / 2
            const region: Region = [
              bounds.getWest() - dx,
              bounds.getSouth() - dy,
              bounds.getEast() + dx,
              bounds.getNorth() + dy,
            ]
            setView((last) => ({
              zoom: Math.abs(last.zoom - next) < 0.01 ? last.zoom : next,
              region,
            }))
          }, REGROUP_MS)
        }
        map.on("moveend", regroup)
        regroup()
        // For screenshots and tests: the canvas has drawn what it has loaded.
        map.on("idle", () => {
          if (region.current) region.current.dataset.mapIdle = "true"
        })
        mapRef.current = map
        const owned = markers.current
        return () => {
          window.clearTimeout(timer)
          for (const { marker } of owned.values()) marker.remove()
          owned.clear()
          map.remove()
          mapRef.current = null
        }
      }, [])

      // The markers, kept in step with the clusters near the view.
      useEffect(() => {
        const map = mapRef.current
        if (!map) return
        const live = markers.current
        const ids = new Set(drawn.map((cluster) => cluster.id))
        // A removed node gets no mouseleave or blur, so a marker regrouped
        // away under the pointer or focus (a cluster just activated) clears
        // the hover itself; keyboard focus moves to the marker that now holds
        // its first pin instead of falling to the page.
        let refocus: string | null = null
        for (const [id, { marker, button, first }] of live) {
          if (!ids.has(id)) {
            const focused = document.activeElement === button
            if (focused || button.matches(":hover")) handlers.current.onHover(null)
            if (focused && button.matches(":focus-visible")) refocus = first
            marker.remove()
            live.delete(id)
          }
        }
        const chosen = new Set(selected)
        for (const cluster of drawn) {
          let entry = live.get(cluster.id)
          if (!entry) {
            const id = cluster.id
            const button = document.createElement("button")
            button.type = "button"
            button.dataset.pin = id
            button.className =
              "flex size-11 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
            const members = () => clusterById.current.get(id)?.members.map((pin) => pin.id) ?? null
            button.addEventListener("click", (event) => {
              event.stopPropagation()
              handlers.current.activate(id)
            })
            button.addEventListener("mouseenter", () => handlers.current.onHover(members()))
            button.addEventListener("mouseleave", () => handlers.current.onHover(null))
            button.addEventListener("focus", () => handlers.current.onHover(members()))
            button.addEventListener("blur", () => handlers.current.onHover(null))
            const mark = document.createElement("span")
            mark.setAttribute("aria-hidden", "true")
            button.appendChild(mark)
            const marker = new maplibre.Marker({ element: button, anchor: "center" })
              .setLngLat([cluster.lng, cluster.lat])
              .addTo(map)
            entry = { marker, button, first: cluster.members[0]?.id ?? id }
            live.set(id, entry)
          } else {
            entry.marker.setLngLat([cluster.lng, cluster.lat])
            entry.first = cluster.members[0]?.id ?? cluster.id
          }
          const lone = cluster.members.length === 1 ? cluster.members[0] : null
          const look: Look & { label: string } = lone
            ? { ...lone, cluster: false }
            : {
                ...clusterLook(
                  cluster.members,
                  zoom >= MAX_ZOOM - 0.25 || sameSpot(cluster.members) ? "list" : "zoom",
                ),
                cluster: true,
              }
          const isSelected = cluster.members.some((pin) => chosen.has(pin.id))
          const raised = isSelected || cluster.members.some((pin) => pin.id === active)
          const { button } = entry
          button.setAttribute("aria-label", look.label)
          if (lone) button.setAttribute("aria-pressed", String(isSelected))
          else button.removeAttribute("aria-pressed")
          button.dataset.cluster = lone ? "" : String(cluster.members.length)
          const mark = button.firstElementChild as HTMLElement
          mark.className = markClasses(look, raised, isSelected)
          const icon = !look.cluster && look.count === 1 ? lone?.icon : undefined
          const glyph = icon
            ? sprite.current?.querySelector(`[data-icon="${icon}"]`)?.cloneNode(true)
            : undefined
          if (glyph) mark.replaceChildren(glyph)
          else mark.textContent = look.cluster || look.count > 1 ? String(look.count) : ""
          // Raised markers draw above their neighbours; past ones below.
          entry.marker.getElement().style.zIndex = raised ? "3" : look.status === "past" ? "1" : "2"
        }
        // Tab order follows the list: markers are created as clusters change
        // and MapLibre appends each, so put them back in `drawn` order (each
        // cluster's first pin's place in the list). Moving a node can drop
        // its focus, which is given back.
        const elements = drawn.flatMap((cluster) => {
          const element = live.get(cluster.id)?.marker.getElement()
          return element ? [element] : []
        })
        const parent = elements[0]?.parentElement
        if (parent) {
          const wanted = new Set<Element>(elements)
          const order = Array.from(parent.children).filter((child) => wanted.has(child))
          if (order.some((child, index) => child !== elements[index])) {
            const focused = document.activeElement
            for (const element of elements) parent.appendChild(element)
            if (focused instanceof HTMLElement && document.activeElement !== focused) {
              focused.focus({ preventScroll: true })
            }
          }
        }
        if (refocus !== null) {
          const holder = drawn.find((cluster) => cluster.members.some((pin) => pin.id === refocus))
          if (holder) live.get(holder.id)?.button.focus({ preventScroll: true })
        }
      }, [drawn, zoom, active, selected])

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
        // The pins in the city; one in a village nearby would zoom the whole
        // district into view, so it is fitted only when no pin is in the city.
        const [west, south, east, north] = CAMBRIDGE_BOUNDS
        const inCity = pins.filter(
          (pin) => pin.lng >= west && pin.lng <= east && pin.lat >= south && pin.lat <= north,
        )
        const bounds = new maplibre.LngLatBounds()
        for (const pin of inCity.length > 0 ? inCity : pins) bounds.extend([pin.lng, pin.lat])
        map.fitBounds(bounds, {
          padding: roomy(paddingRef.current, map.getContainer()),
          maxZoom: FIT_MAX_ZOOM,
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
        const zoom = Math.max(map.getZoom(), 16)
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
          <div ref={sprite} hidden>
            {(Object.entries(ITEM_ICONS) as [ItemIconKey, (typeof ITEM_ICONS)[ItemIconKey]][]).map(
              ([key, Icon]) => (
                <Icon key={key} data-icon={key} aria-hidden strokeWidth={2.5} className="size-3" />
              ),
            )}
          </div>
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
