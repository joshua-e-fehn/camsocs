import { afterEach, describe, expect, test } from "bun:test"
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { HeaderAccount } from "@/components/organisms/public-header"

/**
 * The header offers Sign in only while the @cam.ac.uk sign-in link is on,
 * the one sign-in a visitor can use; signed in, the account menu is there
 * either way (ENG-35). Both places are checked: the desktop menu's trigger
 * (its Sign in sits inside it) and the mobile sheet's links.
 */

type Props = ComponentProps<typeof HeaderAccount>

const SIGNED_OUT = { signedIn: false, isBroker: false, isCamVerified: false }
const SIGNED_IN = { signedIn: true, isBroker: false, isCamVerified: false }
const OFF = { google: false, camEmail: false }
const CAM_ON = { google: false, camEmail: true }

let root: Root | undefined

async function render(props: Omit<Props, "onSignOut">): Promise<HTMLElement> {
  const container = document.createElement("div")
  document.body.append(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(container)
  await act(async () => root?.render(<HeaderAccount {...props} onSignOut={() => {}} />))
  return container
}

async function unmount() {
  await act(async () => root?.unmount())
  root = undefined
}

function signInLinks(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('a[href^="/sign-in"]')]
}

function accountTrigger(container: HTMLElement): Element | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Account"))
}

afterEach(async () => {
  await unmount()
  document.body.innerHTML = ""
})

describe("the header's account menu", () => {
  test("signed out with the Cambridge link off: no menu and no Sign in, in either place", async () => {
    for (const place of ["menu", "sheet"] as const) {
      const header = await render({ place, access: SIGNED_OUT, signInOptions: OFF })
      expect(header.innerHTML).toBe("")
      expect(signInLinks(header)).toEqual([])
      await unmount()
    }
  })

  test("signed out while the options are loading: nothing yet", async () => {
    const header = await render({ place: "sheet", access: SIGNED_OUT, signInOptions: undefined })
    expect(header.innerHTML).toBe("")
  })

  test("signed out with the Cambridge link on: the menu, and Sign in in the sheet", async () => {
    const menu = await render({ place: "menu", access: SIGNED_OUT, signInOptions: CAM_ON })
    expect(accountTrigger(menu)).toBeDefined()
    await unmount()
    const sheet = await render({ place: "sheet", access: SIGNED_OUT, signInOptions: CAM_ON })
    expect(signInLinks(sheet).map((a) => a.textContent?.trim())).toEqual(["Sign in"])
  })

  test("signed in: the menu is there whether or not the link is on", async () => {
    for (const signInOptions of [OFF, CAM_ON]) {
      const menu = await render({ place: "menu", access: SIGNED_IN, signInOptions })
      expect(accountTrigger(menu)?.textContent).toContain("Account (signed in)")
      await unmount()
      const sheet = await render({ place: "sheet", access: SIGNED_IN, signInOptions })
      expect(sheet.textContent).toContain("Sign out")
      expect(signInLinks(sheet)).toEqual([])
      await unmount()
    }
  })
})
