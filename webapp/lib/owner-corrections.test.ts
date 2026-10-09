import { describe, expect, test } from "bun:test"
import { CORRECTABLE_FIELDS } from "./listing-request"
import { fieldInput, initialText, OWNER_FIELDS, parseCorrection } from "./owner-corrections"

describe("owner corrections", () => {
  test("owners may correct what the form offers, except the logo", () => {
    expect([...OWNER_FIELDS]).toEqual(CORRECTABLE_FIELDS.filter((field) => field !== "logo"))
    for (const field of OWNER_FIELDS) expect(fieldInput(field).kind).toBeTruthy()
  })

  test("plain fields: text, links, addresses, yes/no, one choice", () => {
    expect(parseCorrection("name", "  CU Chess Club ")).toEqual({
      ok: true,
      value: "CU Chess Club",
    })
    expect(parseCorrection("shortDescription", "x".repeat(201)).ok).toBe(false)
    expect(parseCorrection("website", "https://cuchess.org/")).toEqual({
      ok: true,
      value: "https://cuchess.org/",
    })
    expect(parseCorrection("website", "cuchess.org").ok).toBe(false)
    expect(parseCorrection("email", "Chess@CUChess.org")).toEqual({
      ok: true,
      value: "chess@cuchess.org",
    })
    expect(parseCorrection("beginnerFriendly", "Yes")).toEqual({ ok: true, value: true })
    expect(parseCorrection("beginnerFriendly", "maybe").ok).toBe(false)
    expect(parseCorrection("level", "university")).toEqual({ ok: true, value: "university" })
    expect(parseCorrection("level", "galaxy").ok).toBe(false)
    expect(parseCorrection("name", "   ").ok).toBe(false)
  })

  test("lists: choices, lines, role addresses, socials, languages", () => {
    expect(parseCorrection("categories", "hobbies_games, academic, academic")).toEqual({
      ok: true,
      value: ["hobbies_games", "academic"],
    })
    expect(parseCorrection("categories", "chess").ok).toBe(false)
    expect(parseCorrection("aliases", "CUCC\n\nChess Soc\n")).toEqual({
      ok: true,
      value: ["CUCC", "Chess Soc"],
    })
    expect(
      parseCorrection("roleEmails", "president: Pres@cuchess.org\nsecretary: sec@cuchess.org"),
    ).toEqual({
      ok: true,
      value: [
        { role: "president", email: "pres@cuchess.org" },
        { role: "secretary", email: "sec@cuchess.org" },
      ],
    })
    expect(parseCorrection("roleEmails", "chef: x@cuchess.org").ok).toBe(false)
    expect(
      parseCorrection(
        "socials",
        "https://www.instagram.com/cuchess/\nfacebook_page https://example.org/cuchess\nhttps://www.facebook.com/groups/123",
      ),
    ).toEqual({
      ok: true,
      value: [
        { platform: "instagram", url: "https://www.instagram.com/cuchess/" },
        { platform: "facebook_page", url: "https://example.org/cuchess" },
        { platform: "facebook_group", url: "https://www.facebook.com/groups/123" },
      ],
    })
    expect(parseCorrection("socials", "https://example.org/cuchess").ok).toBe(false)
    expect(parseCorrection("languages", "EN\nde")).toEqual({ ok: true, value: ["en", "de"] })
    expect(parseCorrection("languages", "english").ok).toBe(false)
  })

  test("structured fields take JSON", () => {
    expect(parseCorrection("trials", '{"required": false}')).toEqual({
      ok: true,
      value: { required: false },
    })
    const bad = parseCorrection("membership", "£15 a year")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("tiers")
  })

  test("the editor starts from the proposed text, yes/no normalised", () => {
    expect(initialText("beginnerFriendly", "Y")).toBe("yes")
    expect(initialText("website", "https://x.org")).toBe("https://x.org")
    expect(initialText("name", undefined)).toBe("")
  })
})
