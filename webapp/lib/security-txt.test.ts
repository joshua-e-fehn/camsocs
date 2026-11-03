import { describe, expect, test } from "bun:test"
import { securityTxt } from "@/lib/security-txt"
import { CONTACT_EMAIL, SECURITY_TXT_EXPIRES } from "@/lib/site"

describe("security.txt", () => {
  test("names the contact address and an Expires date, one field per line", () => {
    const lines = securityTxt().trimEnd().split("\n")
    expect(lines).toContain(`Contact: mailto:${CONTACT_EMAIL}`)
    expect(lines).toContain(`Expires: ${SECURITY_TXT_EXPIRES}`)
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Za-z-]+: \S+$/)
  })

  test("Expires is a full ISO 8601 instant (RFC 9116 §2.5.5)", () => {
    expect(SECURITY_TXT_EXPIRES).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(new Date(SECURITY_TXT_EXPIRES).toISOString()).toBe(SECURITY_TXT_EXPIRES)
  })
})
