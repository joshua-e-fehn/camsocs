import { v } from "convex/values"
import { sha1Hex } from "../lib/hash"
import { LISTING_REQUEST_KINDS } from "../lib/vocab"
import { mutation } from "./_generated/server"
import { literalUnion } from "./lib/validators"

/**
 * The public claim / correct / remove / object / add form (PLAN §2.3).
 *
 * `submit` only *stores* a request in `listingRequests` (internal: never
 * returned by a public query). Review and any resulting change happen in the
 * admin area (T12), where an accepted correction becomes a `fieldClaims` row
 * with `method: "owner_submitted"` — never a direct edit.
 *
 * Abuse limits: every string is length-limited; one address may submit at
 * most `PER_EMAIL_PER_HOUR` requests an hour, and the whole form at most
 * `GLOBAL_PER_HOUR`.
 */

export const PER_EMAIL_PER_HOUR = 5
export const GLOBAL_PER_HOUR = 200
const HOUR_MS = 60 * 60 * 1000

const LIMITS = {
  email: 254,
  role: 100,
  message: 5_000,
  fieldName: 60,
  fieldValue: 2_000,
  fields: 30,
}
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export const submit = mutation({
  args: {
    kind: literalUnion(LISTING_REQUEST_KINDS),
    /** The listing concerned; omit for `add`. */
    orgKey: v.optional(v.string()),
    submitterEmail: v.string(),
    /** e.g. "President". */
    role: v.optional(v.string()),
    message: v.string(),
    /** Proposed corrections: field name → proposed value. */
    fields: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, args) => {
    const email = args.submitterEmail.trim().toLowerCase()
    if (!EMAIL.test(email) || email.length > LIMITS.email) {
      throw new Error("Please give a valid email address")
    }
    const message = args.message.trim()
    if (message.length < 10 || message.length > LIMITS.message) {
      throw new Error(`The message must be 10 to ${LIMITS.message} characters`)
    }
    const role = args.role?.trim()
    if (role !== undefined && role.length > LIMITS.role) throw new Error("The role is too long")
    const fields = args.fields ?? {}
    const entries = Object.entries(fields)
    if (entries.length > LIMITS.fields) throw new Error("Too many fields")
    for (const [name, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name) || name.length > LIMITS.fieldName) {
        throw new Error(`Not a field name: ${name.slice(0, LIMITS.fieldName)}`)
      }
      if (value.length > LIMITS.fieldValue) throw new Error(`The value for ${name} is too long`)
    }
    if (args.kind !== "add" && args.orgKey === undefined) {
      throw new Error("Which listing is this about?")
    }
    if (args.orgKey !== undefined) {
      const orgKey = args.orgKey
      const org = await ctx.db
        .query("organisations")
        .withIndex("by_key", (q) => q.eq("key", orgKey))
        .unique()
      if (!org) throw new Error("That listing was not found")
    }

    const now = Date.now()
    const recentFromEmail = await ctx.db
      .query("listingRequests")
      .withIndex("by_submitter_createdAt", (q) =>
        q.eq("submitterEmail", email).gt("createdAt", now - HOUR_MS),
      )
      .take(PER_EMAIL_PER_HOUR)
    if (recentFromEmail.length >= PER_EMAIL_PER_HOUR) {
      throw new Error("Too many requests from this address; please try again in an hour")
    }
    const recentOpen = await ctx.db
      .query("listingRequests")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", "open").gt("createdAt", now - HOUR_MS),
      )
      .take(GLOBAL_PER_HOUR)
    if (recentOpen.length >= GLOBAL_PER_HOUR) {
      throw new Error("The form is busy; please try again later")
    }

    const key = `lr-${sha1Hex(`${email}:${now}:${message}`).slice(0, 20)}`
    await ctx.db.insert("listingRequests", {
      key,
      orgKey: args.orgKey,
      kind: args.kind,
      submitterEmail: email,
      role: role || undefined,
      message,
      fields: entries.length > 0 ? fields : undefined,
      status: "open",
      createdAt: now,
    })
    return { key }
  },
})
