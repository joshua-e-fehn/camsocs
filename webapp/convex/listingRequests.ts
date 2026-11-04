import { ConvexError, v } from "convex/values"
import { sha1Hex } from "../lib/hash"
import { CONTACT_EMAIL } from "../lib/site"
import { LISTING_REQUEST_KINDS, requestNeedsListing } from "../lib/vocab"
import { internal } from "./_generated/api"
import { type MutationCtx, mutation } from "./_generated/server"
import { isEmail } from "./lib/fields"
import { secretEquals } from "./lib/secrets"
import { literalUnion } from "./lib/validators"

/**
 * The public claim / correct / remove / object / add form (PLAN §2.3).
 *
 * `submit` only *stores* a request in `listingRequests` (internal: never
 * returned by a public query). Review and any resulting change happen in the
 * admin area (T12), where an accepted correction becomes a `fieldClaims` row
 * with `method: "owner_submitted"` — never a direct edit.
 *
 * Abuse limits (ENG-35). `submit` is a public mutation, so a script can call
 * it directly and skip the form's honeypot; the limits are what stop a flood.
 * Every string is length-limited, and an accepted request must fit, in order:
 *
 *  1. **its address**: `PER_EMAIL_PER_HOUR` an hour, `PER_EMAIL_PER_DAY` a
 *     day. The address is unverified, so this only slows one sender down;
 *  2. **its listing**: `PER_LISTING_PER_HOUR` an hour and
 *     `PER_LISTING_PER_DAY` a day, per budget, so a flood aimed at one
 *     listing stays on that listing and cannot use up everyone's budget;
 *  3. **its budget overall**: claims, corrections and additions share
 *     `GLOBAL_PER_HOUR` / `GLOBAL_PER_DAY`; removals and objections, the
 *     GDPR route, have their own `REMOVAL_PER_HOUR` / `REMOVAL_PER_DAY`, so
 *     a flood of the others never shuts them out. A listing's first
 *     `LISTING_RESERVE_PER_DAY` requests of a budget in a day may go past
 *     the budget's cap, by up to `RESERVE_PER_HOUR` an hour and
 *     `RESERVE_PER_DAY` a day in all: a flood spread over the site still
 *     leaves the listings it did not reach open to their own societies, up
 *     to that ceiling, and a flood of every listing's reserved requests
 *     stops there too, so the hourly total never passes the caps plus the
 *     reserve (without it, some 1,800 listings at 2 each could take 7,000
 *     requests in one hour).
 *
 * Counts read `listingRequestSubmits`, a stamp per accepted request with no
 * address or text (pruned after a day), never the requests themselves: a
 * request can hold 60 KB of proposed fields, and a count over a thousand of
 * them would pass Convex's read limit and fail every submission. A refused
 * request is never stamped, as it is never stored. The submitter's address
 * is not verified (the broker inbox says so): nothing here acts on a
 * request; the broker replies to the address before hiding a listing.
 *
 * Refusals are `ConvexError`s carrying the user-readable message as `data`:
 * a production deployment replaces a plain `Error`'s message with "Server
 * Error", and the form must be able to say what was wrong.
 *
 * The form's own route (ENG-37). The form posts to the site's
 * `/api/request` (app/api/request/route.ts), which runs Vercel BotID's check
 * and then calls `submit` with `formSecret`. Once `REQUEST_FORM_SECRET` is set
 * on a deployment, a call without that secret is refused, so a script can no
 * longer skip the bot check by calling the mutation directly; unset (dev, the
 * tests, a deployment before the rollout in docs/deploy.md), every call is
 * accepted as before. The limits above apply either way.
 *
 * An accepted request is counted in PostHog by kind only
 * (`listing_request_received`, `analytics.captureListingRequest`, ENG-7,
 * record of processing P6/P12): scheduled with the insert, so a refusal is
 * never counted, and the count can never fail the submission.
 */

export const PER_EMAIL_PER_HOUR = 5
export const PER_EMAIL_PER_DAY = 20
export const PER_LISTING_PER_HOUR = 10
export const PER_LISTING_PER_DAY = 20
export const LISTING_RESERVE_PER_DAY = 2
export const RESERVE_PER_HOUR = 100
export const RESERVE_PER_DAY = 300
export const GLOBAL_PER_HOUR = 200
export const GLOBAL_PER_DAY = 600
export const REMOVAL_PER_HOUR = 300
export const REMOVAL_PER_DAY = 1_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PRUNE_BATCH = 50

/** Requests that ask for a listing to come down: their own budget. */
const REMOVAL_KINDS: readonly Kind[] = ["remove", "object"]
type Kind = (typeof LISTING_REQUEST_KINDS)[number]
type Budget = "removal" | "other"

/** Where the form's refusals point instead: the address beside it (D4). */
const OR_WRITE = CONTACT_EMAIL ? `, or write to ${CONTACT_EMAIL}` : ""

/** Whether `times` (stamps from the last day, at most `perDay` of them) leave
 * room for one more under both caps. */
function hasRoom(times: number[], now: number, perHour: number, perDay: number): boolean {
  if (times.length >= perDay) return false
  return times.filter((at) => at > now - HOUR_MS).length < perHour
}

/** When this budget was used in the last day, on `orgKey` if given, counted
 * up to `cap`. */
async function stampsSince(
  ctx: MutationCtx,
  budget: Budget,
  since: number,
  cap: number,
  orgKey?: string,
): Promise<number[]> {
  const rows =
    orgKey === undefined
      ? await ctx.db
          .query("listingRequestSubmits")
          .withIndex("by_budget_submittedAt", (q) =>
            q.eq("budget", budget).gt("submittedAt", since),
          )
          .take(cap)
      : await ctx.db
          .query("listingRequestSubmits")
          .withIndex("by_orgKey_budget_submittedAt", (q) =>
            q.eq("orgKey", orgKey).eq("budget", budget).gt("submittedAt", since),
          )
          .take(cap)
  return rows.map((row) => row.submittedAt)
}

/** Refuses the request with a message the form shows, or returns when it
 * fits every limit (the order is the module docstring's). */
async function checkLimits(
  ctx: MutationCtx,
  { email, orgKey, budget, now }: { email: string; orgKey?: string; budget: Budget; now: number },
) {
  const fromEmail = await ctx.db
    .query("listingRequests")
    .withIndex("by_submitter_createdAt", (q) =>
      q.eq("submitterEmail", email).gt("createdAt", now - DAY_MS),
    )
    .take(PER_EMAIL_PER_DAY)
  if (
    !hasRoom(
      fromEmail.map((row) => row.createdAt),
      now,
      PER_EMAIL_PER_HOUR,
      PER_EMAIL_PER_DAY,
    )
  ) {
    throw new ConvexError(
      fromEmail.length >= PER_EMAIL_PER_DAY
        ? "Too many requests from this address today; please try again tomorrow"
        : "Too many requests from this address; please try again in an hour",
    )
  }

  let reserved = false
  if (orgKey !== undefined) {
    const onListing = await stampsSince(ctx, budget, now - DAY_MS, PER_LISTING_PER_DAY, orgKey)
    if (!hasRoom(onListing, now, PER_LISTING_PER_HOUR, PER_LISTING_PER_DAY)) {
      throw new ConvexError(
        `This listing has had a lot of requests recently; please try again later${OR_WRITE}`,
      )
    }
    reserved = onListing.length < LISTING_RESERVE_PER_DAY
  }

  const [capHour, capDay] =
    budget === "removal" ? [REMOVAL_PER_HOUR, REMOVAL_PER_DAY] : [GLOBAL_PER_HOUR, GLOBAL_PER_DAY]
  // A reserved request may use the headroom above the cap, never more.
  const [perHour, perDay] = reserved
    ? [capHour + RESERVE_PER_HOUR, capDay + RESERVE_PER_DAY]
    : [capHour, capDay]
  const overall = await stampsSince(ctx, budget, now - DAY_MS, perDay)
  if (!hasRoom(overall, now, perHour, perDay)) {
    throw new ConvexError(`The form is busy; please try again later${OR_WRITE}`)
  }
}

/** An event's key (lib/keys.ts `eventKey`). */
const EVENT_KEY = /^evt-[0-9a-f]{40}$/

const LIMITS = {
  email: 254,
  role: 100,
  message: 5_000,
  fieldName: 60,
  fieldValue: 2_000,
  fields: 30,
}

export const submit = mutation({
  args: {
    kind: literalUnion(LISTING_REQUEST_KINDS),
    /** The listing concerned; omit for `add`, optional for a correction
     * about an event (`requestNeedsListing`). */
    orgKey: v.optional(v.string()),
    submitterEmail: v.string(),
    /** e.g. "President". */
    role: v.optional(v.string()),
    message: v.string(),
    /** Proposed corrections: field name → proposed value. */
    fields: v.optional(v.record(v.string(), v.string())),
    /** The event concerned (`evt-…`), from an event page's correction link;
     * never with `add`, which has no events yet. A University listing has no
     * host, so a correction of it may name no listing (event-correction-link,
     * event-correction-no-org). It must be a stored event's. */
    eventKey: v.optional(v.string()),
    /** `REQUEST_FORM_SECRET`, sent only by the site's `/api/request` route. */
    formSecret: v.optional(v.string()),
  },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    const expected = process.env.REQUEST_FORM_SECRET
    if (expected && !(await secretEquals(args.formSecret ?? "", expected))) {
      throw new ConvexError(`Please send your request through the form on our site${OR_WRITE}`)
    }
    const email = args.submitterEmail.trim().toLowerCase()
    if (!isEmail(email) || email.length > LIMITS.email) {
      throw new ConvexError("Please give a valid email address")
    }
    const message = args.message.trim()
    if (message.length < 10 || message.length > LIMITS.message) {
      throw new ConvexError(`The message must be 10 to ${LIMITS.message} characters`)
    }
    const role = args.role?.trim()
    if (role !== undefined && role.length > LIMITS.role)
      throw new ConvexError("The role is too long")
    const fields = args.fields ?? {}
    const entries = Object.entries(fields)
    if (entries.length > LIMITS.fields) throw new ConvexError("Too many fields")
    for (const [name, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name) || name.length > LIMITS.fieldName) {
        throw new ConvexError(`Not a field name: ${name.slice(0, LIMITS.fieldName)}`)
      }
      if (value.length > LIMITS.fieldValue)
        throw new ConvexError(`The value for ${name} is too long`)
    }
    if (requestNeedsListing(args.kind, args.eventKey !== undefined) && args.orgKey === undefined) {
      throw new ConvexError("Which listing is this about?")
    }
    if (args.eventKey !== undefined) {
      if (args.kind === "add") throw new ConvexError("A new listing has no events yet")
      if (!EVENT_KEY.test(args.eventKey)) throw new ConvexError("Not an event key")
      // An unknown key would show the broker a link that 404s, and a
      // correction of it may name no listing to fall back on. Whether the
      // event is the listing's is not checked: the visitor may choose another
      // (a co-host, or the right one when the lead is wrong). Review of
      // 2026-11-03, event-key-unverified.
      const eventKey = args.eventKey
      const event = await ctx.db
        .query("events")
        .withIndex("by_key", (q) => q.eq("key", eventKey))
        .unique()
      if (!event) throw new ConvexError("That event was not found")
    }
    if (args.orgKey !== undefined) {
      const orgKey = args.orgKey
      const org = await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", orgKey))
        .unique()
      if (!org) throw new ConvexError("That listing was not found")
    }

    const now = Date.now()
    const budget: Budget = REMOVAL_KINDS.includes(args.kind) ? "removal" : "other"
    await checkLimits(ctx, { email, orgKey: args.orgKey, budget, now })

    const key = `lr-${sha1Hex(`${email}:${now}:${message}`).slice(0, 20)}`
    await ctx.db.insert("listingRequests", {
      key,
      orgKey: args.orgKey,
      kind: args.kind,
      submitterEmail: email,
      role: role || undefined,
      message,
      fields: entries.length > 0 ? fields : undefined,
      eventKey: args.eventKey,
      status: "open",
      createdAt: now,
    })
    await ctx.db.insert("listingRequestSubmits", { budget, orgKey: args.orgKey, submittedAt: now })
    const expired = await ctx.db
      .query("listingRequestSubmits")
      .withIndex("by_submittedAt", (q) => q.lt("submittedAt", now - DAY_MS))
      .take(PRUNE_BATCH)
    for (const row of expired) await ctx.db.delete("listingRequestSubmits", row._id)
    await ctx.scheduler.runAfter(0, internal.analytics.captureListingRequest, { kind: args.kind })
    return { key }
  },
})
