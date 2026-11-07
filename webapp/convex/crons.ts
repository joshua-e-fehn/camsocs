import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

/**
 * Scheduled jobs. Times are UTC.
 *
 *  - `derive-daily` (03:30): organisation status (dormancy after 180 days,
 *    registration lapses), events' term-week labels, and people's `stale`
 *    flags (convex/derive.ts).
 *  - `retention-daily` (04:15): the retention schedule — expired events,
 *    mail bodies and mail, people past their handover, old interactions,
 *    listing requests and run-log rows (convex/retention.ts,
 *    docs/compliance/retention.md).
 *  - `coverage-daily` (04:45): the broker overview's directory coverage, after
 *    the walks above have settled (convex/coverage.ts).
 *  - `talks-retention-daily` (04:30): talks and their details 30 days after
 *    they ended (convex/ingest/talks.ts `purgeExpired`, decision D7).
 *  - `talks-stats-daily` (00:10): the talks counts (this London week, next 28
 *    days, per department), which move with the day even when no run came
 *    (`refreshStats`; a finished sweep refreshes them too).
 *  - `traffic-hourly` (:20): the broker overview's website traffic from
 *    PostHog and Search Console (convex/traffic.ts); a no-op read where their
 *    env vars are unset.
 *  - `sitemaps-resubmit-daily` (06:10): after the 04:30 events harvest has
 *    loaded, submits the sitemap index and `/events.atom` to Search Console
 *    when an event was stored since their last submission, or weekly
 *    (convex/searchConsole.ts); a no-op where the `GSC_*` vars are unset.
 */
const crons = cronJobs()

crons.daily("derive-daily", { hourUTC: 3, minuteUTC: 30 }, internal.derive.daily, {})
crons.daily("retention-daily", { hourUTC: 4, minuteUTC: 15 }, internal.retention.daily, {})
crons.daily("coverage-daily", { hourUTC: 4, minuteUTC: 45 }, internal.coverage.recompute, {})
crons.daily(
  "talks-retention-daily",
  { hourUTC: 4, minuteUTC: 30 },
  internal.ingest.talks.purgeExpired,
  {},
)
crons.daily(
  "talks-stats-daily",
  { hourUTC: 0, minuteUTC: 10 },
  internal.ingest.talks.refreshStatsDaily,
  {},
)

crons.hourly("traffic-hourly", { minuteUTC: 20 }, internal.traffic.refresh, {})
crons.daily(
  "sitemaps-resubmit-daily",
  { hourUTC: 6, minuteUTC: 10 },
  internal.searchConsole.resubmit,
  {},
)

export default crons
