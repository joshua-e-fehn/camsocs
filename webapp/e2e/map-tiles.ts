import type { Page } from "@playwright/test"

/**
 * /map's tiles, stubbed (docs/locations-and-map.md §4): the suite never
 * depends on tiles.openfreemap.org being reachable, and never spends its
 * bandwidth. The TileJSON is answered with OpenFreeMap's attribution and a
 * tile template on the same host; every tile and glyph range is an empty
 * protobuf (an empty tile, no glyphs), so the canvas draws its background
 * and our markers and goes idle.
 */
export async function stubMapTiles(page: Page): Promise<void> {
  await page.route("https://tiles.openfreemap.org/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/planet") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          tilejson: "3.0.0",
          tiles: ["https://tiles.openfreemap.org/stub/{z}/{x}/{y}.pbf"],
          minzoom: 0,
          maxzoom: 14,
          attribution:
            '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }),
      })
    }
    return route.fulfill({ status: 200, contentType: "application/x-protobuf", body: "" })
  })
}

/** Waits until the map canvas has drawn (MapLibre's `idle`), so a screenshot
 * is not blank; a page without one returns at once. */
export async function mapIdle(page: Page): Promise<void> {
  if ((await page.locator("[aria-label^='Map of']").count()) === 0) return
  await page.locator("[data-map-idle='true']").waitFor({ state: "attached", timeout: 30_000 })
}
