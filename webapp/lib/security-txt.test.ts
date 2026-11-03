import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { securityTxt } from "@/lib/security-txt"
import { CONTACT_EMAIL, SECURITY_TXT_EXPIRES } from "@/lib/site"

describe("security.txt", () => {
  test("names the contact address, an Expires date and the policy, one field per line", () => {
    const lines = securityTxt()
      .trimEnd()
      .split("\n")
      .filter((line) => !line.startsWith("#"))
    expect(lines).toContain(`Contact: mailto:${CONTACT_EMAIL}`)
    expect(lines).toContain(`Expires: ${SECURITY_TXT_EXPIRES}`)
    expect(lines).toContain("Policy: https://camsocs.uk/about#security")
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Za-z-]+: \S+$/)
  })

  test("Expires is a full ISO 8601 instant (RFC 9116 §2.5.5)", () => {
    expect(SECURITY_TXT_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(new Date(SECURITY_TXT_EXPIRES).toISOString()).toBe(SECURITY_TXT_EXPIRES)
  })

  test("the served static file is exactly this text", () => {
    const file = join(import.meta.dir, "..", "public", ".well-known", "security.txt")
    expect(readFileSync(file, "utf8")).toBe(securityTxt())
  })
})
