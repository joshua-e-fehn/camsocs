import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/**
 * Next.js middleware (named `proxy` since Next 16). Pass-through by design,
 * as in Bundestracker, salo-ba and cambridge.
 *
 * This layer cannot make the access decision: with cross-domain auth (Convex
 * backend, Vercel frontend) the session cookie lives on the Convex site URL and
 * is not readable here. Access is enforced in Convex functions —
 * `requireBrokerUser` in convex/lib/auth.ts for everything under
 * `convex/broker/` — and `components/providers/auth-guard.tsx` decides what to
 * render, using the route lists in `lib/auth-routes.ts`.
 */
export function proxy(_request: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     * - public files with extensions (.svg, .png, etc.)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
}
