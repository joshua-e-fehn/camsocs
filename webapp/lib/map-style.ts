import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl"

/**
 * The map's style (docs/locations-and-map.md §0.7, §4): OpenFreeMap's
 * OpenMapTiles vector source (`https://tiles.openfreemap.org/planet`, the
 * source OpenFreeMap's "positron" style draws), with our own layers in the
 * River & ink palette — a quiet, light-only city map that the pins sit on.
 * Built in code rather than fetched, so no third-party style can change it;
 * only the tiles and the label fonts come from OpenFreeMap. No sprite: the
 * map draws no icons (the pins are our own markers).
 *
 * A style is JSON, so the colours are written out here; each mirrors a
 * DESIGN.md token (app/globals.css `:root`), named beside it. Never follows
 * `prefers-color-scheme` (light only).
 */

export const OPENFREEMAP = "https://tiles.openfreemap.org"

/** The tokens the style mirrors (app/globals.css). */
export const MAP_COLORS = {
  /** `--muted`: land. */
  land: "#f4f8fa",
  /** `--sky`: parks and grass. */
  park: "#e8f2f6",
  /** `--sky-line`: water. */
  water: "#d2e4eb",
  /** `--chart-4`: the river's line where it is too thin for a polygon. */
  waterLine: "#8fb9c9",
  /** `--secondary`: built-up land. */
  residential: "#f2f4f5",
  /** `--border`: buildings. */
  building: "#e3e5e6",
  /** `--input`: building outlines, road casings, railways. */
  casing: "#d5d9db",
  /** `--background`: roads. */
  road: "#ffffff",
  /** `--muted-foreground`: labels. */
  label: "#545b5e",
  /** `--foreground`: place names. */
  ink: "#111111",
} as const

/** The city (lib/events.ts `CAMBRIDGE_BOUNDS`), as [west, south, east, north]. */
export const CAMBRIDGE_BOUNDS: [number, number, number, number] = [0.03, 52.15, 0.22, 52.26]
/** How far the map may be panned: the city with a margin. */
export const MAP_MAX_BOUNDS: [number, number, number, number] = [-0.08, 52.1, 0.33, 52.31]
/** The city centre (Market Square) and the zoom a day without pins opens at. */
export const CITY_CENTRE: [number, number] = [0.1192, 52.2053]
export const CITY_ZOOM = 13.6

const POLYGON: ExpressionSpecification = [
  "match",
  ["geometry-type"],
  ["MultiPolygon", "Polygon"],
  true,
  false,
]
const LINE: ExpressionSpecification = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString"],
  true,
  false,
]
const NAME: ExpressionSpecification = [
  "coalesce",
  ["get", "name:en"],
  ["get", "name:latin"],
  ["get", "name"],
]

/** The style for the map canvas (components/molecules/day-map-canvas.tsx). */
export function mapStyle(): StyleSpecification {
  const c = MAP_COLORS
  return {
    version: 8,
    name: "CAMsocs River & ink",
    glyphs: `${OPENFREEMAP}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      openmaptiles: {
        type: "vector",
        url: `${OPENFREEMAP}/planet`,
        attribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": c.land } },
      {
        id: "landuse-residential",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landuse",
        filter: ["all", POLYGON, ["==", ["get", "class"], "residential"]],
        paint: { "fill-color": c.residential },
      },
      {
        id: "park",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        filter: POLYGON,
        paint: { "fill-color": c.park },
      },
      {
        id: "landcover-green",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: [
          "all",
          POLYGON,
          ["match", ["get", "class"], ["grass", "wood", "farmland"], true, false],
        ],
        paint: { "fill-color": c.park, "fill-opacity": 0.7 },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        filter: ["all", POLYGON, ["!=", ["get", "brunnel"], "tunnel"]],
        paint: { "fill-color": c.water },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        filter: LINE,
        paint: {
          "line-color": c.waterLine,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.6, 17, 2],
        },
      },
      {
        id: "building",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": c.building, "fill-outline-color": c.casing },
      },
      {
        id: "railway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 12,
        filter: ["all", LINE, ["==", ["get", "class"], "rail"]],
        paint: {
          "line-color": c.casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 18, 3],
        },
      },
      {
        id: "road-path",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 14,
        filter: ["all", LINE, ["==", ["get", "class"], "path"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.casing,
          "line-dasharray": [2, 2],
          "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 18, 1.6],
        },
      },
      {
        id: "road-minor-casing",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 13,
        filter: ["all", LINE, ["match", ["get", "class"], ["minor", "service"], true, false]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.building,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 13, 1.5, 18, 14],
        },
      },
      {
        id: "road-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 13,
        filter: ["all", LINE, ["match", ["get", "class"], ["minor", "service"], true, false]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.road,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 13, 0.8, 18, 12],
        },
      },
      {
        id: "road-major-casing",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: [
          "all",
          LINE,
          [
            "match",
            ["get", "class"],
            ["primary", "secondary", "tertiary", "trunk", "motorway"],
            true,
            false,
          ],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.casing,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 1.5, 18, 22],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: [
          "all",
          LINE,
          [
            "match",
            ["get", "class"],
            ["primary", "secondary", "tertiary", "trunk", "motorway"],
            true,
            false,
          ],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": c.road,
          "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 10, 1, 18, 19],
        },
      },
      {
        id: "water-name",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "water_name",
        filter: LINE,
        layout: {
          "symbol-placement": "line",
          "text-field": NAME,
          "text-font": ["Noto Sans Italic"],
          "text-size": 12,
          "text-letter-spacing": 0.1,
        },
        paint: { "text-color": c.label, "text-halo-color": c.land, "text-halo-width": 1.2 },
      },
      {
        id: "road-name",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        minzoom: 14,
        filter: [
          "match",
          ["get", "class"],
          ["primary", "secondary", "tertiary", "trunk", "minor"],
          true,
          false,
        ],
        layout: {
          "symbol-placement": "line",
          "text-field": NAME,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 13],
        },
        paint: { "text-color": c.label, "text-halo-color": c.road, "text-halo-width": 1.2 },
      },
      {
        id: "place-name",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 11,
        filter: [
          "match",
          ["get", "class"],
          ["suburb", "neighbourhood", "quarter", "village", "hamlet"],
          true,
          false,
        ],
        layout: {
          "text-field": NAME,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 16, 13],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.12,
          "text-max-width": 8,
        },
        paint: { "text-color": c.label, "text-halo-color": c.land, "text-halo-width": 1.4 },
      },
      {
        id: "city-name",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        maxzoom: 13,
        filter: ["match", ["get", "class"], ["city", "town"], true, false],
        layout: {
          "text-field": NAME,
          "text-font": ["Noto Sans Bold"],
          "text-size": 15,
        },
        paint: { "text-color": c.ink, "text-halo-color": c.land, "text-halo-width": 1.6 },
      },
    ],
  }
}
