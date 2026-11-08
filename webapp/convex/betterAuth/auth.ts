import { createClient } from "@convex-dev/better-auth"
import type { ComponentApi } from "@convex-dev/better-auth/_generated/component.js"
import { convex } from "@convex-dev/better-auth/plugins"
import type { GenericCtx } from "@convex-dev/better-auth/utils"
import type { BetterAuthOptions } from "better-auth"
import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { emailOTP } from "better-auth/plugins/email-otp"
import { CAMBRIDGE } from "../../lib/campus"
import { deploymentProfile } from "../../lib/campus/deployment"
import { isMemberEmail, normaliseEmail } from "../../lib/campus/member-email"
import { components, internal } from "../_generated/api"
import type { DataModel } from "../_generated/dataModel"
import authConfig from "../auth.config"
import {
  buildSignInEmail,
  resendConfig,
  SIGN_IN_CODE_ATTEMPTS,
  SIGN_IN_CODE_TTL_SECONDS,
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

/** The two email-OTP endpoints the member tier uses; every other email-OTP
 * endpoint (password reset, email change, verify-email) is refused. */
export const SEND_CODE_PATH = "/email-otp/send-verification-otp"
export const CODE_SIGN_IN_PATH = "/sign-in/email-otp"
const OTHER_EMAIL_OTP = (path: string) =>
  (path.startsWith("/email-otp/") && path !== SEND_CODE_PATH) ||
  path === "/forget-password/email-otp"
/** Cambridge's refusal text. A deployment refuses with its own campus's
 * (`memberTier.rejectMessage`, decision D8); for `cam` it is this. */
export const NOT_CAM_EMAIL = CAMBRIDGE.memberTier.rejectMessage

/** Refuses any address outside the deployment campus's member tier
 * (Cambridge: exactly `@cam.ac.uk`, lib/campus/member-email.ts). */
function refuseNonCamEmail(email: unknown): void {
  const campus = deploymentProfile()
  if (typeof email !== "string" || !isMemberEmail(email, campus)) {
    throw new APIError("BAD_REQUEST", { message: campus.memberTier.rejectMessage })
  }
}

/** The caller's address as the request carries it: the first entry of
 * `x-forwarded-for` (set by Vercel and passed on by the `/api/auth` hop). A
 * caller can forge it by going to the Convex site URL directly, so it only
 * spreads the per-client throttle; the per-address and overall limits stand. */
export function clientAddress(headers: Headers | undefined): string | undefined {
  const first = headers?.get("x-forwarded-for")?.split(",")[0]?.trim()
  return first ? first.slice(0, 100) : undefined
}

/**
 * The `@cam.ac.uk` sign-in code (Better Auth's email-OTP plugin; the Convex
 * plugin sets the JWT cookie after `/sign-in/*`). Registered only when Resend
 * is configured (convex/lib/signInEmail.ts), like Google above: unset, the
 * endpoints answer 404 and the sign-in page shows the option as off.
 *
 * A code, not a link: Exchange's scanning spent every emailed link before the
 * member saw it (2026-11-08; signInEmail.ts). A verified code creates (or signs
 * in) a user with `emailVerified: true`, so `getViewer` (convex/lib/viewer.ts)
 * reports `isCamVerified` for that session.
 *
 * Every refusal happens in the `before` hook (`guardMemberCode`), where an
 * error reaches the caller: the plugin runs `sendVerificationOTP` through
 * `runInBackgroundOrAwait`, which only logs what it throws. So a failed send is
 * logged (status only, never the code) and the caller still sees success.
 */
function camEmailCode() {
  const config = resendConfig()
  if (!config) return []
  return [
    emailOTP({
      otpLength: 6,
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
      allowedAttempts: SIGN_IN_CODE_ATTEMPTS,
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return
        try {
          await sendSignInEmail(config, buildSignInEmail(config.from, normaliseEmail(email), otp))
        } catch (error) {
          // The message names the HTTP status only — never the code or key.
          console.error(error instanceof Error ? error.message : "Sign-in email failed")
        }
      },
    }),
  ]
}

/**
 * The member tier's guard, before any email-OTP endpoint runs: only sign-in
 * codes, only member addresses, and the throttle per address, per client and
 * per deployment (convex/authEmail.ts) before a code is made and sent.
 */
async function guardMemberCode(
  ctx: GenericCtx<DataModel>,
  hookCtx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<void> {
  const path = hookCtx.path ?? ""
  if (OTHER_EMAIL_OTP(path)) throw new APIError("NOT_FOUND")
  // Without Resend the plugin is not registered: its routes answer 404 themselves.
  if (!resendConfig()) return
  if (path === CODE_SIGN_IN_PATH) refuseNonCamEmail(hookCtx.body?.email)
  if (path !== SEND_CODE_PATH) return
  if (hookCtx.body?.type !== "sign-in") throw new APIError("NOT_FOUND")
  const email: unknown = hookCtx.body?.email
  refuseNonCamEmail(email)
  if (!("runMutation" in ctx)) {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "Cannot send email here" })
  }
  const known = await hookCtx.context.internalAdapter
    .findUserByEmail(normaliseEmail(email as string))
    .catch(() => null)
  const verdict = await ctx.runMutation(internal.authEmail.reserveSignInLink, {
    email: email as string,
    client: clientAddress(hookCtx.request?.headers ?? hookCtx.headers),
    knownUser: known?.user.emailVerified === true,
  })
  if (verdict !== "ok") {
    throw new APIError("TOO_MANY_REQUESTS", {
      message:
        verdict === "address_limit"
          ? "A code was sent to this address a moment ago. Check your inbox, or try again in 15 minutes."
          : "Too many sign-in requests right now. Please try again later.",
    })
  }
}

// Better Auth Options
export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  return {
    // The deployment's campus (CAMSOCS_CAMPUS, unset: cam → "CAMsocs").
    appName: deploymentProfile().brand.name,
    baseURL: process.env.SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    // The browser calls the auth API from the Next.js origin while this backend
    // runs on Convex, so that origin has to be trusted explicitly.
    // `registerRoutes(http, createAuth, { cors: true })` in convex/http.ts reads
    // this same list for its Access-Control-Allow-Origin. Set per deployment:
    //   bunx convex env set SITE_URL https://<public origin>
    // EXTRA_TRUSTED_ORIGINS (comma-separated) keeps an old origin working while
    // the public host moves (camsocs.vercel.app → camsocs.uk, 2026-10-31).
    trustedOrigins: [
      process.env.SITE_URL ?? "http://localhost:3000",
      ...(process.env.EXTRA_TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ],
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
        await guardMemberCode(ctx, hookCtx)
      }),
    },
    plugins: [convex({ authConfig }), ...camEmailCode()],
  } satisfies BetterAuthOptions
}

// For `auth` CLI
export const options = createAuthOptions({} as GenericCtx<DataModel>)

// Better Auth Instance
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx))
}
