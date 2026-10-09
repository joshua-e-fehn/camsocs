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
 */
const crons = cronJobs()

crons.daily("derive-daily", { hourUTC: 3, minuteUTC: 30 }, internal.derive.daily, {})
crons.daily("retention-daily", { hourUTC: 4, minuteUTC: 15 }, internal.retention.daily, {})
crons.daily("coverage-daily", { hourUTC: 4, minuteUTC: 45 }, internal.coverage.recompute, {})

export default crons
