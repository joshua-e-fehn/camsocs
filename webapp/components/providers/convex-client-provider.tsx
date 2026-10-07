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
 * client attaches the auth token to queries, and `initialToken` (read by
 * `getToken()` in the root layout) is how the server-rendered pass hands it
 * over so the first paint is not signed-out. A null token is normal — most
 * visitors to the public directory are signed out.
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
