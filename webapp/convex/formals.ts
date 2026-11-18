import { ConvexError, v } from "convex/values"
import { isBrokerEmail } from "../lib/broker-access"
import { deploymentProfile } from "../lib/campus/deployment"
import { isMemberEmail } from "../lib/campus/member-email"
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server"
import { authComponent } from "./betterAuth/auth"
import { requireUserId } from "./lib/auth"
import {
  compareProfiles,
  FORMAL_COLLEGES,
  FORMAL_LIMITS,
  trackerCounts,
  validateCollegeKey,
  validateDisplayName,
  validateNotes,
  validateVisitedOn,
  validateVisits,
} from "./lib/formals"
import { getViewer, type Viewer } from "./lib/viewer"
import { formalEntryFields, formalProfileFields } from "./schema"

/**
 * The formal tracker (/formals/tracker, ENG-272): one formal at every college,
 * ported from the Cambridge Tracker's `formalEntries`. Everything is the
 * signed-in member's own: the user id comes from the session only
 * (`requireUserId`), and no function takes one as an argument.
 *
 * Reads never throw for a signed-out caller: `mine` and `leaderboard` answer
 * null. The leaderboard is for verified members of the campus (and the
 * broker) only, and lists only profiles that opted in under a display name.
 */

/**
 * Profiles read to build the leaderboard, in index order (colleges, then
 * formals, both descending), so the cut falls on the first two sort keys;
 * only the "who got there first" tie and the membership re-check below are
 * resolved in memory, and the margin over the 50 shown covers both.
 */
const LEADERBOARD_SCAN = 500

/** Who may see the leaderboard, and join it. */
function isMember(viewer: Viewer): boolean {
  return viewer.isCamVerified || viewer.isBroker
}

/**
 * Whether a listed member is still a member now (the same rule as
 * `getViewer`'s `isCamVerified || isBroker`): joining checks it once, so an
 * account that has since lost its verified member address drops off the
 * board on the next read instead of staying listed.
 */
async function isStillMember(ctx: QueryCtx, userId: string): Promise<boolean> {
  const user = await authComponent.getAnyUserById(ctx, userId)
  if (!user || user.emailVerified !== true) return false
  return (
    isMemberEmail(user.email, deploymentProfile()) ||
    isBrokerEmail(user.email, process.env.BROKER_EMAILS)
  )
}

const entryView = v.object({
  collegeKey: formalEntryFields.collegeKey,
  attended: formalEntryFields.attended,
  visits: formalEntryFields.visits,
  visitedOn: formalEntryFields.visitedOn,
  notes: formalEntryFields.notes,
  updatedAt: formalEntryFields.updatedAt,
})

const profileView = v.object({
  displayName: formalProfileFields.displayName,
  onLeaderboard: formalProfileFields.onLeaderboard,
  homeCollegeKey: formalProfileFields.homeCollegeKey,
  colleges: formalProfileFields.colleges,
  visits: formalProfileFields.visits,
})

async function findEntry(ctx: MutationCtx, userId: string, collegeKey: string) {
  return await ctx.db
    .query("formalEntries")
    .withIndex("by_userId_and_collegeKey", (q) =>
      q.eq("userId", userId).eq("collegeKey", collegeKey),
    )
    .unique()
}

async function findProfile(ctx: MutationCtx, userId: string) {
  return await ctx.db
    .query("formalProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique()
}

/** Recounts the member's ticks into their profile (created on first write). */
async function refreshProfile(ctx: MutationCtx, userId: string, now: number) {
  const entries = await ctx.db
    .query("formalEntries")
    .withIndex("by_userId_and_collegeKey", (q) => q.eq("userId", userId))
    .collect()
  const counts = trackerCounts(entries)
  const profile = await findProfile(ctx, userId)
  if (!profile) {
    await ctx.db.insert("formalProfiles", {
      userId,
      displayName: null,
      onLeaderboard: false,
      homeCollegeKey: null,
      ...counts,
      reachedAt: now,
      updatedAt: now,
    })
    return
  }
  if (profile.colleges === counts.colleges && profile.visits === counts.visits) return
  await ctx.db.patch(profile._id, {
    ...counts,
    reachedAt: profile.colleges === counts.colleges ? profile.reachedAt : now,
    updatedAt: now,
  })
}

/** Writes one college's row: `attended` holds exactly when `visits` ≥ 1. */
async function writeEntry(
  ctx: MutationCtx,
  userId: string,
  collegeKey: string,
  values: { visits: number; visitedOn?: string | null; notes?: string },
) {
  const now = Date.now()
  const row = await findEntry(ctx, userId, collegeKey)
  const attended = values.visits > 0
  if (row) {
    await ctx.db.patch(row._id, { ...values, attended, updatedAt: now })
  } else {
    await ctx.db.insert("formalEntries", {
      userId,
      collegeKey,
      attended,
      visits: values.visits,
      visitedOn: values.visitedOn ?? null,
      notes: values.notes ?? "",
      updatedAt: now,
    })
  }
  await refreshProfile(ctx, userId, now)
}

/** The member's tracker: their rows (missing colleges are absent), their
 * profile, and whether they may join the leaderboard. Null signed out. */
export const mine = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      entries: v.array(entryView),
      profile: v.union(v.null(), profileView),
      canJoinLeaderboard: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const viewer = await getViewer(ctx)
    const userId = viewer.userId
    if (!userId) return null
    const rows = await ctx.db
      .query("formalEntries")
      .withIndex("by_userId_and_collegeKey", (q) => q.eq("userId", userId))
      .collect()
    const profile = await ctx.db
      .query("formalProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique()
    return {
      entries: rows.map((row) => ({
        collegeKey: row.collegeKey,
        attended: row.attended,
        visits: row.visits,
        visitedOn: row.visitedOn,
        notes: row.notes,
        updatedAt: row.updatedAt,
      })),
      profile: profile
        ? {
            displayName: profile.displayName,
            onLeaderboard: profile.onLeaderboard,
            homeCollegeKey: profile.homeCollegeKey,
            colleges: profile.colleges,
            visits: profile.visits,
          }
        : null,
      canJoinLeaderboard: isMember(viewer),
    }
  },
})

/** The top 50 opted-in members, for verified members (and the broker) only;
 * null for anyone else. Display names only: no user id leaves the server. */
export const leaderboard = query({
  args: {},
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        rank: v.number(),
        displayName: v.string(),
        homeCollege: v.union(v.string(), v.null()),
        colleges: v.number(),
        visits: v.number(),
        isMe: v.boolean(),
      }),
    ),
  ),
  handler: async (ctx) => {
    const viewer = await getViewer(ctx)
    if (!isMember(viewer)) return null
    const profiles = await ctx.db
      .query("formalProfiles")
      .withIndex("by_onLeaderboard_and_colleges_and_visits", (q) => q.eq("onLeaderboard", true))
      .order("desc")
      .take(LEADERBOARD_SCAN)
    const ranked = profiles.filter((profile) => profile.displayName !== null).sort(compareProfiles)
    const listed: typeof ranked = []
    for (const profile of ranked) {
      if (listed.length === FORMAL_LIMITS.leaderboard) break
      if (await isStillMember(ctx, profile.userId)) listed.push(profile)
    }
    return listed.map((profile, index) => ({
      rank: index + 1,
      displayName: profile.displayName ?? "",
      homeCollege: profile.homeCollegeKey
        ? (FORMAL_COLLEGES[profile.homeCollegeKey] ?? null)
        : null,
      colleges: profile.colleges,
      visits: profile.visits,
      isMe: profile.userId === viewer.userId,
    }))
  },
})

/** Ticks or unticks a college. A tick counts one formal (more are kept);
 * an untick clears the count but keeps the date and notes. */
export const setAttended = mutation({
  args: { collegeKey: v.string(), attended: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx)
    const collegeKey = validateCollegeKey(args.collegeKey)
    const row = await findEntry(ctx, userId, collegeKey)
    const visits = args.attended ? Math.max(1, row?.visits ?? 0) : 0
    await writeEntry(ctx, userId, collegeKey, { visits })
    return null
  },
})

/** Saves one college's details; `visits` 0 unticks it, 1 or more ticks it. */
export const saveDetails = mutation({
  args: {
    collegeKey: v.string(),
    visitedOn: formalEntryFields.visitedOn,
    visits: v.number(),
    notes: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx)
    const collegeKey = validateCollegeKey(args.collegeKey)
    const values = {
      visitedOn: validateVisitedOn(args.visitedOn, Date.now()),
      visits: validateVisits(args.visits),
      notes: validateNotes(args.notes),
    }
    await writeEntry(ctx, userId, collegeKey, values)
    return null
  },
})

/** The member's leaderboard name, opt-in and home college. Joining needs a
 * verified member address and a name. */
export const saveProfile = mutation({
  args: {
    displayName: formalProfileFields.displayName,
    onLeaderboard: v.boolean(),
    homeCollegeKey: formalProfileFields.homeCollegeKey,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx)
    const viewer = await getViewer(ctx)
    const displayName = validateDisplayName(args.displayName)
    const homeCollegeKey =
      args.homeCollegeKey === null ? null : validateCollegeKey(args.homeCollegeKey)
    if (args.onLeaderboard && !isMember(viewer)) {
      throw new ConvexError("Only a verified @cam.ac.uk account can join the leaderboard.")
    }
    if (args.onLeaderboard && displayName === null) {
      throw new ConvexError("Choose a leaderboard name to join the leaderboard.")
    }
    const now = Date.now()
    await refreshProfile(ctx, userId, now)
    const profile = await findProfile(ctx, userId)
    if (!profile) throw new ConvexError("Your tracker could not be saved. Please try again.")
    await ctx.db.patch(profile._id, {
      displayName,
      onLeaderboard: args.onLeaderboard,
      homeCollegeKey,
      updatedAt: now,
    })
    return null
  },
})

/** Deletes every tracker row and the profile of the member. */
export const eraseMine = mutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx)
    const rows = await ctx.db
      .query("formalEntries")
      .withIndex("by_userId_and_collegeKey", (q) => q.eq("userId", userId))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
    const profile = await findProfile(ctx, userId)
    if (profile) await ctx.db.delete(profile._id)
    return { deleted: rows.length + (profile ? 1 : 0) }
  },
})
