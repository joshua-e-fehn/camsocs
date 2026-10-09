/**
 * Measures the public read API the way a signed-out visitor's pages call it:
 * response size (JSON bytes) and wall time per query, against the deployment
 * in `NEXT_PUBLIC_CONVEX_URL` (`.env.local`, loaded by Bun).
 *
 *   bun run scripts/measure-public-api.ts            # summary table
 *   bun run scripts/measure-public-api.ts --slugs    # also suggest e2e profile slugs
 *
 * Read-only: it calls public queries only (`orgs.*`, `events.*`), never a
 * mutation, an internal function or the pipeline API, and sends no token.
 */
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { londonIsoDate, viewWindow } from "../lib/calendar"
import { DIRECTORY_PAGE_SIZE } from "../lib/url-state"

const url = process.env.NEXT_PUBLIC_CONVEX_URL
if (!url) {
  console.error("NEXT_PUBLIC_CONVEX_URL is not set (run from webapp/ with .env.local present)")
  process.exit(1)
}
const client = new ConvexHttpClient(url)
// biome-ignore lint/suspicious/noExplicitAny: anyApi keeps this script free of codegen types
const api = anyApi as any

type Row = { name: string; bytes: number; ms: number; note: string }
const rows: Row[] = []

async function measure<T>(name: string, run: () => Promise<T>, note: (value: T) => string) {
  const started = performance.now()
  const value = await run()
  const ms = performance.now() - started
  rows.push({ name, bytes: JSON.stringify(value).length, ms, note: note(value) })
  return value
}

const today = londonIsoDate(Date.now())
type Card = { slug: string; name: string; orgType?: string; level?: string; logoUrl?: string }

const firstPage = await measure(
  "orgs.list (page 1, no filter)",
  () =>
    client.query(api.orgs.list, {
      paginationOpts: { numItems: DIRECTORY_PAGE_SIZE, cursor: null },
    }),
  (value: { page: Card[] }) => `${value.page.length} cards`,
)
await measure(
  "orgs.facets (no filter)",
  () => client.query(api.orgs.facets, {}),
  (value: { total: number }) => `total ${value.total}`,
)
await measure(
  "orgs.facets (q=music)",
  () => client.query(api.orgs.facets, { q: "music" }),
  (value: { total: number }) => `total ${value.total}`,
)
await measure(
  "orgs.list (sport, page 1)",
  () =>
    client.query(api.orgs.list, {
      categories: ["sport"],
      paginationOpts: { numItems: DIRECTORY_PAGE_SIZE, cursor: null },
    }),
  (value: { page: Card[] }) => `${value.page.length} cards`,
)
await measure(
  "orgs.colleges",
  () => client.query(api.orgs.colleges, {}),
  (value: unknown[]) => `${value.length} colleges`,
)
for (const view of ["list", "week", "month"] as const) {
  const window = viewWindow(view, today)
  await measure(
    `events.list (${view})`,
    () => client.query(api.events.list, { from: window.from, to: window.to }),
    (value: unknown[]) => `${value.length} events`,
  )
}
const firstSlug = firstPage.page[0]?.slug
if (firstSlug) {
  await measure(
    `orgs.getBySlug (${firstSlug})`,
    () => client.query(api.orgs.getBySlug, { slug: firstSlug }),
    (value: { events: unknown[] } | null) => (value ? `${value.events.length} events` : "null"),
  )
}

console.log("query | bytes | ms | note")
console.log("---|---:|---:|---")
for (const row of rows) {
  console.log(`${row.name} | ${row.bytes} | ${Math.round(row.ms)} | ${row.note}`)
}

if (process.argv.includes("--slugs")) {
  // Every listed card, for picking representative profile pages.
  const cards: Card[] = []
  let cursor: string | null = null
  for (;;) {
    const page: { page: Card[]; isDone: boolean; continueCursor: string } = await client.query(
      api.orgs.list,
      { paginationOpts: { numItems: 100, cursor } },
    )
    cards.push(...page.page)
    if (page.isDone) break
    cursor = page.continueCursor
  }
  const byType = (type: string) => cards.filter((card) => card.orgType === type)
  console.log(`\n${cards.length} listed cards`)
  for (const type of ["society", "sports_club", "jcr", "mcr", "college_boat_club"]) {
    console.log(`${type}: ${byType(type).length}`)
  }
  console.log(`with logo: ${cards.filter((card) => card.logoUrl).length}`)
  console.log(`no orgType: ${cards.filter((card) => !card.orgType).length}`)
}
