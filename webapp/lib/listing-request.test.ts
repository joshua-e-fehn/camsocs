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

  test("a request from an event page names the event, unless it becomes an add", () => {
    const eventKey = `evt-${"c".repeat(40)}`
    const draft = {
      ...emptyDraft("correct", chess, eventKey),
      email: "a@example.org",
      message: "The start time is wrong.",
    }
    expect(validateDraft(draft)).toMatchObject({ ok: true, args: { orgKey: chess.key, eventKey } })
    const add = validateDraft({ ...draft, kind: "add", newName: "CU Go Society" })
    expect(add.ok && add.args).not.toHaveProperty("eventKey")
  })

  test("a correction about an event may name no listing (event-correction-no-org)", () => {
    const eventKey = `evt-${"d".repeat(40)}`
    const draft = {
      ...emptyDraft("correct", null, eventKey),
      email: "a@example.org",
      message: "The room has changed.",
    }
    const result = validateDraft(draft)
    expect(result).toMatchObject({ ok: true, args: { kind: "correct", eventKey } })
    expect(result.ok && result.args).not.toHaveProperty("orgKey")
    for (const kind of ["claim", "remove", "object"] as const) {
      const other = validateDraft({ ...draft, kind })
      expect(!other.ok && other.errors.org).toBe("Choose the listing this is about.")
    }
    const cleared = validateDraft({ ...draft, eventKey: null })
    expect(!cleared.ok && cleared.errors.org).toBe("Choose the listing this is about.")
  })

  test("isRequestKind", () => {
    expect(isRequestKind("object")).toBe(true)
    expect(isRequestKind("delete")).toBe(false)
    expect(isRequestKind(undefined)).toBe(false)
  })
})
