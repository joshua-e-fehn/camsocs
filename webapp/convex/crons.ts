import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

/**
 * Scheduled jobs. Times are UTC.
 *
 *  - `derive-daily` (03:30): organisation status (dormancy after 180 days,
 *    registration lapses), events' term-week labels, and people's `stale`
 *    flags (convex/derive.ts).
 */
const crons = cronJobs()

crons.daily("derive-daily", { hourUTC: 3, minuteUTC: 30 }, internal.derive.daily, {})

export default crons
