/**
 * T15 data-quality sample (ENG-37): checks the data honesty rules (AGENTS.md,
 * data-model §1) on a reproducible random sample of listed profiles and on the
 * public calendar, the way a signed-out visitor's pages read them.
 *
 *   bun run scripts/data-quality-sample.ts                       # deployment in .env.local (dev)
 *   NEXT_PUBLIC_CONVEX_URL=https://cheerful-bandicoot-511.convex.cloud \
 *     bun run scripts/data-quality-sample.ts --size 60 --seed 2026-11-04   # production
 *
 * Read-only: public queries only (`orgs.*`, `events.list`), no token, no
 * mutation. It prints counts and the slugs of profiles that fail a check,
 * never a title, a description or any other text: the calendar it reads
 * leaves talks.cam-derived events out (`talksCam` defaults to `exclude`), and
 * a profile is passed through the talks guard (decision G1), but the output
 * stays numbers either way. Exit 1 when a hard rule fails.
 */
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import { classifyEmail } from "../convex/lib/derived"
import { FIELD_STATUSES, MISSING_REASONS } from "../lib/vocab"

const url = process.env.NEXT_PUBLIC_CONVEX_URL
if (!url) {
  console.error("NEXT_PUBLIC_CONVEX_URL is not set (run from webapp/ with .env.local present)")
  process.exit(1)
}
const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}
const size = Number(arg("--size") ?? 50)
const seed = arg("--seed") ?? new Date().toISOString().slice(0, 10)
const client = new ConvexHttpClient(url)
// biome-ignore lint/suspicious/noExplicitAny: anyApi keeps this script free of codegen types
const api = anyApi as any

type Meta = {
  status: string
  missingReason?: string
  confidence?: number
  sourceUrl?: string
  sourceType?: string
  retrievedAt?: number
  method?: string
}
type Profile = {
  org: Record<string, unknown> & { meta: Record<string, Meta>; missingFields?: string[] }
  events: { source: string; sourceUrl?: string; title: string; talksDerived: boolean }[]
}

/** mulberry32 over a string hash: the same seed draws the same sample. */
function rng(text: string) {
  let state = 0
  for (const char of text) state = (Math.imul(state, 31) + char.charCodeAt(0)) | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 86_400_000
const now = Date.now()
const SOMEONE = /(?<![\w'’])someone(?![\w'’])/i
const INTERNAL = new Set(["mailing_list_email", "manual"])
const VALUED = new Set(["found", "inferred", "owner_confirmed", "manual", "conflicting"])

// --- every listing slug (sitemap pages, ≤ 100 each) ---------------------------------------
const listings: { slug: string; indexable: boolean }[] = []
for (let cursor: string | undefined, done = false; !done; ) {
  const page = await client.query(api.orgs.sitemap, { cursor, numItems: 100 })
  for (const row of page.page) if (row.kind === "listing") listings.push(row)
  done = page.isDone
  cursor = page.continueCursor
}
const draw = rng(seed)
const pool = [...listings]
const sample: string[] = []
while (sample.length < Math.min(size, pool.length)) {
  sample.push(pool.splice(Math.floor(draw() * pool.length), 1)[0].slug)
}

// --- profile checks -----------------------------------------------------------------------
type Check = { rule: string; hard: boolean; failing: Set<string>; count: number }
const checks = new Map<string, Check>()
const fail = (rule: string, slug: string, hard = true) => {
  const check = checks.get(rule) ?? { rule, hard, failing: new Set<string>(), count: 0 }
  check.failing.add(slug)
  check.count += 1
  checks.set(rule, check)
}
const tally = { fields: 0, valued: 0, missing: 0, notApplicable: 0, internal: 0, stale30: 0 }
const statusCounts: Record<string, number> = {}
const missingReasons: Record<string, number> = {}
const eventTally = { events: 0 }
let profilesRead = 0

for (const slug of sample) {
  const profile: Profile | null = await client.query(api.orgs.getBySlug, { slug })
  if (!profile) {
    fail("sampled slug has no profile (sitemap and getBySlug disagree)", slug)
    continue
  }
  profilesRead += 1
  const { org } = profile
  // `missingFields` lists the tracked fields (data-model §6) that are missing.
  for (const field of org.missingFields ?? []) {
    if (org.meta[field]?.status !== "missing")
      fail("missingFields names a field that has a value", slug)
  }
  for (const meta of Object.values(org.meta)) {
    tally.fields += 1
    statusCounts[meta.status] = (statusCounts[meta.status] ?? 0) + 1
    if (!(FIELD_STATUSES as readonly string[]).includes(meta.status)) fail("unknown status", slug)
    if (meta.status === "missing") {
      tally.missing += 1
      const reason = meta.missingReason ?? "(none)"
      missingReasons[reason] = (missingReasons[reason] ?? 0) + 1
      if (!(MISSING_REASONS as readonly string[]).includes(reason))
        fail("missing field without a missingReason", slug)
    }
    if (meta.status === "not_applicable") tally.notApplicable += 1
    if (!VALUED.has(meta.status)) continue
    tally.valued += 1
    if (meta.retrievedAt === undefined) fail("value without a retrieval date", slug)
    else if (now - meta.retrievedAt > 30 * DAY) tally.stale30 += 1
    if (meta.confidence === undefined || meta.confidence < 0 || meta.confidence > 1)
      fail("value without a confidence in 0..1", slug)
    if (meta.sourceType === undefined) fail("value without a source type", slug)
    if (meta.sourceType !== undefined && INTERNAL.has(meta.sourceType)) tally.internal += 1
    else if (!meta.sourceUrl) fail("public value without a source URL", slug)
    if (meta.sourceUrl && /talks\.cam\.ac\.uk/i.test(meta.sourceUrl))
      fail("talks.cam source URL on a profile (G1)", slug)
    // data-model §1.1: inferred tops out below 0.75; found starts at 0.75.
    if (meta.status === "inferred" && (meta.confidence ?? 0) >= 0.75)
      fail("inferred value at found-level confidence", slug)
    // An LLM value is `found` only with a checked quote (0.75 or more).
    if (meta.status === "found" && (meta.confidence ?? 1) < 0.75)
      fail("found value below 0.75 confidence", slug)
  }
  // Personal addresses and redaction left-overs anywhere in the public projection.
  const text = JSON.stringify({ ...org, meta: undefined })
  for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
    if (classifyEmail(email) === "personal_crsid") fail("personal (CRSid) address published", slug)
  }
  for (const field of ["description", "shortDescription", "howToJoin"] as const) {
    const value = org[field]
    if (typeof value === "string" && SOMEONE.test(value))
      fail(`"someone" in ${field} (D1 fallback, read by eye)`, slug, false)
  }
  for (const event of profile.events) {
    eventTally.events += 1
    if (event.talksDerived) fail("talks.cam-derived event on a profile (G1)", slug)
    if (event.source !== "mailing_list" && !event.sourceUrl)
      fail("profile event without a source URL", slug)
    if (/^\s*someone\s*$/i.test(event.title)) fail("event titled only 'someone' (D1)", slug)
  }
}

// --- the public calendar, next 28 days (talks.cam-derived events excluded) -----------------
const from = now - (now % DAY)
const calendar: {
  source: string
  sourceUrl?: string
  title: string
  visibility: string
  talksDerived: boolean
  organisers: unknown[]
  hosting: string
  externalUrl?: string
}[] = await client.query(api.events.list, { from, to: from + 28 * DAY })
const cal = {
  events: calendar.length,
  bySource: {} as Record<string, number>,
  noSourceUrl: 0,
  talksDerived: 0,
  notPublic: 0,
  someoneTitle: 0,
  /** No listed organiser, outside the University's own programme (ENG-24). */
  noOrganiser: 0,
  takesPart: 0,
  takesPartNoUrl: 0,
}
for (const event of calendar) {
  cal.bySource[event.source] = (cal.bySource[event.source] ?? 0) + 1
  if (event.source !== "mailing_list" && !event.sourceUrl) cal.noSourceUrl += 1
  if (event.talksDerived) cal.talksDerived += 1
  if (event.visibility !== "public") cal.notPublic += 1
  if (SOMEONE.test(event.title)) cal.someoneTitle += 1
  if (event.organisers.length === 0 && event.source !== "uni_events_api") cal.noOrganiser += 1
  if (event.hosting === "takes_part") {
    cal.takesPart += 1
    if (!event.externalUrl) cal.takesPartNoUrl += 1
  }
}

// --- report ---------------------------------------------------------------------------------
const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "-")
console.log(`Deployment: ${url}`)
console.log(
  `Seed ${seed}; ${listings.length} listings, ${sample.length} sampled, ${profilesRead} read`,
)
console.log(`Thin (noindex) listings overall: ${listings.filter((row) => !row.indexable).length}`)
console.log(
  `Fields: ${tally.fields} (valued ${tally.valued}, missing ${tally.missing} = ${pct(tally.missing, tally.fields)}, not applicable ${tally.notApplicable})`,
)
console.log(`Statuses: ${JSON.stringify(statusCounts)}`)
console.log(`Missing reasons: ${JSON.stringify(missingReasons)}`)
console.log(
  `Valued fields from a private source (no URL shown): ${tally.internal}; last seen > 30 days ago: ${tally.stale30} (${pct(tally.stale30, tally.valued)})`,
)
console.log(`Profile events checked: ${eventTally.events}`)
console.log(`Calendar, next 28 days: ${JSON.stringify(cal)}`)
let hardFailures = 0
for (const check of checks.values()) {
  if (check.hard) hardFailures += check.count
  console.log(
    `${check.hard ? "FAIL" : "note"}  ${check.rule}: ${check.count} in ${check.failing.size} profiles (${[...check.failing].join(", ")})`,
  )
}
const calendarFailures = cal.noSourceUrl + cal.talksDerived + cal.notPublic
if (calendarFailures > 0)
  console.log(`FAIL  calendar: ${calendarFailures} events break a rule (above)`)
console.log(hardFailures + calendarFailures === 0 ? "All hard checks pass." : "Hard checks failed.")
process.exit(hardFailures + calendarFailures === 0 ? 0 : 1)
