"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useId, useRef } from "react"
import { Button } from "@/components/ui/button"
import { useConsent, useConsentBannerOpen } from "@/hooks/use-consent"
import {
  CONSENT_MAX_AGE_DAYS,
  type ConsentChoice,
  isUntrackedPath,
  setConsent,
} from "@/lib/consent"

/**
 * Both choices look and weigh the same (ICO: refusing is as easy as
 * accepting), so they share one class list and one variant — outline, since
 * DESIGN.md allows one primary per section and neither may be it. 44px tall
 * for touch.
 */
export const CONSENT_BUTTON_CLASS = "min-h-11 flex-1 px-4 text-sm md:min-w-36 md:flex-none"

/**
 * The analytics consent banner (spec "Consent model", law report §4):
 * nothing of PostHog loads until "Accept analytics"; ignoring this banner
 * is a no.
 *
 *  - A labelled region fixed to the bottom of the viewport: no layout shift,
 *    no overlay, no focus trap, nothing on the page is blocked. Paper, not
 *    the sky band (DESIGN.md allows that twice per page). `z-30`: under the
 *    header (`z-40`), sheets and dialogs (`z-50`).
 *  - Not rendered on server HTML (hooks/use-consent.ts), nor on the routes
 *    never tracked (`/dashboard*`, `/sign-in*`, lib/consent.ts).
 *  - Reopened from the footer's "Cookie settings": focus moves to the banner,
 *    and back to that button once a choice is made.
 *  - The slide-in plays only with motion allowed (`motion-safe:`).
 */
export function ConsentBanner() {
  const pathname = usePathname()
  const open = useConsentBannerOpen()
  const choice = useConsent()
  const titleId = useId()
  const region = useRef<HTMLElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const reopened = open && choice !== null

  useEffect(() => {
    if (!reopened) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    region.current?.focus()
  }, [reopened])

  if (!open || (pathname !== null && isUntrackedPath(pathname))) return null

  const choose = (next: ConsentChoice) => {
    const back = opener.current
    opener.current = null
    setConsent(next)
    if (back?.isConnected) back.focus()
  }

  return (
    <section
      ref={region}
      aria-labelledby={titleId}
      tabIndex={-1}
      data-consent-banner=""
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background text-foreground shadow-lg outline-none motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-300"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 md:flex-row md:items-center md:justify-between md:gap-10">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Analytics cookies
          </h2>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            With your permission, camsocs uses PostHog (EU Cloud, Frankfurt) to collect aggregate
            usage statistics that help us improve the site. PostHog then keeps a first-party cookie
            and browser storage entries named <span className="font-mono">ph_*</span> on this device
            for {CONSENT_MAX_AGE_DAYS} days. Nothing is collected unless you accept. We remember
            your choice for {CONSENT_MAX_AGE_DAYS} days; change it any time under Cookie settings in
            the footer.{" "}
            <Link
              href="/privacy#cookies"
              className="font-medium text-brand-text underline underline-offset-4 hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              Cookies and privacy
            </Link>
          </p>
          {choice && (
            <p className="text-[0.8125rem] font-medium">
              {choice === "granted"
                ? "You currently allow analytics."
                : "You currently refuse analytics."}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            className={CONSENT_BUTTON_CLASS}
            onClick={() => choose("granted")}
          >
            Accept analytics
          </Button>
          <Button
            type="button"
            variant="outline"
            className={CONSENT_BUTTON_CLASS}
            onClick={() => choose("denied")}
          >
            Reject
          </Button>
        </div>
      </div>
    </section>
  )
}
