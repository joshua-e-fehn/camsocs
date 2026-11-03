import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import TermsPage from "@/app/(site)/terms/page"
import { SiteFooter } from "@/components/organisms/site-footer"
import { formatDate } from "@/lib/calendar"
import { CONTACT_EMAIL, DISCLAIMER, TERMS_UPDATED } from "@/lib/site"

/**
 * The terms of use (ENG-34): unofficial, accuracy not guaranteed, no liability
 * for events others run, how to correct or remove something, and the law of
 * England and Wales; reachable from every footer.
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

afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ""
})

function section(page: HTMLElement, id: string): string {
  const element = page.querySelector(`section#${id}`)
  expect(element).not.toBeNull()
  return element?.textContent ?? ""
}

describe("Terms of use", () => {
  test("says the site is unofficial and accuracy is not guaranteed", async () => {
    const page = await render(<TermsPage />)
    expect(section(page, "unofficial")).toContain(DISCLAIMER)
    expect(section(page, "accuracy")).toContain("We do not guarantee")
    expect(section(page, "others")).toContain("run by others")
  })

  test("limits liability only as far as the law allows", async () => {
    const liability = section(await render(<TermsPage />), "liability")
    expect(liability).toContain("As far as the law allows")
    expect(liability).toContain("death or personal injury caused by negligence")
  })

  test("says how to correct or remove something, and links the takedown route", async () => {
    const page = await render(<TermsPage />)
    expect(section(page, "correct")).toContain("request form")
    expect(page.querySelector('a[href="/request"]')).not.toBeNull()
    expect(page.querySelector('a[href="/about#copyright"]')).not.toBeNull()
    expect(page.querySelector('a[href="/privacy#rights"]')).not.toBeNull()
    expect(page.querySelector(`a[href="mailto:${CONTACT_EMAIL}"]`)).not.toBeNull()
  })

  test("is governed by the law of England and Wales, and dated", async () => {
    const page = await render(<TermsPage />)
    expect(section(page, "law")).toContain("law of England and Wales")
    expect(page.textContent).toContain(`Last updated ${formatDate(TERMS_UPDATED)}`)
  })

  test("every footer links to it", async () => {
    const footer = await render(<SiteFooter clock={null} />)
    const link = footer.querySelector('a[href="/terms"]')
    expect(link?.textContent).toBe("Terms of use")
  })
})
