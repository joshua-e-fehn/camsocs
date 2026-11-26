import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import { eventSeriesOf, type SeriesMatch, seriesSlugOf } from "./eventSeries"

export { eventSeriesOf }

/**
 * Keeps a public edition's `eventSeries` row (ENG-282): created on its first
 * edition with a slug that is never changed again, `lastStartsAt` and the
 * name moved on by later editions. A slug another series already holds gets
 * the organiser's slug (or a counter) appended, so it stays unique.
 */
export async function noteSeriesEdition(
  ctx: MutationCtx,
  series: SeriesMatch,
  event: Pick<Doc<"events">, "startsAt" | "organiserKeys">,
): Promise<void> {
  const now = Date.now()
  const row = await ctx.db
    .query("eventSeries")
    .withIndex("by_key", (i) => i.eq("key", series.key))
    .unique()
  if (row) {
    if (event.startsAt > row.lastStartsAt) {
      await ctx.db.patch("eventSeries", row._id, {
        lastStartsAt: event.startsAt,
        name: series.name,
        updatedAt: now,
      })
    }
    return
  }
  const orgKey = series.slug ? undefined : event.organiserKeys[0]
  await ctx.db.insert("eventSeries", {
    key: series.key,
    slug: await freeSlug(ctx, series.slug ?? seriesSlugOf(series.name), orgKey),
    name: series.name,
    orgKey,
    lastStartsAt: event.startsAt,
    updatedAt: now,
  })
}

async function taken(ctx: MutationCtx, slug: string): Promise<boolean> {
  const row = await ctx.db
    .query("eventSeries")
    .withIndex("by_slug", (i) => i.eq("slug", slug))
    .first()
  return row !== null
}

async function freeSlug(ctx: MutationCtx, base: string, orgKey?: string): Promise<string> {
  if (!(await taken(ctx, base))) return base
  const withOrg = orgKey ? `${base}-${orgKey.replace(/^org-/, "")}` : base
  if (!(await taken(ctx, withOrg))) return withOrg
  for (let n = 2; ; n++) {
    const candidate = `${withOrg}-${n}`
    if (!(await taken(ctx, candidate))) return candidate
  }
}
