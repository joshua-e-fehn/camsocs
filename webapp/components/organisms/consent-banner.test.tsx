import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { CookieSettingsButton } from "@/components/molecules/cookie-settings-button"
import { ConsentBanner } from "@/components/organisms/consent-banner"
import { CONSENT_KEY, clearConsent, getConsent, setConsent } from "@/lib/consent"

/**
 * The consent banner on the page (spec "Consent model", law report §4):
 * shown until a choice, refusing exactly as prominent as accepting, gone
 * after either, back from the footer's "Cookie settings", and working for
 * the page even when the browser refuses storage.
 */

let root: Root | undefined

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(node))
  return container
}

function banner(): HTMLElement | null {
  return document.querySelector("[data-consent-banner]")
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  )
  if (!found) throw new Error(`no button "${name}"`)
  return found
}

async function click(element: HTMLElement) {
  await act(async () => element.click())
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  clearConsent()
  window.localStorage.clear()
  document.body.innerHTML = ""
})

describe("the consent banner", () => {
  test("is a labelled region with the disclosure while no choice is stored", async () => {
    await render(<ConsentBanner />)
    const region = banner()
    expect(region).not.toBeNull()
    expect(region?.tagName).toBe("SECTION")
    const title = document.getElementById(region?.getAttribute("aria-labelledby") ?? "")
    expect(title?.textContent).toBe("Analytics cookies")
    const text = region?.textContent ?? ""
    expect(text).toContain("PostHog (EU Cloud")
    expect(text).toContain("aggregate usage statistics")
    expect(text).toContain("ph_*")
    expect(text).toContain("180 days")
    expect(region?.querySelector('a[href="/privacy#cookies"]')).not.toBeNull()
    // Not a dialog: it blocks nothing and traps no focus.
    expect(region?.getAttribute("role")).toBeNull()
    expect(region?.getAttribute("aria-modal")).toBeNull()
  })

  test("offers both choices with identical styling", async () => {
    await render(<ConsentBanner />)
    const accept = button("Accept analytics")
    const reject = button("Reject")
    expect(accept.className).toBe(reject.className)
    expect(accept.dataset.variant).toBe(reject.dataset.variant)
    expect(accept.dataset.size).toBe(reject.dataset.size)
    expect(accept.type).toBe("button")
    expect(accept.className).toContain("min-h-11")
  })

  test("Accept stores granted and hides it", async () => {
    await render(<ConsentBanner />)
    await click(button("Accept analytics"))
    expect(banner()).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(CONSENT_KEY) ?? "{}")).toMatchObject({
      v: 1,
      choice: "granted",
    })
  })

  test("Reject stores denied and hides it", async () => {
    await render(<ConsentBanner />)
    await click(button("Reject"))
    expect(banner()).toBeNull()
    expect(getConsent()).toBe("denied")
  })

  test("stays hidden while a choice is in force", async () => {
    setConsent("granted")
    await render(<ConsentBanner />)
    expect(banner()).toBeNull()
  })

  test("Cookie settings reopens it, focused, and focus returns after a choice", async () => {
    setConsent("denied")
    await render(
      <>
        <CookieSettingsButton />
        <ConsentBanner />
      </>,
    )
    expect(banner()).toBeNull()
    const settings = button("Cookie settings")
    settings.focus()
    await click(settings)
    expect(banner()).not.toBeNull()
    expect(document.activeElement).toBe(banner())
    expect(banner()?.textContent).toContain("You currently refuse analytics.")
    await click(button("Accept analytics"))
    expect(banner()).toBeNull()
    expect(getConsent()).toBe("granted")
    expect(document.activeElement).toBe(settings)
  })

  test("still works for the page when storage throws", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError")
      },
    })
    try {
      await render(<ConsentBanner />)
      expect(banner()).not.toBeNull()
      await click(button("Reject"))
      expect(banner()).toBeNull()
      expect(getConsent()).toBe("denied")
    } finally {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor)
    }
  })

  test("is not in the server HTML (it cannot know the choice there)", () => {
    expect(renderToString(<ConsentBanner />)).toBe("")
  })
})
