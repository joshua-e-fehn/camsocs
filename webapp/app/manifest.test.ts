import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SECURITY_CONTACT_EMAIL, THEME_COLOR } from "@/lib/site"
import manifest from "./manifest"

/** The files phones, browsers and security researchers probe for
 * (manifest-security-txt-hsts); each was a dynamic 404 render. */
const PUBLIC = join(import.meta.dir, "..", "public")

test("the web manifest names the site, its light colour and its icons", () => {
  const data = manifest()
  expect(data).toMatchObject({
    short_name: "CAMsocs",
    start_url: "/",
    theme_color: THEME_COLOR,
    background_color: THEME_COLOR,
  })
  for (const icon of data.icons ?? []) {
    expect(existsSync(join(import.meta.dir, icon.src.slice(1)))).toBe(true)
  }
})

test("an apple-touch-icon is served where iOS looks without a link tag", () => {
  const icon = readFileSync(join(PUBLIC, "apple-touch-icon.png"))
  expect([...icon.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG")
})

test("security.txt (RFC 9116) gives the contact address and a valid expiry", () => {
  const text = readFileSync(join(PUBLIC, ".well-known", "security.txt"), "utf8")
  const field = (name: string) => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]
  expect(field("Contact")).toBe(`mailto:${SECURITY_CONTACT_EMAIL}`)
  const expires = Date.parse(field("Expires") ?? "")
  expect(Number.isNaN(expires)).toBe(false)
  // RFC 9116 2.5.5: less than a year ahead, so a stale file cannot linger.
  expect(expires - Date.now()).toBeLessThan(365 * 24 * 60 * 60 * 1000)
  expect(field("Canonical")).toBe("https://camsocs.uk/.well-known/security.txt")
})
