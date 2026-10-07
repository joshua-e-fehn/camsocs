import { describe, expect, test } from "bun:test"
import { emptyDraft, isRequestKind, validateDraft } from "./listing-request"

const chess = { key: "org-cu-chess-club", name: "CU Chess Club" }

describe("validateDraft", () => {
  test("a correction becomes submit args with only the filled fields", () => {
    const result = validateDraft({
      ...emptyDraft("correct", chess),
      email: " Sec@CUChess.org ",
      role: "Secretary",
      message: "Training moved to Thursdays.",
      corrections: [
        { field: "timeCommitment", value: " Thursdays 7pm " },
        { field: "website", value: "" },
      ],
    })
    expect(result).toEqual({
      ok: true,
      args: {
        kind: "correct",
        orgKey: "org-cu-chess-club",
        submitterEmail: "Sec@CUChess.org",
        role: "Secretary",
        message: "Training moved to Thursdays.",
        fields: { timeCommitment: "Thursdays 7pm" },
      },
    })
  })

  test("an add request carries the name and link instead of a listing", () => {
    const result = validateDraft({
      ...emptyDraft("add"),
      newName: "CU Go Society",
      newLink: "https://go.example.org/",
      email: "go@example.org",
      message: "We meet on Wednesdays.",
    })
    expect(result.ok && result.args).toEqual({
      kind: "add",
      submitterEmail: "go@example.org",
      message: "We meet on Wednesdays.",
      fields: { name: "CU Go Society", website: "https://go.example.org/" },
    })
  })

  test("names every problem at once, in the visitor's terms", () => {
    const result = validateDraft({
      ...emptyDraft("remove"),
      email: "not-an-email",
      message: "short",
      role: "x".repeat(101),
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      "email",
      "message",
      "org",
      "role",
    ])
  })

  test("an add request needs a name, and a link must be http(s)", () => {
    const result = validateDraft({
      ...emptyDraft("add"),
      newLink: "javascript:alert(1)",
      email: "a@example.org",
      message: "Please add this one.",
    })
    expect(!result.ok && result.errors).toEqual({
      newName: "Give the society's name.",
      newLink: "Give a full web address starting with https://, or leave this empty.",
    })
  })

  test("corrections must name a known field", () => {
    const result = validateDraft({
      ...emptyDraft("correct", chess),
      email: "a@example.org",
      message: "One correction below.",
      corrections: [{ field: "isCounterpartX", value: "yes" }],
    })
    expect(!result.ok && result.errors.corrections).toBeDefined()
  })

  test("isRequestKind", () => {
    expect(isRequestKind("object")).toBe(true)
    expect(isRequestKind("delete")).toBe(false)
    expect(isRequestKind(undefined)).toBe(false)
  })
})
