import { convexClient } from "@convex-dev/better-auth/client/plugins"
import { magicLinkClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

// No baseURL: the auth client calls same-origin /api/auth/*, which the route
// handler at app/api/auth/[...all]/route.ts forwards to the Convex site URL.
// The browser only ever sees same-origin requests, so there is no CORS to own.
// Do not add a next.config rewrite for these paths — see next.config.ts.
//
// `magicLinkClient` adds `signIn.magicLink` for the @cam.ac.uk sign-in link.
// The server registers that endpoint only when Resend is configured
// (convex/betterAuth/auth.ts); the form asks `auth.getSignInOptions` first.
//
// `refetchOnWindowFocus: false` (SEO audit 2026-11-02,
// extra-invocations-per-view): Better Auth's default reads the session again
// each time a tab regains focus, a function invocation per switch for every
// reader of the public site, signed in or not. A signed-out reader's read is
// answered without Convex (lib/auth-forwarded-headers.ts
// `isAnonymousSessionRead`); the broker's area still notices an expired
// session on focus, where it matters (components/providers/auth-guard.tsx).
export const authClient = createAuthClient({
  plugins: [convexClient(), magicLinkClient()],
  sessionOptions: { refetchOnWindowFocus: false },
})
