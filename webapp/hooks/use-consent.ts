import { useSyncExternalStore } from "react"
import {
  type ConsentChoice,
  getConsent,
  getConsentSettingsRequests,
  isConsentBannerOpen,
  subscribe,
} from "@/lib/consent"

/**
 * The consent store (lib/consent.ts) for components. The server snapshot is
 * "no choice, banner closed": the server cannot read the visitor's storage,
 * so the banner never ships in server HTML and appears after hydration —
 * fixed to the bottom of the viewport, so nothing moves.
 */

/** "granted", "denied", or null before a (valid) choice. */
export function useConsent(): ConsentChoice | null {
  return useSyncExternalStore(subscribe, () => getConsent(), serverConsent)
}

/** Whether the consent banner should be on screen. */
export function useConsentBannerOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isConsentBannerOpen(), serverBannerOpen)
}

/** Counts presses of "Cookie settings"; the banner takes focus when it grows. */
export function useConsentSettingsRequests(): number {
  return useSyncExternalStore(subscribe, getConsentSettingsRequests, serverSettingsRequests)
}

function serverConsent(): ConsentChoice | null {
  return null
}

function serverBannerOpen(): boolean {
  return false
}

function serverSettingsRequests(): number {
  return 0
}
