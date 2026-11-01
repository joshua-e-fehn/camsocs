"use client"

import {
  BadgeCheckIcon,
  CircleUserRoundIcon,
  LayoutDashboardIcon,
  LogInIcon,
  LogOutIcon,
  MenuIcon,
  SearchIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { RiverLine } from "@/components/molecules/river-line"
import { ThemeToggle } from "@/components/molecules/theme-toggle"
import { Wordmark } from "@/components/molecules/wordmark"
import { CommandPalette } from "@/components/organisms/command-palette"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useViewerTier } from "@/hooks/convex"
import { authClient } from "@/lib/auth-client"
import { openPalette } from "@/lib/palette"
import { cn } from "@/lib/utils"

/** The pillars, each with its colour (spec §5: Societies sage, Events brick,
 * Talks indigo). The class names are spelled out for Tailwind's scanner. */
const NAV = [
  { href: "/societies", label: "Societies", bar: "bg-primary", hint: "The directory" },
  { href: "/events", label: "Events", bar: "bg-events", hint: "Socials, shows, matches" },
  { href: "/talks", label: "Talks", bar: "bg-talks", hint: "Seminars and lectures" },
  { href: "/about", label: "About", bar: "bg-foreground", hint: "Sources and method" },
] as const

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Site header (spec §6 "Shell"): the wordmark, Societies · Events · Talks ·
 * About with a pillar-coloured mark under the current one, the "Search ⌘K"
 * pill (opens the palette), the theme toggle and the account menu.
 *
 * The account menu holds Sign in when signed out; signed in it shows a
 * "Cambridge" badge for a verified @cam.ac.uk session (it sees Cambridge-only
 * events), "Dashboard" only when Convex says the viewer is the broker
 * (`auth.getViewerTier`, the same rule as `getViewer`) and Sign out. Showing
 * the link grants nothing; the broker functions check again.
 */
export function PublicHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const access = useViewerTier()
  const [menuOpen, setMenuOpen] = useState(false)
  const [shortcut, setShortcut] = useState("⌘K")

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setShortcut("Ctrl K")
  }, [])

  const signOut = async () => {
    await authClient.signOut()
    setMenuOpen(false)
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/88 backdrop-blur-md supports-backdrop-filter:bg-background/72">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:gap-8">
        <Link
          href="/"
          className="-mx-1 flex min-h-11 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="camsocs home"
        >
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden h-full items-stretch md:flex">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center px-3 text-[0.9375rem] text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  active && "text-foreground",
                )}
              >
                {item.label}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 -bottom-px h-0.5 origin-left rounded-full transition-transform duration-200",
                    item.bar,
                    active ? "scale-x-100" : "scale-x-0 opacity-50 group-hover:scale-x-100",
                  )}
                />
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => openPalette()}
            className="hidden h-10 w-56 items-center gap-2 rounded-full border bg-card/70 pr-1.5 pl-3.5 text-sm text-muted-foreground shadow-xs transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex lg:w-64"
          >
            <SearchIcon aria-hidden className="size-4" />
            <span>Search</span>
            <kbd className="ml-auto rounded-full border bg-muted px-2 py-0.5 font-mono text-[0.6875rem] tracking-wide">
              {shortcut}
            </kbd>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:hidden"
            onClick={() => openPalette()}
          >
            <SearchIcon aria-hidden />
            <span className="sr-only">Search</span>
          </Button>

          <ThemeToggle className="hidden md:inline-flex" />
          <div className="hidden md:block">
            <AccountMenu access={access} onSignOut={signOut} />
          </div>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11 md:hidden">
                <MenuIcon aria-hidden />
                <span className="sr-only">Menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(22rem,88vw)] gap-0">
              <SheetHeader className="border-b px-5 py-4">
                <SheetTitle>
                  <Wordmark />
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="Main" className="flex flex-col px-3 py-3">
                {NAV.map((item) => {
                  const active = isActive(pathname, item.href)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-14 items-center gap-3 rounded-lg px-3 transition-colors hover:bg-muted",
                        active && "bg-muted",
                      )}
                    >
                      <span aria-hidden className={cn("h-7 w-1 rounded-full", item.bar)} />
                      <span className="flex flex-col">
                        <span className="font-serif text-xl leading-tight">{item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.hint}</span>
                      </span>
                    </Link>
                  )
                })}
              </nav>
              <RiverLine variant="divider" draw={false} className="h-4! px-5" />
              <div className="flex flex-col gap-5 px-5 py-4">
                <ThemeToggle variant="inline" />
                <AccountLinks
                  access={access}
                  onSignOut={signOut}
                  onNavigate={() => setMenuOpen(false)}
                />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <CommandPalette />
    </header>
  )
}

type Access = ReturnType<typeof useViewerTier>

function AccountMenu({ access, onSignOut }: { access: Access; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-10">
          <CircleUserRoundIcon aria-hidden className="size-5!" />
          {access?.signedIn && (
            <span
              aria-hidden
              className="absolute top-2 right-2 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
          <span className="sr-only">{access?.signedIn ? "Account (signed in)" : "Account"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {access === undefined ? (
          <DropdownMenuLabel className="text-muted-foreground">Checking…</DropdownMenuLabel>
        ) : access.signedIn ? (
          <>
            <DropdownMenuLabel className="flex items-center gap-2">
              Signed in
              {access.isCamVerified && (
                <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                  <BadgeCheckIcon aria-hidden className="size-3.5 text-primary" />
                  Cambridge
                </span>
              )}
            </DropdownMenuLabel>
            {access.isBroker && (
              <DropdownMenuItem asChild>
                <Link href="/dashboard">
                  <LayoutDashboardIcon aria-hidden />
                  Dashboard
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOutIcon aria-hidden />
              Sign out
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem asChild>
            <Link href="/sign-in" className="flex-col items-start! gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                <LogInIcon aria-hidden className="size-4" />
                Sign in
              </span>
              <span className="pl-6 text-xs text-muted-foreground">
                A @cam.ac.uk address also shows Cambridge-only events
              </span>
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The account actions as plain links, for the mobile sheet. */
function AccountLinks({
  access,
  onSignOut,
  onNavigate,
}: {
  access: Access
  onSignOut: () => void
  onNavigate: () => void
}) {
  if (access === undefined) return <span className="h-11" aria-hidden />
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        Account
      </p>
      {access.signedIn ? (
        <>
          {access.isCamVerified && (
            <p className="inline-flex items-center gap-1.5 text-sm">
              <BadgeCheckIcon aria-hidden className="size-4 text-primary" />
              Signed in with a verified @cam.ac.uk address
            </p>
          )}
          {access.isBroker && (
            <Button variant="outline" className="h-11 justify-start" asChild>
              <Link href="/dashboard" onClick={onNavigate}>
                <LayoutDashboardIcon data-icon="inline-start" />
                Dashboard
              </Link>
            </Button>
          )}
          <Button variant="ghost" className="h-11 justify-start" onClick={onSignOut}>
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
        </>
      ) : (
        <>
          <Button className="h-11 justify-start" asChild>
            <Link href="/sign-in" onClick={onNavigate}>
              <LogInIcon data-icon="inline-start" />
              Sign in
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            A @cam.ac.uk address also shows Cambridge-only events.
          </p>
        </>
      )}
    </div>
  )
}
