import { v } from "convex/values"
import { internal } from "./_generated/api"
import { internalAction, internalQuery } from "./_generated/server"
import { resubmitSitemaps } from "./lib/sitemapSubmit"
import { searchConsoleConfig } from "./lib/traffic"

/**
 * The daily sitemap resubmission (convex/lib/sitemapSubmit.ts,
 * convex/crons.ts `sitemaps-resubmit-daily`): after the morning harvest,
 * tell Search Console the sitemap index and the new-events feed changed, if
 * an event was stored since their last submission. A no-op where the
 * `GSC_*` variables are unset (dev, previews); outcomes go to the log only.
 */

/** When the newest event was first stored, or null with none. */
export const newestEventStoredAt = internalQuery({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: async (ctx) => {
    const newest = await ctx.db.query("events").order("desc").first()
    return newest?._creationTime ?? null
  },
})

export const resubmit = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const config = searchConsoleConfig()
    if (!config) return null
    const origin = (process.env.SITE_URL?.trim() || config.siteUrl).replace(/\/+$/, "")
    const newest = await ctx.runQuery(internal.searchConsole.newestEventStoredAt, {})
    const outcomes = await resubmitSitemaps(config, origin, newest, Date.now())
    for (const outcome of outcomes) {
      const line = `Sitemap ${outcome.file}: ${outcome.action}${outcome.detail ? ` (${outcome.detail})` : ""}`
      if (outcome.action === "failed") console.error(line)
      else console.log(line)
    }
    return null
  },
})
