import { v } from "convex/values"
import { query } from "./_generated/server"
import { authComponent } from "./betterAuth/auth"
import { getBrokerUser } from "./lib/auth"
import { resendConfig } from "./lib/signInEmail"
import { getViewer } from "./lib/viewer"

/**
 * The signed-in user's profile, or null when there is no session.
 *
 * Null is an ordinary answer: the public directory is browsable signed out.
 * Returns the Better Auth user document's display fields rather than the raw
 * identity token. Says nothing about broker access — that is
 * `api.broker.session.me`, which throws for non-brokers.
 *
 * Kept public: the `@convex-dev/better-auth` React hooks reach this during
 * their own session hydration (pattern from Bundestracker).
 */
export const getCurrentUser = query({
  args: {},
  // `id` is v.string(), not v.id("user"): the user table lives in the Better
  // Auth component's schema, not this deployment's.
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      name: v.string(),
      email: v.string(),
      image: v.union(v.null(), v.string()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return null
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      image: user.image ?? null,
      createdAt: user.createdAt,
    }
  },
})

/**
 * Whether the caller is signed in and whether they hold broker access.
 *
 * For the UI only — to choose between the private area and a "no access"
 * message without a thrown query error. It reveals nothing about anyone but
 * the caller, and grants nothing: every `convex/broker/*` function still calls
 * `requireBrokerUser` itself.
 */
export const getBrokerAccess = query({
  args: {},
  returns: v.object({ signedIn: v.boolean(), isBroker: v.boolean() }),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return { signedIn: false, isBroker: false }
    return { signedIn: true, isBroker: (await getBrokerUser(ctx)) !== null }
  },
})

/**
 * Which sign-in options this deployment has switched on, for the sign-in page
 * to show or grey out — booleans only, never the values. Mirrors the
 * conditional registration in betterAuth/auth.ts: Google needs both
 * `GOOGLE_CLIENT_*` vars, the `@cam.ac.uk` email link needs `RESEND_API_KEY`
 * and `RESEND_FROM`.
 */
export const getSignInOptions = query({
  args: {},
  returns: v.object({ google: v.boolean(), camEmail: v.boolean() }),
  handler: async () => ({
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    camEmail: resendConfig() !== null,
  }),
})

/**
 * The caller's access tier, for the UI: signed in, broker, and whether a
 * verified @cam.ac.uk address unlocks the Cambridge-only events. The same
 * `getViewer` the public queries gate on, so the badge cannot disagree with
 * what they return. Reveals nothing about anyone but the caller.
 */
export const getViewerTier = query({
  args: {},
  returns: v.object({
    signedIn: v.boolean(),
    isBroker: v.boolean(),
    isCamVerified: v.boolean(),
  }),
  handler: async (ctx) => {
    const viewer = await getViewer(ctx)
    return {
      signedIn: viewer.userId !== undefined,
      isBroker: viewer.isBroker,
      isCamVerified: viewer.isCamVerified,
    }
  },
})
