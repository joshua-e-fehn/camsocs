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
import { Wordmark } from "@/components/molecules/wordmark"
import { LazyCommandPalette } from "@/components/organisms/lazy-command-palette"
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
import { useSignInOptions, useViewerTier } from "@/hooks/convex"
import { authClient } from "@/lib/auth-client"
import { currentCampus } from "@/lib/campus"
import { linkProps } from "@/lib/crawl-traps"
import { openPalette } from "@/lib/palette"
import { cn } from "@/lib/utils"

// The member tier's words come from the campus this build serves (lib/campus,
// decision D8); for Cambridge they are the literals they replaced. One
// template string per line of copy, so the server renders one text node.
const campus = currentCampus()
const memberDomain = campus.facts.memberEmail.domains[0]

/**
 * The main sections, in the order a student looks for them.
 *
 * `prefetch`: whether the header, on every page, prefetches the section as
 * it comes into view. Not the three that read their URL's filters: they are
 * rendered per request (docs/webapp.md "Caching"), so each prefetch would be
 * a server render on every page view, three per view, for a payload Next
 * then cuts at the page anyway (SEO audit 2026-11-02,
 * extra-invocations-per-view). About is a cached page: its prefetch is an
 * edge hit.
 */
const NAV = [
  { href: "/events", label: "Events", hint: "Socials, shows, matches", prefetch: false },
  { href: "/talks", label: "Talks", hint: "Seminars and lectures", prefetch: false },
  { href: "/societies", label: "Societies", hint: "The directory", prefetch: false },
  { href: "/about", label: "About", hint: "Sources and method", prefetch: undefined },
] as const

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Site header (DESIGN.md "River & ink"): the crest and wordmark, Events ·
 * Talks · Societies · About with a teal mark under the current one, the
 * "Search everything ⌘K" box (opens the palette) and the account menu.
 *
 * The account menu holds Sign in when signed out; signed in it shows a
 * "Cambridge" badge for a verified @cam.ac.uk session (it sees Cambridge-only
 * events), "Dashboard" only when Convex says the viewer is the broker
 * (`auth.getViewerTier`, the same rule as `getViewer`) and Sign out. Showing
 * the link grants nothing; the broker functions check again.
 *
 * Signed out, the menu is there only while the @cam.ac.uk sign-in link is
 * switched on (`auth.getSignInOptions`, ENG-35): that is the only sign-in a
 * visitor can use, and without it Sign in led to a page with nothing to do.
 * The administrator goes to /sign-in directly.
 */
export function PublicHeader() {
  const pathname = usePathname()
  const router = useRouter()
  const access = useViewerTier()
  const signInOptions = useSignInOptions()
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
    <header className="sticky top-0 z-40 border-b bg-background/93 backdrop-blur-md">
      <div className="mx-auto flex h-15 w-full max-w-7xl items-center gap-3 px-4 sm:h-17 sm:px-8 lg:gap-8">
        <Link
          href="/"
          className="-mx-1 flex min-h-11 items-center rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label="CAMsocs home"
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
                prefetch={item.prefetch}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center px-3 text-[0.9375rem] font-medium text-muted-foreground transition-colors duration-150 hover:text-brand-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  active && "text-foreground",
                )}
              >
                {item.label}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 -bottom-px h-0.5 origin-left rounded-full bg-brand transition-transform duration-200",
                    active ? "scale-x-100" : "scale-x-0",
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
            className="hidden h-10 w-56 items-center gap-2.5 rounded-[10px] border bg-background pr-2 pl-3 text-sm text-muted-foreground transition-colors hover:border-brand hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex lg:w-60"
          >
            <SearchIcon aria-hidden className="size-4" />
            <span>Search everything</span>
            <kbd className="ml-auto rounded-md border px-1.5 py-0.5 font-mono text-[0.6875rem]">
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

          <HeaderAccount
            place="menu"
            access={access}
            signInOptions={signInOptions}
            onSignOut={signOut}
          />

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
                        "flex min-h-14 items-center gap-3 rounded-lg border-l-2 border-transparent px-3 transition-colors hover:bg-muted",
                        active && "border-brand bg-muted",
                      )}
                    >
                      <span className="flex flex-col">
                        <span className="font-serif text-xl leading-tight">{item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.hint}</span>
                      </span>
                    </Link>
                  )
                })}
              </nav>
              <HeaderAccount
                place="sheet"
                access={access}
                signInOptions={signInOptions}
                onSignOut={signOut}
                onNavigate={() => setMenuOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
      </div>
      <LazyCommandPalette />
    </header>
  )
}

type Access = ReturnType<typeof useViewerTier>
type SignInOptions = ReturnType<typeof useSignInOptions>

/**
 * The account menu (`menu`, beside the search box from `md` up) or its links
 * (`sheet`, the mobile menu), or nothing: signed out, it is there only while
 * the @cam.ac.uk sign-in link is on (the rule in `PublicHeader`'s docstring).
 * Exported for its test.
 */
export function HeaderAccount({
  place,
  access,
  signInOptions,
  onSignOut,
  onNavigate = () => {},
}: {
  place: "menu" | "sheet"
  access: Access
  signInOptions: SignInOptions
  onSignOut: () => void
  onNavigate?: () => void
}) {
  if (access?.signedIn !== true && signInOptions?.camEmail !== true) return null
  return place === "menu" ? (
    <div className="hidden md:block">
      <AccountMenu access={access} onSignOut={onSignOut} />
    </div>
  ) : (
    <div className="flex flex-col gap-5 border-t px-5 py-4">
      <AccountLinks access={access} onSignOut={onSignOut} onNavigate={onNavigate} />
    </div>
  )
}

function AccountMenu({ access, onSignOut }: { access: Access; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-10">
          <CircleUserRoundIcon aria-hidden className="size-5!" />
          {access?.signedIn && (
            <span
              aria-hidden
              className="absolute top-2 right-2 size-2 rounded-full bg-brand ring-2 ring-background"
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
                  <BadgeCheckIcon aria-hidden className="size-3.5 text-brand-text" />
                  {campus.place.name}
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
            <Link {...linkProps("/sign-in")} className="flex-col items-start! gap-0.5">
              <span className="flex items-center gap-2 font-medium">
                <LogInIcon aria-hidden className="size-4" />
                Sign in
              </span>
              <span className="pl-6 text-xs text-muted-foreground">
                {`A @${memberDomain} address also shows ${campus.memberTier.tierLabel} events`}
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
              <BadgeCheckIcon aria-hidden className="size-4 text-brand-text" />
              {`Signed in with a verified @${memberDomain} address`}
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
            <Link {...linkProps("/sign-in")} onClick={onNavigate}>
              <LogInIcon data-icon="inline-start" />
              Sign in
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            {`A @${memberDomain} address also shows ${campus.memberTier.tierLabel} events.`}
          </p>
        </>
      )}
    </div>
  )
}
