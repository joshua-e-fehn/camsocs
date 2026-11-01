"use client"

import { openConsentSettings } from "@/lib/consent"
import { cn } from "@/lib/utils"

/**
 * The footer's "Cookie settings": a button, not a page, that brings the
 * consent banner back so a choice can be changed as easily as it was made
 * (ICO: withdrawal with the same ease; a persistent way to revisit it).
 * The footer stays a server component; this is its only client island.
 */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openConsentSettings()}
      className={cn("cursor-pointer text-left", className)}
    >
      Cookie settings
    </button>
  )
}
