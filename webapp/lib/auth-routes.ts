/**
 * The single source of truth for which routes need a session.
 *
 * Pattern from Bundestracker (lib/auth-routes.ts), adapted: camsocs has a
 * public directory and a private brokering area, so routes are classified
 * explicitly into one of two lists and `lib/auth-routes.test.ts` reads `app/`
 * and fails if any page is in neither (or both). An unlisted page would
 * otherwise be silently redirected to `/sign-in` by `AuthGuard`, which looks
 * like a broken route rather than an auth decision.
 *
 * ⚠ This is UX, not security. `proxy.ts` passes everything through and
 * `components/providers/auth-guard.tsx` only decides what to *render*. Access
 * is enforced in Convex: every function under `convex/broker/` calls
 * `requireBrokerUser` (convex/lib/auth.ts), so a private page reached without a
 * session or by a non-broker account renders nothing it could not already read.
 *
 * Matching: an entry matches itself and everything beneath it, except "/",
 * which matches only itself (`startsWith("//")` never fires for a pathname).
 */

/** Routes a signed-out visitor may see. "/api" keeps Better Auth's callbacks
 * reachable while signed out. */
export const PUBLIC_PATHS = ["/", "/sign-in", "/api"] as const

/** Routes that need a session (and, in Convex, a broker account). */
export const PRIVATE_PATHS = ["/dashboard"] as const

function matches(path: string, pathname: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => matches(path, pathname))
}

export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_PATHS.some((path) => matches(path, pathname))
}
