import { createClient } from "@convex-dev/better-auth"
import type { ComponentApi } from "@convex-dev/better-auth/_generated/component.js"
import { convex } from "@convex-dev/better-auth/plugins"
import type { GenericCtx } from "@convex-dev/better-auth/utils"
import type { BetterAuthOptions } from "better-auth"
import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { magicLink } from "better-auth/plugins/magic-link"
import { isCamEmail, normaliseCamEmail } from "../../lib/cam-email"
import { components, internal } from "../_generated/api"
import type { DataModel } from "../_generated/dataModel"
import authConfig from "../auth.config"
import {
  buildSignInEmail,
  resendConfig,
  SIGN_IN_LINK_TTL_SECONDS,
  sendSignInEmail,
} from "../lib/signInEmail"
import schema from "./schema"

// Better Auth component, wired as in Bundestracker (@convex-dev/better-auth 0.12.5).
//
// `components.betterAuth` is typed as `AnyComponentReference` until `convex dev`
// has run against a deployment. The assertion restores the real shape from the
// type the package ships for exactly this purpose, so the repo typechecks from a
// clean clone. It is not a widening: `ComponentApi` is the same type codegen
// writes into betterAuth/_generated/component.ts once a deployment exists.
export const authComponent = createClient<DataModel, typeof schema>(
  components.betterAuth as unknown as ComponentApi<"betterAuth">,
  {
    local: { schema },
    verbose: false,
  },
)

/**
 * Google, registered only when both credentials are set on the deployment.
 *
 * Bundestracker learned this for GitHub: a provider registered with
 * `process.env.X!` promises at compile time a value the deployment may not hold,
 * and Better Auth then answers `POST /api/auth/sign-in/social` with a 200 and a
 * URL containing `client_id=undefined`. Spreading a conditional means an
 * unconfigured deployment answers 404 PROVIDER_NOT_FOUND instead, and setting
 * the two env vars is what turns sign-in on — no deploy needed:
 *
 *   bunx convex env set GOOGLE_CLIENT_ID <>
 *   bunx convex env set GOOGLE_CLIENT_SECRET <>
 *
 * Read per call (inside `createAuthOptions`) rather than at module load, so the
 * value is the deployment's current one.
 */
function googleProvider() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  return clientId && clientSecret ? { google: { clientId, clientSecret } } : {}
}

export const MAGIC_LINK_PATH = "/sign-in/magic-link"
export const NOT_CAM_EMAIL = "Use your @cam.ac.uk address"

function refuseNonCamEmail(email: unknown): void {
  if (typeof email !== "string" || !isCamEmail(email)) {
    throw new APIError("BAD_REQUEST", { message: NOT_CAM_EMAIL })
  }
}

/**
 * The `@cam.ac.uk` sign-in link (Better Auth's magic-link plugin, which
 * @convex-dev/better-auth 0.12.5 supports: its convex plugin sets the JWT
 * cookie after `/magic-link/verify`). Registered only when Resend is
 * configured (convex/lib/signInEmail.ts), like Google above: unset, the
 * endpoint answers 404 and the sign-in page shows the option as off.
 *
 * A verified link creates (or signs in) a user with `emailVerified: true`, so
 * `getViewer` (convex/lib/viewer.ts) reports `isCamVerified` for that session.
 *
 * Every refusal happens on the server: `refuseNonCamEmail` in the `before`
 * hook (nothing is stored) and again before sending, and a throttle per
 * address and per deployment (convex/authEmail.ts).
 */
function camEmailLink(ctx: GenericCtx<DataModel>) {
  const config = resendConfig()
  if (!config) return []
  return [
    magicLink({
      expiresIn: SIGN_IN_LINK_TTL_SECONDS,
      sendMagicLink: async ({ email, url }) => {
        refuseNonCamEmail(email)
        if (!("runMutation" in ctx)) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "Cannot send email here" })
        }
        const verdict = await ctx.runMutation(internal.authEmail.reserveSignInLink, { email })
        if (verdict !== "ok") {
          throw new APIError("TOO_MANY_REQUESTS", {
            message:
              verdict === "address_limit"
                ? "A link was sent to this address a moment ago. Check your inbox, or try again in 15 minutes."
                : "Too many sign-in requests right now. Please try again later.",
          })
        }
        try {
          await sendSignInEmail(
            config,
            buildSignInEmail(config.from, normaliseCamEmail(email), url),
          )
        } catch (error) {
          // The message names the HTTP status only — never the link or key.
          console.error(error instanceof Error ? error.message : "Sign-in email failed")
          throw new APIError("BAD_GATEWAY", { message: "The email could not be sent. Try again." })
        }
      },
    }),
  ]
}

// Better Auth Options
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    appName: "camsocs",
    baseURL: process.env.SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    // The browser calls the auth API from the Next.js origin while this backend
    // runs on Convex, so that origin has to be trusted explicitly.
    // `registerRoutes(http, createAuth, { cors: true })` in convex/http.ts reads
    // this same list for its Access-Control-Allow-Origin. Set per deployment:
    //   bunx convex env set SITE_URL https://<public origin>
    trustedOrigins: [process.env.SITE_URL ?? "http://localhost:3000"],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      // OAuth only: no passwords stored, no reset flow, no email deliverability.
      enabled: false,
    },
    socialProviders: {
      ...googleProvider(),
    },
    // No sign-up gate here, deliberately. Any Google account may hold a session;
    // holding one grants nothing. Access to private data is decided per function
    // by `requireBrokerUser` (convex/lib/auth.ts) against BROKER_EMAILS, and the
    // Cambridge tier by `getViewer` (a verified @cam.ac.uk address).
    hooks: {
      before: createAuthMiddleware(async (hookCtx) => {
        if (hookCtx.path === MAGIC_LINK_PATH) refuseNonCamEmail(hookCtx.body?.email)
      }),
    },
    plugins: [convex({ authConfig }), ...camEmailLink(ctx)],
  } satisfies BetterAuthOptions
}

// For `auth` CLI
export const options = createAuthOptions({} as GenericCtx<DataModel>)

// Better Auth Instance
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx))
}
