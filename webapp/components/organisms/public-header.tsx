"use client"

import { BadgeCheckIcon, LayoutDashboardIcon, MenuIcon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import { Wordmark } from "@/components/molecules/wordmark"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useViewerTier } from "@/hooks/convex"
import { authClient } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/societies", label: "Societies" },
  { href: "/events", label: "Events" },
  { href: "/about", label: "About" },
] as const

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Site header: wordmark, Societies / Events / About, and the account corner —
 * "Sign in" signed out, "Sign out" signed in, a "Cambridge" badge for a
 * verified @cam.ac.uk session (it sees Cambridge-only events), and "Dashboard"
 * only when Convex says the viewer is the broker (`auth.getViewerTier`, the
 * same rule as `getViewer`). Showing the link grants nothing; the broker
 * functions check again.
 */
export function PublicHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const access = useViewerTier()
  const [menuOpen, setMenuOpen] = useState(false)

  const signOut = async () => {
    await authClient.signOut()
    router.refresh()
  }

  const account =
    access === undefined ? (
      <span className="h-8 w-16" aria-hidden />
    ) : (
      <>
        {access.isCamVerified && !access.isBroker && (
          <Badge variant="secondary" title="Signed in with a verified @cam.ac.uk address">
            <BadgeCheckIcon data-icon="inline-start" />
            Cambridge
          </Badge>
        )}
        {access.isBroker && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard">
              <LayoutDashboardIcon data-icon="inline-start" />
              Dashboard
            </Link>
          </Button>
        )}
        {access.signedIn ? (
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        ) : (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
        )}
      </>
    )

  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link
          href="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          aria-label="camsocs home"
        >
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(pathname, item.href) ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                isActive(pathname, item.href) && "bg-muted text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">{account}</div>

        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="ml-auto md:hidden" aria-label="Menu">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-72">
            <SheetHeader>
              <SheetTitle>
                <Wordmark />
              </SheetTitle>
            </SheetHeader>
            <nav aria-label="Main" className="flex flex-col gap-1 px-4">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center rounded-md px-3 text-base",
                    isActive(pathname, item.href)
                      ? "bg-muted font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-2 border-t px-4 pt-4">{account}</div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  )
}
