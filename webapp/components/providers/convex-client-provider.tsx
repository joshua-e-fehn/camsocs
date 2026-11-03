"use client"

import type { AuthClient } from "@convex-dev/better-auth/react"
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react"
import { ConvexReactClient } from "convex/react"
import { authClient } from "@/lib/auth-client"

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

/**
 * Convex client + Better Auth session for the whole tree.
 *
 * One provider rather than two because they are not independent: the Convex
 * client attaches the auth token to queries. The root layout passes no
 * `initialToken`: reading it on the server would make every page dynamic
 * (app/layout.tsx), so the client fetches the session after hydration, and
 * queries that depend on it rerun once it is there (docs/webapp.md
 * "Caching"). Most visitors to the public directory are signed out.
 */
export function ConvexClientProvider({
  children,
  initialToken,
}: {
  children: React.ReactNode
  initialToken?: string | null
}) {
  return (
    // The cast works around an upstream variance bug in @convex-dev/better-auth
    // 0.12.5 (found in Bundestracker): the exported `AuthClient` type is a union
    // of two `createAuthClient` instantiations that the package's own documented
    // usage is not assignable to. Confined to this one boundary; widening the
    // plugin array instead collapses `useSession().data` to `never` everywhere.
    <ConvexBetterAuthProvider
      client={convex}
      authClient={authClient as unknown as AuthClient}
      initialToken={initialToken}
    >
      {children}
    </ConvexBetterAuthProvider>
  )
}
