import { afterEach, describe, expect, test } from "bun:test"
import {
  CONSENT_KEY,
  clearAnalyticsStorage,
  clearConsent,
  cookieDomains,
  getConsent,
  getConsentRecord,
  getConsentSettingsRequests,
  hasNonAnalyticsCookie,
  isConsentBannerOpen,
  isUntrackedPath,
  onConsentChange,
  openConsentSettings,
  parseConsent,
  setConsent,
  subscribe,
} from "./consent"

/**
 * The consent store (spec "Consent model", law report §4/§7): nothing counts
 * as a choice unless it is a current, well-formed record; a refusal or
 * withdrawal leaves no analytics storage behind; storage that throws never
 * breaks the banner.
 */

const NOW = Date.UTC(2026, 10, 1, 12, 0)
const DAY = 86_400_000

function raw(fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, choice: "granted", at: new Date(NOW).toISOString(), ...fields })
}

/** Makes `window.localStorage` (and sessionStorage) throw on access, as a
 * blocked-storage browser does; returns the undo. */
function blockStorage(): () => void {
  const descriptors = {
    localStorage: Object.getOwnPropertyDescriptor(window, "localStorage"),
    sessionStorage: Object.getOwnPropertyDescriptor(window, "sessionStorage"),
  }
  for (const area of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, area, {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError")
      },
    })
  }
  return () => {
    for (const area of ["localStorage", "sessionStorage"] as const) {
      const descriptor = descriptors[area]
      if (descriptor) Object.defineProperty(window, area, descriptor)
      else delete (window as unknown as Record<string, unknown>)[area]
    }
  }
}

afterEach(() => {
  clearConsent()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("a stored record", () => {
  test("counts only in the exact v1 shape", () => {
    expect(parseConsent(raw({}), NOW)?.choice).toBe("granted")
    expect(parseConsent(raw({ choice: "denied" }), NOW)?.choice).toBe("denied")
    expect(parseConsent(null, NOW)).toBeNull()
    expect(parseConsent("{not json", NOW)).toBeNull()
    expect(parseConsent("null", NOW)).toBeNull()
    expect(parseConsent('"granted"', NOW)).toBeNull()
    expect(parseConsent(raw({ v: 2 }), NOW)).toBeNull()
    expect(parseConsent(raw({ v: "1" }), NOW)).toBeNull()
    expect(parseConsent(raw({ choice: "yes" }), NOW)).toBeNull()
    expect(parseConsent(raw({ at: "yesterday" }), NOW)).toBeNull()
    expect(parseConsent(raw({ at: 12345 }), NOW)).toBeNull()
  })

  test("expires after 180 days and is void when dated in the future", () => {
    const at = (offset: number) => raw({ at: new Date(NOW + offset).toISOString() })
    expect(parseConsent(at(-179 * DAY), NOW)).not.toBeNull()
    expect(parseConsent(at(-180 * DAY), NOW)).toBeNull()
    expect(parseConsent(at(-400 * DAY), NOW)).toBeNull()
    expect(parseConsent(at(60_000), NOW)).not.toBeNull()
    expect(parseConsent(at(30 * DAY), NOW)).toBeNull()
  })

  test("an invalid, other-version or expired one leaves the banner open", () => {
    for (const value of [
      "{",
      raw({ v: 0 }),
      raw({ at: new Date(NOW - 200 * DAY).toISOString() }),
    ]) {
      window.localStorage.setItem(CONSENT_KEY, value)
      expect(getConsent(NOW)).toBeNull()
      expect(isConsentBannerOpen(NOW)).toBe(true)
    }
  })
})

describe("choosing", () => {
  test("persists the record, closes the banner and survives a re-read", () => {
    expect(isConsentBannerOpen()).toBe(true)
    setConsent("granted", new Date(NOW))
    expect(JSON.parse(window.localStorage.getItem(CONSENT_KEY) ?? "")).toEqual({
      v: 1,
      choice: "granted",
      at: "2026-11-01T12:00:00.000Z",
    })
    expect(getConsent(NOW + DAY)).toBe("granted")
    expect(isConsentBannerOpen(NOW + DAY)).toBe(false)
    // 180 days on, the banner asks again.
    expect(isConsentBannerOpen(NOW + 180 * DAY)).toBe(true)
  })

  test("Cookie settings reopens the banner without changing the choice", () => {
    setConsent("denied")
    openConsentSettings()
    expect(isConsentBannerOpen()).toBe(true)
    expect(getConsent()).toBe("denied")
    setConsent("granted")
    expect(isConsentBannerOpen()).toBe(false)
  })

  test("clearing forgets the choice", () => {
    setConsent("granted")
    clearConsent()
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull()
    expect(getConsent()).toBeNull()
  })
})

describe("storage that throws", () => {
  test("reads as no choice, and a choice still holds for the page", () => {
    const restore = blockStorage()
    try {
      expect(getConsent()).toBeNull()
      expect(isConsentBannerOpen()).toBe(true)
      expect(() => setConsent("denied")).not.toThrow()
      expect(getConsent()).toBe("denied")
      expect(isConsentBannerOpen()).toBe(false)
      expect(() => clearAnalyticsStorage()).not.toThrow()
      expect(() => clearConsent()).not.toThrow()
      expect(getConsent()).toBeNull()
    } finally {
      restore()
    }
  })

  test("a refused write (quota, Safari private mode) keeps the choice in memory", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError")
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
    }
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => full })
    try {
      setConsent("granted", new Date(NOW))
      expect(getConsentRecord(NOW)?.choice).toBe("granted")
      expect(isConsentBannerOpen(NOW)).toBe(false)
      // The page's memory expires like a stored record.
      expect(getConsent(NOW + 181 * DAY)).toBeNull()
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor)
    }
  })

  test("a refusal that cannot be written still beats an older stored grant", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")
    let stored: string | null = raw({ choice: "granted" })
    const full = {
      getItem: () => stored,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError")
      },
      removeItem: () => {
        stored = null
      },
      key: () => null,
      length: 0,
    }
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => full })
    try {
      expect(getConsent(NOW)).toBe("granted")
      const seen: (string | null)[] = []
      const stop = onConsentChange((choice) => seen.push(choice))
      setConsent("denied", new Date(NOW))
      stop()
      expect(getConsent(NOW)).toBe("denied")
      expect(isConsentBannerOpen(NOW)).toBe(false)
      expect(seen).toEqual(["denied"])
      // The stale grant is gone too, so the next visit asks instead of granting.
      expect(stored).toBeNull()
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor)
    }
  })
})

describe("listeners", () => {
  test("hear every change until they unsubscribe", () => {
    let calls = 0
    const stop = subscribe(() => calls++)
    setConsent("granted")
    const before = getConsentSettingsRequests()
    openConsentSettings()
    openConsentSettings() // already open, still news: the banner takes focus again
    expect(getConsentSettingsRequests()).toBe(before + 2)
    setConsent("denied")
    clearConsent()
    expect(calls).toBe(5)
    stop()
    setConsent("granted")
    expect(calls).toBe(5)
  })

  test("onConsentChange reports only real changes of choice", () => {
    const seen: (string | null)[] = []
    const stop = onConsentChange((choice) => seen.push(choice))
    setConsent("granted")
    openConsentSettings()
    setConsent("granted")
    setConsent("denied")
    clearConsent()
    stop()
    setConsent("granted")
    expect(seen).toEqual(["granted", "denied", null])
  })

  test("another tab's change is picked up from the storage event", () => {
    let calls = 0
    const stop = subscribe(() => calls++)
    window.localStorage.setItem(
      CONSENT_KEY,
      raw({ choice: "denied", at: new Date().toISOString() }),
    )
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }))
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }))
    expect(calls).toBe(1)
    expect(getConsent()).toBe("denied")
    stop()
  })

  test("another tab's choice replaces this page's own", () => {
    const stop = subscribe(() => {})
    setConsent("granted")
    window.localStorage.setItem(
      CONSENT_KEY,
      raw({ choice: "denied", at: new Date().toISOString() }),
    )
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }))
    stop()
    expect(getConsent()).toBe("denied")
  })

  test("a withdrawal in another tab clears what this tab's listeners leave", () => {
    setConsent("granted")
    window.localStorage.setItem("ph_phc_test_posthog", "{}")
    // As the analytics client's opt-out and reset do: they write fresh entries.
    const stop = onConsentChange(() => {
      window.localStorage.setItem("__ph_opt_in_out_phc_test", "0")
      window.localStorage.setItem("ph_phc_test_posthog", "{}")
    })
    window.localStorage.setItem(
      CONSENT_KEY,
      raw({ choice: "denied", at: new Date().toISOString() }),
    )
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }))
    stop()
    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBeNull()
    expect(window.localStorage.getItem("__ph_opt_in_out_phc_test")).toBeNull()
    expect(window.localStorage.getItem(CONSENT_KEY)).not.toBeNull()
  })

  test("a grant in another tab clears nothing", () => {
    let calls = 0
    const stop = subscribe(() => calls++)
    window.localStorage.setItem("ph_phc_test_posthog", "{}")
    window.localStorage.setItem(CONSENT_KEY, raw({ at: new Date().toISOString() }))
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_KEY }))
    stop()
    expect(calls).toBe(1)
    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBe("{}")
  })
})

describe("withdrawal clears analytics storage", () => {
  test("ph_* cookies and storage keys go; everything else stays", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture
    document.cookie = "ph_phc_test_posthog=%7B%7D; Path=/"
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture
    document.cookie = "keep=1; Path=/"
    window.localStorage.setItem("ph_phc_test_posthog", "{}")
    window.localStorage.setItem("__ph_opt_in_out_phc_test", "1")
    window.localStorage.setItem("camsocs:recent-searches", "[]")
    window.sessionStorage.setItem("ph_phc_test_window_id", "w")
    window.sessionStorage.setItem("other", "x")

    setConsent("denied")

    expect(document.cookie).not.toContain("ph_")
    expect(document.cookie).toContain("keep=1")
    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBeNull()
    expect(window.localStorage.getItem("__ph_opt_in_out_phc_test")).toBeNull()
    expect(window.localStorage.getItem("camsocs:recent-searches")).toBe("[]")
    expect(window.localStorage.getItem(CONSENT_KEY)).not.toBeNull()
    expect(window.sessionStorage.getItem("ph_phc_test_window_id")).toBeNull()
    expect(window.sessionStorage.getItem("other")).toBe("x")
    // biome-ignore lint/suspicious/noDocumentCookie: test cleanup
    document.cookie = "keep=; Max-Age=0; Path=/"
  })

  test("listeners hear a refusal before the storage is cleared", () => {
    window.localStorage.setItem("ph_phc_test_posthog", "{}")
    let seenDuring: string | null = "unset"
    const stop = subscribe(() => {
      seenDuring = window.localStorage.getItem("ph_phc_test_posthog")
    })
    setConsent("denied")
    stop()
    expect(seenDuring).toBe("{}")
    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBeNull()
  })

  test("a parent-domain cookie is deleted for each domain it may carry", () => {
    expect(cookieDomains("www.camsocs.uk")).toEqual(["www.camsocs.uk", "camsocs.uk"])
    expect(cookieDomains("camsocs.uk")).toEqual(["camsocs.uk"])
    expect(cookieDomains("camsocs-git-x.vercel.app")).toEqual([
      "camsocs-git-x.vercel.app",
      "vercel.app",
    ])
    expect(cookieDomains("localhost")).toEqual([])
    expect(cookieDomains("127.0.0.1")).toEqual([])
    expect(cookieDomains("[::1]")).toEqual([])
  })
})

describe("untracked routes", () => {
  test("are the broker area and sign-in, and nothing public", () => {
    for (const path of ["/dashboard", "/dashboard/people", "/sign-in", "/sign-in?next=/x"]) {
      expect(isUntrackedPath(path)).toBe(true)
    }
    for (const path of ["/", "/events", "/talks/talk-1", "/privacy", "/societies/dashboard"]) {
      expect(isUntrackedPath(path)).toBe(false)
    }
  })
})

describe("a request's cookies", () => {
  /** lib/auth-server.ts: only a cookie that could be a session costs a Convex
   * auth round trip; PostHog's own never does (docs/deploy.md "CPU protection"). */
  test("count only when something besides PostHog's is there", () => {
    expect(hasNonAnalyticsCookie(null)).toBe(false)
    expect(hasNonAnalyticsCookie(undefined)).toBe(false)
    expect(hasNonAnalyticsCookie("")).toBe(false)
    expect(hasNonAnalyticsCookie("ph_phc_x_posthog=%7B%7D")).toBe(false)
    expect(hasNonAnalyticsCookie("ph_phc_x_posthog=1; __ph_opt_in_out_phc_x=1")).toBe(false)
    expect(hasNonAnalyticsCookie("better-auth.session_token=abc")).toBe(true)
    expect(hasNonAnalyticsCookie("ph_phc_x_posthog=1; __Secure-better-auth.session_token=a")).toBe(
      true,
    )
    expect(hasNonAnalyticsCookie("graph_ph=1")).toBe(true)
  })
})
