import { type Validator, v } from "convex/values"
import { internal } from "./_generated/api"
import type { MutationCtx } from "./_generated/server"
import { internalAction, internalMutation } from "./_generated/server"
import {
  fetchPostHogTraffic,
  fetchSearchConsoleTraffic,
  type PostHogTraffic,
  posthogQueryConfig,
  readSource,
  type SearchConsoleTraffic,
  type SourceResult,
  searchConsoleConfig,
} from "./lib/traffic"
import { posthogTrafficValidator, searchConsoleTrafficValidator } from "./schema"

/**
 * The broker overview's website traffic (lib/traffic.ts has what is read and
 * the env vars). `refresh` runs hourly (convex/crons.ts) and on the overview's
 * "Refresh traffic" (`broker.overview.refreshTraffic`); it reads both sources
 * at once and `store` replaces the deployment's one `trafficSnapshots` row.
 * A source that fails keeps the data of its last success, marked with the
 * failure, so a PostHog or Google outage never blanks the card.
 */

function sourceResult<T extends Validator<unknown, "required", string>>(data: T) {
  return v.union(
    v.object({ status: v.literal("ok"), data }),
    v.object({ status: v.literal("not_configured") }),
    v.object({ status: v.literal("failed"), error: v.string() }),
  )
}

export const refresh = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    const [posthog, searchConsole] = await Promise.all([
      readSource(posthogQueryConfig(), (config) => fetchPostHogTraffic(config)),
      readSource(searchConsoleConfig(), (config) => fetchSearchConsoleTraffic(config, now)),
    ])
    for (const [name, result] of [
      ["PostHog", posthog],
      ["Search Console", searchConsole],
    ] as const) {
      if (result.status === "failed") console.error(`Traffic: ${name} failed (${result.error})`)
    }
    await ctx.runMutation(internal.traffic.store, { checkedAt: now, posthog, searchConsole })
    return null
  },
})

type Stored<T> = {
  status: "ok" | "not_configured" | "failed"
  checkedAt: number
  error?: string
  fetchedAt?: number
  data?: T
}

/** A source's new state: fresh data on success, else the old data kept. */
export function mergeSource<T>(
  previous: Stored<T> | undefined,
  result: SourceResult<T>,
  checkedAt: number,
): Stored<T> {
  if (result.status === "ok") {
    return { status: "ok", checkedAt, fetchedAt: checkedAt, data: result.data }
  }
  // A source switched off drops what it had; a failed read keeps it.
  if (result.status === "not_configured") return { status: "not_configured", checkedAt }
  const kept =
    previous?.data === undefined ? {} : { fetchedAt: previous.fetchedAt, data: previous.data }
  return { status: "failed", checkedAt, error: result.error, ...kept }
}

async function current(ctx: MutationCtx) {
  return await ctx.db
    .query("trafficSnapshots")
    .withIndex("by_scope", (q) => q.eq("scope", "site"))
    .first()
}

export const store = internalMutation({
  args: {
    checkedAt: v.number(),
    posthog: sourceResult(posthogTrafficValidator),
    searchConsole: sourceResult(searchConsoleTrafficValidator),
  },
  returns: v.null(),
  handler: async (ctx, { checkedAt, posthog, searchConsole }) => {
    const previous = await current(ctx)
    const row = {
      scope: "site" as const,
      posthog: mergeSource<PostHogTraffic>(previous?.posthog, posthog, checkedAt),
      searchConsole: mergeSource<SearchConsoleTraffic>(
        previous?.searchConsole,
        searchConsole,
        checkedAt,
      ),
      computedAt: checkedAt,
    }
    if (previous) await ctx.db.replace(previous._id, row)
    else await ctx.db.insert("trafficSnapshots", row)
    return null
  },
})
