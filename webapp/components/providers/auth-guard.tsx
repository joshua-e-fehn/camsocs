"use client"

import { usePathname, useRouter, useSelectedLayoutSegment } from "next/navigation"
import { useEffect, useState } from "react"
import { authClient } from "@/lib/auth-client"
import { isPublicPath } from "@/lib/auth-routes"

/**
 * Client-side session gate (from Bundestracker components/providers/auth-guard.tsx).
 *
 * Renders public routes immediately; for private routes (lib/auth-routes.ts)
 * waits for the session and redirects to `/sign-in` without one. This is UX
 * only — Convex functions enforce access. It is also what notices a session
 * expiring while the app is open.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, refetch } = authClient.useSession()
  const router = useRouter()
  const pathname = usePathname()
  // A route that does not exist has nothing to protect: Next reports its
  // internal `/_not-found` segment, and treating it as public keeps a mistyped
  // URL on the 404 page instead of bouncing to `/sign-in`.
  const isNotFound = useSelectedLayoutSegment() === "/_not-found"
  // On Vercel's ISR re-render of "/" the server's pathname is "/index", which
  // `isPublicPath` folds into "/" (lib/auth-routes.ts `routePathname`);
  // without that the cached home page is this guard's spinner.
  const isPublic = isNotFound || isPublicPath(pathname)

  // ⚠ A hydration guard, not a loading flag. The branches below return
  // structurally different trees around the whole page; the server always
  // renders the pending spinner, and a client whose session resolved before
  // hydration would otherwise render `null` in its place — a hydration
  // mismatch that, in React 19, detaches <head> and breaks the next click.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!isPublic && !isPending && !session) {
      router.replace("/sign-in")
    }
  }, [isPublic, isPending, session, router])

  // On a private route only, the session is read again when the tab comes
  // back into view, so one that expired meanwhile sends the reader to
  // /sign-in. The auth client does not do this itself any more
  // (lib/auth-client.ts `refetchOnWindowFocus: false`): it would cost every
  // public page view a read.
  useEffect(() => {
    if (isPublic) return
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [isPublic, refetch])

  if (isPublic) {
    return <>{children}</>
  }

  if (!mounted || isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (!session) {
    return null
  }

  return <>{children}</>
}
