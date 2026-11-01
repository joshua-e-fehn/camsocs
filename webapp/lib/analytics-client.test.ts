import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { CaptureResult, PostHogConfig } from "posthog-js"
import { clearConsent, setConsent } from "./consent"

/**
 * The browser analytics client (spec "Browser analytics client", hard rules
 * 1-3, law report §7): posthog-js loads only after "Accept analytics", with a
 * key, outside automated browsers; a withdrawal stops it and erases its
 * storage; a page without a grant never keeps `ph_*` storage; and
 * `before_send` lets out no title, element text, user-agent string, query
 * string, fragment or untracked route.
 *
 * posthog-js itself is replaced by a recorder (`mock.module`), so nothing is
 * downloaded or sent.
 */

type Call = [method: string, ...args: unknown[]]

const calls: Call[] = []
let initConfig: Partial<PostHogConfig> | null = null
let optedOut = false

const fakePostHog = {
  init(token: string, config: Partial<PostHogConfig>) {
    calls.push(["init", token])
    initConfig = config
    config.loaded?.(fakePostHog as never)
    return fakePostHog
  },
  register: (props: unknown) => calls.push(["register", props]),
  opt_in_capturing: (options: unknown) => {
    optedOut = false
    calls.push(["opt_in_capturing", options])
  },
  opt_out_capturing: () => {
    optedOut = true
    calls.push(["opt_out_capturing"])
  },
  has_opted_out_capturing: () => optedOut,
  reset: () => calls.push(["reset"]),
  set_config: (config: unknown) => calls.push(["set_config", config]),
  captureException: (error: unknown) => calls.push(["captureException", error]),
}

mock.module("posthog-js", () => ({ default: fakePostHog, posthog: fakePostHog }))

/** How often the client fetched the package. */
let loads = 0
const load = () => {
  loads++
  return import("posthog-js") as never
}

const {
  analyticsLoading,
  captureBrowserException,
  getPostHog,
  posthogConfig,
  resetAnalyticsForTests,
  sanitizeEvent,
  startAnalytics,
  STRIPPED_PROPS,
} = await import("./analytics-client")

const KEY = "phc_test_not_a_real_key"
const ORIGIN = "https://camsocs.uk"

function methods(): string[] {
  return calls.map(([method]) => method)
}

/** Lets the lazy `import("posthog-js")` settle. */
async function settle() {
  await analyticsLoading()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await analyticsLoading()
}

/** Puts PostHog-style storage on the device, as an earlier grant left it. */
function seedAnalyticsStorage() {
  window.localStorage.setItem(`ph_${KEY}_posthog`, '{"distinct_id":"x"}')
  window.localStorage.setItem(`__ph_opt_in_out_${KEY}`, "1")
  window.sessionStorage.setItem(`ph_${KEY}_window_id`, "w")
  // biome-ignore lint/suspicious/noDocumentCookie: seeding a cookie for the test.
  document.cookie = `ph_${KEY}_posthog=abc; Path=/`
}

function analyticsStorage(): string[] {
  const found: string[] = []
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith("ph_") || key?.startsWith("__ph_")) found.push(key)
    }
  }
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim() ?? ""
    if (name.startsWith("ph_")) found.push(`cookie:${name}`)
  }
  return found
}

function setWebdriver(value: boolean | undefined) {
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => value })
}

beforeEach(() => {
  calls.length = 0
  initConfig = null
  optedOut = false
  loads = 0
  setWebdriver(false)
})

afterEach(() => {
  resetAnalyticsForTests()
  clearConsent()
  window.localStorage.clear()
  window.sessionStorage.clear()
  setWebdriver(undefined)
})

function pageview(props: Record<string, unknown>, extra: Partial<CaptureResult> = {}) {
  return {
    uuid: "u",
    event: "$pageview",
    properties: {
      token: KEY,
      distinct_id: "d",
      $current_url: `${ORIGIN}/societies`,
      $pathname: "/societies",
      ...props,
    },
    ...extra,
  } as CaptureResult
}

function beforeSend(config: Partial<PostHogConfig>) {
  return config.before_send as (event: CaptureResult) => CaptureResult | null
}

function clean(event: CaptureResult | null, customEvents = {}) {
  return sanitizeEvent(event, { environment: "test", customEvents, origin: ORIGIN })
}

describe("before_send", () => {
  test("deletes titles, element text, elements and the user-agent string", () => {
    const stripped = [
      "title",
      "$title",
      "$el_text",
      "$elements",
      "$elements_chain",
      "$raw_user_agent",
      "$useragent",
      "$user_agent",
      "ph_keyword",
      "$viewport_width",
      "$viewport_height",
      "$device",
      "$prev_pageview_duration",
    ]
    expect([...STRIPPED_PROPS].sort()).toEqual([...stripped].sort())
    const props: Record<string, unknown> = { $browser: "Chrome", $os: "Mac OS X" }
    for (const key of stripped) props[key] = `secret ${key}`
    const out = clean(pageview(props))
    expect(out).not.toBeNull()
    for (const key of stripped) expect(out?.properties).not.toHaveProperty(key)
    // Browser and OS by name stay (the privacy notice lists them).
    expect(out?.properties.$browser).toBe("Chrome")
    expect(out?.properties.$os).toBe("Mac OS X")
    // Required for ingestion.
    expect(out?.properties.token).toBe(KEY)
    expect(out?.properties.distinct_id).toBe("d")
  })

  /** The SDK copies properties as `$initial_<name>` / `$session_entry_<name>`
   * without the name's own `$`; a search engine's keyword arrives as
   * `$session_entry_ph_keyword` on every event of the visit. */
  test("removes the stripped properties' $initial_ and $session_entry_ copies too", () => {
    const copies = [
      "$session_entry_ph_keyword",
      "$initial_ph_keyword",
      "$initial_raw_user_agent",
      "$session_entry_title",
      "$initial_title",
      "$session_entry_viewport_width",
    ]
    const props: Record<string, unknown> = {
      $device_type: "Desktop",
      $screen_width: 1440,
      $session_entry_search_engine: "google",
      $initial_device_type: "Desktop",
    }
    for (const key of copies) props[key] = "secret search"
    const out = clean(pageview(props, { $set_once: { $initial_ph_keyword: "secret search" } }))
    for (const key of copies) expect(out?.properties).not.toHaveProperty(key)
    expect(out?.$set_once).toEqual({})
    // Listed in the privacy notice, or a domain-level enum: they stay.
    expect(out?.properties.$device_type).toBe("Desktop")
    expect(out?.properties.$screen_width).toBe(1440)
    expect(out?.properties.$session_entry_search_engine).toBe("google")
    expect(out?.properties.$initial_device_type).toBe("Desktop")
  })

  test("a talk page's title never leaves, also from person properties", () => {
    const out = clean(
      pageview(
        { $pathname: "/talks/talk-05f9", $current_url: `${ORIGIN}/talks/talk-05f9`, title: "T" },
        { $set: { $title: "T", $raw_user_agent: "UA" }, $set_once: { title: "T" } },
      ),
    )
    expect(out?.properties).not.toHaveProperty("title")
    expect(out?.$set).toEqual({})
    expect(out?.$set_once).toEqual({})
  })

  test("strips query string and fragment from every URL and pathname", () => {
    const out = clean(
      pageview({
        $current_url: `${ORIGIN}/talks?q=private+search#frag`,
        $pathname: "/talks?q=x#y",
        $referrer: "https://www.google.com/search?q=who+am+i",
        $initial_current_url: `${ORIGIN}/events?event=evt-1#top`,
        $initial_referrer: "https://example.org/page?ref=me#x",
        $session_entry_url: `${ORIGIN}/?utm_source=mail`,
        $prev_pageview_pathname: "/societies?category=music",
        $initial_person_info: { r: "https://example.org/?a=1", u: `${ORIGIN}/about?b=2#c` },
        $referring_domain: "www.google.com",
      }),
    )
    const props = out?.properties ?? {}
    expect(props.$current_url).toBe(`${ORIGIN}/talks`)
    expect(props.$pathname).toBe("/talks")
    expect(props.$referrer).toBe("https://www.google.com/search")
    expect(props.$initial_current_url).toBe(`${ORIGIN}/events`)
    expect(props.$initial_referrer).toBe("https://example.org/page")
    expect(props.$session_entry_url).toBe(`${ORIGIN}/`)
    expect(props.$prev_pageview_pathname).toBe("/societies")
    expect(props.$initial_person_info).toEqual({ r: "https://example.org/", u: `${ORIGIN}/about` })
    expect(props.$referring_domain).toBe("www.google.com")
    // `$direct` is not a URL and stays.
    expect(clean(pageview({ $referrer: "$direct" }))?.properties.$referrer).toBe("$direct")
  })

  test("drops campaign parameters read from the query string", () => {
    const out = clean(
      pageview({
        utm_source: "mail",
        utm_campaign: "x",
        gclid: "g",
        fbclid: "f",
        $initial_utm_source: "mail",
        $session_entry_gclid: "g",
      }),
    )
    for (const key of [
      "utm_source",
      "utm_campaign",
      "gclid",
      "fbclid",
      "$initial_utm_source",
      "$session_entry_gclid",
    ]) {
      expect(out?.properties).not.toHaveProperty(key)
    }
  })

  test("drops every event on /dashboard and /sign-in", () => {
    for (const path of ["/dashboard", "/dashboard/people", "/sign-in", "/sign-in?next=/x"]) {
      expect(clean(pageview({ $pathname: path, $current_url: `${ORIGIN}${path}` }))).toBeNull()
      // Judged by the URL when the pathname is missing.
      expect(clean(pageview({ $pathname: undefined, $current_url: `${ORIGIN}${path}` }))).toBeNull()
      expect(
        clean({
          ...pageview({ $pathname: path, $current_url: `${ORIGIN}${path}` }),
          event: "$pageleave",
        }),
      ).toBeNull()
    }
  })

  test("a previous page or referrer in an untracked route is not revealed", () => {
    const out = clean(
      pageview({
        $prev_pageview_pathname: "/dashboard/organisations",
        $prev_pageview_duration: 12,
        $prev_pageview_max_scroll: 300,
        $referrer: `${ORIGIN}/sign-in?next=/dashboard`,
        $session_entry_pathname: "/dashboard",
      }),
    )
    const props = out?.properties ?? {}
    expect(Object.keys(props).filter((key) => key.startsWith("$prev_pageview_"))).toEqual([])
    expect(props.$referrer).toBe(ORIGIN)
    expect(props).not.toHaveProperty("$session_entry_pathname")
    // Another site's /dashboard is just a referrer.
    expect(
      clean(pageview({ $referrer: "https://example.org/dashboard?x=1" }))?.properties.$referrer,
    ).toBe("https://example.org/dashboard")
  })

  test("only pageview, pageleave and exception of the SDK's own events get through", () => {
    for (const event of ["$autocapture", "$rageclick", "$snapshot", "$web_vitals", "$identify"]) {
      expect(clean({ ...pageview({}), event })).toBeNull()
    }
    expect(clean({ ...pageview({}), event: "$pageleave" })).not.toBeNull()
    expect(clean({ ...pageview({}), event: "$exception" })).not.toBeNull()
    expect(clean(null)).toBeNull()
  })

  test("our own events need an allow-list entry and keep only its properties", () => {
    const event = (props: Record<string, unknown>) =>
      ({ ...pageview(props), event: "search_performed" }) as CaptureResult
    expect(clean(event({ queryLength: 4 }))).toBeNull()
    const out = clean(event({ queryLength: 4, resultCount: 2, query: "my name", email: "a@b.c" }), {
      search_performed: ["queryLength", "resultCount"],
    })
    expect(out?.properties.queryLength).toBe(4)
    expect(out?.properties.resultCount).toBe(2)
    expect(out?.properties).not.toHaveProperty("query")
    expect(out?.properties).not.toHaveProperty("email")
    expect(out?.properties.token).toBe(KEY)
    expect(out?.properties.$pathname).toBe("/societies")
  })

  test("tags environment and turns GeoIP off on every event", () => {
    const out = clean(pageview({ environment: "spoofed", $geoip_disable: false }))
    expect(out?.properties.environment).toBe("test")
    expect(out?.properties.$geoip_disable).toBe(true)
  })
})

/** A browser error as posthog-js builds it (`$exception_list`, @posthog/core
 * `ErrorProperties`), on a page with a query string. */
function exception(extra: Record<string, unknown> = {}) {
  return {
    uuid: "u",
    event: "$exception",
    properties: {
      token: KEY,
      distinct_id: "d",
      $current_url: `${ORIGIN}/talks?q=jane+doe#top`,
      $pathname: "/talks",
      $exception_level: "error",
      $exception_list: [
        {
          type: "TypeError",
          value: "Failed for jane@cam.ac.uk loading https://camsocs.uk/talks?q=jane+doe",
          mechanism: { handled: true, synthetic: false },
          stacktrace: {
            type: "raw",
            frames: [
              {
                platform: "web:javascript",
                filename: `${ORIGIN}/_next/static/chunks/app.js?dpl=dpl_abc#frag`,
                function: "TalksPage",
                lineno: 1,
                colno: 42,
                in_app: true,
                chunk_id: "debug-id",
              },
            ],
          },
        },
      ],
      $exception_steps: [{ $message: "typed jane" }],
      ...extra,
    },
  } as CaptureResult
}

describe("before_send for browser errors (ENG-6)", () => {
  test("lets $exception through with URLs and emails scrubbed", () => {
    const out = clean(exception())
    expect(out?.event).toBe("$exception")
    const props = out?.properties ?? {}
    expect(props.$current_url).toBe(`${ORIGIN}/talks`)
    expect(props.$exception_level).toBe("error")
    expect(props).not.toHaveProperty("$exception_steps")
    const [error] = props.$exception_list as Record<string, unknown>[]
    expect(error?.type).toBe("TypeError")
    expect(error?.value).toBe("Failed for [email] loading https://camsocs.uk/talks")
    const [frame] = (error?.stacktrace as { frames: Record<string, unknown>[] }).frames
    expect(frame).toEqual({
      platform: "web:javascript",
      filename: `${ORIGIN}/_next/static/chunks/app.js`,
      function: "TalksPage",
      lineno: 1,
      colno: 42,
      in_app: true,
      chunk_id: "debug-id",
    })
    const wire = JSON.stringify(out)
    for (const secret of ["jane", "dpl_abc", "frag", "#top"]) expect(wire).not.toContain(secret)
  })

  test("an error on /dashboard or /sign-in is dropped", () => {
    expect(
      clean(
        exception({ $current_url: `${ORIGIN}/dashboard/people`, $pathname: "/dashboard/people" }),
      ),
    ).toBeNull()
    expect(
      clean(exception({ $current_url: `${ORIGIN}/sign-in`, $pathname: "/sign-in" })),
    ).toBeNull()
  })

  test("is still dropped without a grant in force", () => {
    const send = beforeSend(posthogConfig("production"))
    expect(send(exception())).toBeNull()
    setConsent("granted")
    expect(send(exception())?.event).toBe("$exception")
    setConsent("denied")
    expect(send(exception())).toBeNull()
  })
})

describe("the exception-autocapture extension", () => {
  /** `loadPostHog()` imports it beside posthog-js, so the SDK finds its error
   * hooks in place at init and never fetches the script (external loading
   * stays off). This is the real module, not the recorder. */
  test("registers PostHog's error hooks when imported", async () => {
    await import("posthog-js/dist/exception-autocapture")
    const extensions = (window as unknown as Record<string, Record<string, unknown> | undefined>)
      .__PosthogExtensions__
    expect(extensions?.errorWrappingFunctions).toMatchObject({
      wrapOnError: expect.any(Function),
      wrapUnhandledRejection: expect.any(Function),
    })
  })
})

describe("captureBrowserException", () => {
  test("does nothing until the client runs, then reports through it", async () => {
    const error = new Error("boundary")
    captureBrowserException(error)
    startAnalytics({ key: KEY, environment: "test", load })
    captureBrowserException(error)
    expect(methods()).not.toContain("captureException")

    setConsent("granted")
    await settle()
    captureBrowserException(error)
    expect(calls).toContainEqual(["captureException", error])

    calls.length = 0
    setConsent("denied")
    captureBrowserException(error)
    expect(methods()).not.toContain("captureException")
  })
})

describe("the init options", () => {
  test("match the spec", () => {
    const config = posthogConfig("production")
    expect(config).toMatchObject({
      api_host: "/relay",
      ui_host: "https://eu.posthog.com",
      defaults: "2026-08-30",
      person_profiles: "identified_only",
      persistence: "localStorage+cookie",
      cookie_expiration: 180,
      autocapture: false,
      capture_pageview: "history_change",
      capture_pageleave: true,
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_surveys: true,
      advanced_disable_flags: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      // ENG-6: uncaught errors and rejections (consented visitors only), with
      // the extension bundled rather than fetched.
      capture_exceptions: true,
      disable_external_dependency_loading: true,
      save_campaign_params: false,
      // No URL in PostHog's cookie; no fragment; no scroll depth.
      save_referrer: false,
      disable_capture_url_hashes: true,
      disable_scroll_properties: true,
    })
    setConsent("granted")
    const out = beforeSend(config)(pageview({ title: "T" }))
    expect(out?.properties).not.toHaveProperty("title")
    expect(out?.properties.environment).toBe("production")
  })

  /** posthog-js cannot be unloaded: after a withdrawal it still runs (its
   * `reset()` even forgets its own opt-out), so the hook itself refuses
   * every event unless a grant is in force at that moment. */
  test("before_send lets nothing out without a grant in force", () => {
    const send = beforeSend(posthogConfig("production"))
    expect(send(pageview({}))).toBeNull()
    setConsent("granted")
    expect(send(pageview({}))).not.toBeNull()
    setConsent("denied")
    expect(send(pageview({}))).toBeNull()
    clearConsent()
    expect(send(pageview({}))).toBeNull()
  })
})

describe("loading", () => {
  test("waits for a grant, then initialises once with the key", async () => {
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    expect(loads).toBe(0)
    expect(methods()).not.toContain("init")
    expect(getPostHog()).toBeNull()

    setConsent("granted")
    await settle()
    expect(loads).toBe(1)
    expect(calls.filter(([method]) => method === "init")).toEqual([["init", KEY]])
    expect(initConfig?.api_host).toBe("/relay")
    expect(calls).toContainEqual(["register", { environment: "test", $geoip_disable: true }])
    expect(getPostHog()).toBe(fakePostHog as never)
  })

  test("a grant already in force initialises on load", async () => {
    setConsent("granted")
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    expect(methods()).toContain("init")
  })

  test("never loads without a key", async () => {
    setConsent("granted")
    startAnalytics({ key: undefined, environment: "test", load })
    await settle()
    startAnalytics({ key: "", environment: "test", load })
    await settle()
    expect(loads).toBe(0)
    expect(calls).toEqual([])
    expect(getPostHog()).toBeNull()
  })

  test("never loads in an automated browser", async () => {
    setWebdriver(true)
    setConsent("granted")
    startAnalytics({ key: KEY, environment: "test", load })
    setConsent("denied")
    setConsent("granted")
    await settle()
    expect(loads).toBe(0)
    expect(calls).toEqual([])
  })

  test("a refusal while the package downloads leaves it uninitialised", async () => {
    startAnalytics({ key: KEY, environment: "test", load })
    setConsent("granted")
    setConsent("denied")
    await settle()
    expect(methods()).not.toContain("init")
    expect(getPostHog()).toBeNull()
  })
})

describe("withdrawal", () => {
  test("opts out, resets, stops persistence and erases ph_ storage at once", async () => {
    setConsent("granted")
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    seedAnalyticsStorage()
    calls.length = 0

    setConsent("denied")
    expect(methods()).toEqual(["reset", "set_config", "opt_out_capturing"])
    expect(calls[1]).toEqual([
      "set_config",
      { disable_persistence: true, opt_out_capturing_by_default: true },
    ])
    expect(getPostHog()).toBeNull()
    expect(analyticsStorage()).toEqual([])
  })

  test("a cleared choice (the banner asks again) withdraws too", async () => {
    setConsent("granted")
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    calls.length = 0
    clearConsent()
    expect(methods()).toEqual(["reset", "set_config", "opt_out_capturing"])
    expect(getPostHog()).toBeNull()
  })

  test("a new grant on the same page opts the instance back in", async () => {
    setConsent("granted")
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    setConsent("denied")
    calls.length = 0
    setConsent("granted")
    await settle()
    expect(methods()).toEqual(["set_config", "opt_in_capturing", "register"])
    expect(calls[0]).toEqual([
      "set_config",
      { disable_persistence: false, opt_out_capturing_by_default: false },
    ])
    expect(calls[1]).toEqual(["opt_in_capturing", { captureEventName: false }])
    expect(getPostHog()).toBe(fakePostHog as never)
  })
})

describe("a page load without a grant", () => {
  test.each([
    ["no choice", () => {}],
    ["a refusal", () => setConsent("denied")],
    [
      "an expired grant",
      () =>
        window.localStorage.setItem(
          "camsocs-consent",
          JSON.stringify({ v: 1, choice: "granted", at: "2020-01-01T00:00:00.000Z" }),
        ),
    ],
  ])("with %s clears leftover ph_ storage, with or without a key", (_, arrange) => {
    for (const key of [KEY, undefined]) {
      arrange()
      seedAnalyticsStorage()
      expect(analyticsStorage().length).toBeGreaterThan(0)
      startAnalytics({ key, environment: "test", load })
      expect(analyticsStorage()).toEqual([])
      expect(methods()).not.toContain("init")
      resetAnalyticsForTests()
    }
  })

  test("a grant keeps the storage it allows", async () => {
    setConsent("granted")
    seedAnalyticsStorage()
    startAnalytics({ key: KEY, environment: "test", load })
    await settle()
    expect(analyticsStorage().length).toBeGreaterThan(0)
  })
})
