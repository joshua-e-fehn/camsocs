import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  acceptsMemberAddress,
  SignInCard,
  type SignInOptions,
  signInMethods,
} from "@/components/organisms/login-form"
import { CAMBRIDGE } from "@/lib/campus"
import { TESTFORD } from "@/lib/campus/profiles/zz.testing"

/**
 * /sign-in offers only what the deployment has switched on
 * (`auth.getSignInOptions`), and says sign-in is not open when nothing is,
 * rather than showing dead buttons (ENG-35).
 */

let root: Root | undefined

async function render(options: SignInOptions | undefined, next?: string): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(<SignInCard options={options} next={next} />))
  return container
}

function buttons(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "")
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ""
})

describe("acceptsMemberAddress", () => {
  test("follows the campus profile, as the server's gate does", () => {
    // This build's campus is Cambridge: exactly @cam.ac.uk.
    expect(acceptsMemberAddress(" AB123@Cam.ac.uk ")).toBe(true)
    expect(acceptsMemberAddress("ab123@cam.ac.uk", CAMBRIDGE)).toBe(true)
    expect(acceptsMemberAddress("ab123@hermes.cam.ac.uk", CAMBRIDGE)).toBe(false)
    expect(acceptsMemberAddress("jane.doe@testford.ac.uk", CAMBRIDGE)).toBe(false)
    // Another campus takes its own member domain and refuses Cambridge's.
    expect(acceptsMemberAddress("jane.doe@testford.ac.uk", TESTFORD)).toBe(true)
    expect(acceptsMemberAddress("ab123@cam.ac.uk", TESTFORD)).toBe(false)
  })
})

describe("signInMethods", () => {
  test("lists the switched-on options, Cambridge first", () => {
    expect(signInMethods(undefined)).toBeUndefined()
    expect(signInMethods({ google: false, camEmail: false })).toEqual([])
    expect(signInMethods({ google: true, camEmail: false })).toEqual(["google"])
    expect(signInMethods({ google: true, camEmail: true })).toEqual(["cam", "google"])
  })
})

describe("the sign-in card", () => {
  test("with nothing switched on, says so and links back instead of offering buttons", async () => {
    const page = await render({ google: false, camEmail: false }, "/events?view=list")
    const text = page.textContent ?? ""
    expect(text).toContain("Sign-in is not open yet")
    expect(text).not.toContain("not configured")
    expect(text).toContain("Cambridge-only events stay hidden")
    expect(page.querySelector("form")).toBeNull()
    expect(page.querySelector('[aria-label="Sign-in method"]')).toBeNull()
    expect(page.querySelector("a")?.getAttribute("href")).toBe("/events?view=list")
  })

  test("with only Google, shows the admin button and no toggle", async () => {
    const page = await render({ google: true, camEmail: false })
    expect(page.querySelector('[aria-label="Sign-in method"]')).toBeNull()
    expect(buttons(page)).toContain("Continue with Google")
    expect(page.querySelector("button[disabled]")).toBeNull()
    expect(page.textContent).toContain("For the CAMsocs administrator")
  })

  test("with only the Cambridge link, shows its form and no toggle", async () => {
    const page = await render({ google: false, camEmail: true })
    expect(page.querySelector('[aria-label="Sign-in method"]')).toBeNull()
    expect(page.querySelector("input#cam-email")).not.toBeNull()
    expect(buttons(page)).not.toContain("Continue with Google")
  })

  test("with both, opens on the Cambridge option with a toggle to Admin", async () => {
    const page = await render({ google: true, camEmail: true })
    expect(page.querySelector('[aria-label="Sign-in method"]')).not.toBeNull()
    expect(page.querySelector("input#cam-email")).not.toBeNull()
    expect(page.textContent).toContain("Cambridge members see Cambridge-only events")
  })

  test("while loading, shows neither options nor the not-open message", async () => {
    const page = await render(undefined)
    expect(page.querySelector("form")).toBeNull()
    expect(page.textContent).not.toContain("not open")
    expect(page.querySelector("[aria-busy]")).not.toBeNull()
  })
})
