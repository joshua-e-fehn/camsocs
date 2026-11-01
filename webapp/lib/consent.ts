/**
 * The visitor's analytics choice: the one thing the consent banner
 * (components/organisms/consent-banner.tsx) writes and the analytics client
 * (ENG-4) reads before it may load at all.
 *
 * UK PECR reg 6 applies to any device access by an analytics SDK, so nothing
 * of PostHog runs, loads or stores until a visitor says yes here (research:
 * ICO "how do we manage consent in practice"; spec "Consent model"). This
 * record itself is strictly necessary (PECR Sch A1 para 4(2)(e)(ii)): it only
 * remembers the choice, and the banner says so.
 *
 *  - Stored in localStorage under `camsocs-consent` as
 *    `{"v":1,"choice":"granted"|"denied","at":"<ISO>"}`. Not a cookie: a
 *    cookie would ride on every request and cost anonymous visitors a Convex
 *    auth round trip (lib/auth-server.ts `getToken`).
 *  - Valid for 180 days (the ICO's "six months" to ask a refuser again), then
 *    the banner asks again. Missing, unreadable, malformed, another version,
 *    expired or dated in the future → no choice: banner shown, nothing
 *    captured. Ignoring the banner is never consent.
 *  - Storage that throws (private windows, blocked site data) reads as no
 *    choice; a choice made on the page still holds in memory until it is
 *    closed, so the banner works and goes away.
 *
 * Pure TypeScript, no React: `hooks/use-consent.ts` adapts it to components.
 */

export const CONSENT_KEY = "camsocs-consent"
export const CONSENT_VERSION = 1
export const CONSENT_MAX_AGE_DAYS = 180

export const CONSENT_CHOICES = ["granted", "denied"] as const
export type ConsentChoice = (typeof CONSENT_CHOICES)[number]

export type ConsentRecord = { v: typeof CONSENT_VERSION; choice: ConsentChoice; at: string }

const DAY_MS = 86_400_000
const MAX_AGE_MS = CONSENT_MAX_AGE_DAYS * DAY_MS
/** Clock skew we forgive on a record's date before calling it bogus. */
const FUTURE_SLACK_MS = DAY_MS

/**
 * Routes never tracked (spec hard rule 3): the broker area and sign-in. The
 * banner is not shown there either, since there is nothing to ask about.
 * A plain prefix, not a path segment, on purpose: it can only ever match
 * more, and for analytics more means less is sent.
 */
export const UNTRACKED_PATHS = ["/dashboard", "/sign-in"] as const

export function isUntrackedPath(pathname: string): boolean {
  return UNTRACKED_PATHS.some((path) => pathname.startsWith(path))
}

// --- the record -------------------------------------------------------------------------------

/** `raw` as a record still in force at `now`, or null. */
export function parseConsent(raw: string | null, now: number = Date.now()): ConsentRecord | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const { v, choice, at } = value as Record<string, unknown>
  if (v !== CONSENT_VERSION) return null
  if (!CONSENT_CHOICES.includes(choice as ConsentChoice)) return null
  if (typeof at !== "string") return null
  const time = Date.parse(at)
  if (!Number.isFinite(time) || !inForce(time, now)) return null
  return { v: CONSENT_VERSION, choice: choice as ConsentChoice, at }
}

function inForce(time: number, now: number): boolean {
  const age = now - time
  return age < MAX_AGE_MS && age > -FUTURE_SLACK_MS
}

// --- the store --------------------------------------------------------------------------------

/** The choice made on this page, for when storage refuses to keep it. */
let memory: ConsentRecord | null = null
/** "Cookie settings" asked for the banner although a choice is in force. */
let reopened = false
/** How many times "Cookie settings" was pressed: the banner moves focus on each. */
let settingsRequests = 0
const listeners = new Set<() => void>()

function storedRecord(now: number): ConsentRecord | null {
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_KEY), now)
  } catch {
    // No window (server render) or storage blocked.
    return null
  }
}

/**
 * The record in force at `now`: this page's own latest choice first, else
 * storage. The page's choice must win: when a write fails (storage full)
 * an older stored grant would otherwise outlive a refusal made here.
 * `memory` is dropped whenever storage changes under us (another tab,
 * `clearConsent`), so it never hides a newer stored record.
 */
export function getConsentRecord(now: number = Date.now()): ConsentRecord | null {
  if (memory && inForce(Date.parse(memory.at), now)) return memory
  return storedRecord(now)
}

/** "granted", "denied", or null while the visitor has not (validly) chosen. */
export function getConsent(now: number = Date.now()): ConsentChoice | null {
  return getConsentRecord(now)?.choice ?? null
}

/** Whether the banner should be on screen: no choice in force, or reopened. */
export function isConsentBannerOpen(now: number = Date.now()): boolean {
  return reopened || getConsent(now) === null
}

/**
 * Records the visitor's choice and closes the banner. Listeners hear it
 * first (so the analytics client can opt out and reset), then a refusal
 * clears whatever analytics storage is left on the device.
 */
export function setConsent(choice: ConsentChoice, now: Date = new Date()): void {
  const record: ConsentRecord = { v: CONSENT_VERSION, choice, at: now.toISOString() }
  memory = record
  reopened = false
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(record))
  } catch {
    // Storage blocked or full: the choice holds for this page (`memory`)
    // only. Drop any older record too, so a stale grant cannot come back
    // on the next visit; the banner asks again there instead.
    try {
      window.localStorage.removeItem(CONSENT_KEY)
    } catch {
      // Nothing stored that we could reach.
    }
  }
  emit()
  if (choice === "denied") clearAnalyticsStorage()
}

/** Forgets the choice (the banner asks again) and clears analytics storage. */
export function clearConsent(): void {
  memory = null
  reopened = false
  try {
    window.localStorage.removeItem(CONSENT_KEY)
  } catch {
    // Nothing stored that we could reach.
  }
  emit()
  clearAnalyticsStorage()
}

/**
 * Shows the banner again (the footer's "Cookie settings"), choice unchanged.
 * Every press counts, also while the banner is already open (a first visit),
 * so the banner can take focus each time instead of doing nothing visible.
 */
export function openConsentSettings(): void {
  reopened = true
  settingsRequests++
  emit()
}

/** How many times `openConsentSettings` ran on this page (0 until pressed). */
export function getConsentSettingsRequests(): number {
  return settingsRequests
}

// --- listening --------------------------------------------------------------------------------

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Another tab changed the record (or site data was cleared): re-read it.
 * Same order as `setConsent`: listeners first (the analytics client opts
 * out and resets, which writes fresh `ph_*` entries), then anything short
 * of a grant clears analytics storage, so a withdrawal in another tab
 * leaves nothing behind here either.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== CONSENT_KEY) return
  memory = null
  emit()
  if (getConsent() !== "granted") clearAnalyticsStorage()
}

/**
 * Calls `listener` whenever the choice or the banner's visibility may have
 * changed (the `useSyncExternalStore` contract). Returns the unsubscribe.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage)
    }
  }
}

/**
 * Calls `callback` with the new choice each time it actually changes (not
 * for a reopened banner, not for the same choice twice). Not called at once:
 * read `getConsent()` for the current state. Returns the unsubscribe.
 *
 *     apply(getConsent())
 *     const stop = onConsentChange(apply)
 */
export function onConsentChange(callback: (choice: ConsentChoice | null) => void): () => void {
  let last = getConsent()
  return subscribe(() => {
    const next = getConsent()
    if (next === last) return
    last = next
    callback(next)
  })
}

// --- withdrawal -------------------------------------------------------------------------------

/**
 * What PostHog keeps on a device: the `ph_<token>_posthog` cookie and
 * localStorage / sessionStorage entries, plus its own opt-in/out flag
 * `__ph_opt_in_out_<token>` (research-js §3).
 */
const ANALYTICS_PREFIXES = ["ph_", "__ph_"] as const

function isAnalyticsName(name: string): boolean {
  return ANALYTICS_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * The `Domain` values a cookie for `hostname` may have been set with: the
 * host and each parent with at least two labels (`www.camsocs.uk` →
 * `www.camsocs.uk`, `camsocs.uk`). None for `localhost` or an IP address,
 * whose cookies are host-only.
 */
export function cookieDomains(hostname: string): string[] {
  if (!hostname.includes(".") || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return []
  const labels = hostname.split(".")
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."))
  return out
}

/**
 * Deletes every PostHog cookie (host-only and for each parent domain, path
 * `/`) and every `ph_*` / `__ph_*` key in localStorage and sessionStorage.
 * Withdrawal means erasure (ICO), and whether posthog-js deletes its own
 * persistence on opt-out is unverified, so this does it explicitly. Safe to
 * call anywhere, any number of times; never throws.
 */
export function clearAnalyticsStorage(): void {
  if (typeof document === "undefined") return
  try {
    const names = document.cookie
      .split(";")
      .map((pair) => pair.split("=")[0]?.trim() ?? "")
      .filter(isAnalyticsName)
    const domains = cookieDomains(window.location.hostname)
    for (const name of names) {
      for (const domain of ["", ...domains]) {
        const scope = domain ? `; Domain=${domain}` : ""
        // biome-ignore lint/suspicious/noDocumentCookie: deleting cookies needs the raw setter (Cookie Store API is not everywhere).
        document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/${scope}`
      }
    }
  } catch {
    // Cookies blocked: nothing could have been set.
  }
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[area]
      const keys: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key !== null && isAnalyticsName(key)) keys.push(key)
      }
      for (const key of keys) storage.removeItem(key)
    } catch {
      // Storage blocked: nothing could have been stored.
    }
  }
}
