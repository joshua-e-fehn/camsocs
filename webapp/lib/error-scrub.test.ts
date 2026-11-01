import { describe, expect, test } from "bun:test"
import { MAX_TEXT, scrubErrorText, scrubExceptionList, scrubExceptionProps } from "./error-scrub"

/**
 * Error reports (ENG-6, hard rule 2): no query string, fragment or email
 * address survives in a message, a type or a stack, wherever it appears, and
 * frames keep only the path of their file and no source lines.
 */

describe("scrubErrorText", () => {
  test("cuts query strings and fragments off URLs and paths", () => {
    expect(
      scrubErrorText(
        "Failed to fetch https://camsocs.uk/talks?q=jane+doe&page=2#top (from /societies?search=chess)",
      ),
    ).toBe("Failed to fetch https://camsocs.uk/talks (from /societies)")
    expect(scrubErrorText("GET /api/thing?token=abc failed")).toBe("GET /api/thing failed")
    expect(scrubErrorText('fetch("https://x.example/a?b=c")')).toBe('fetch("https://x.example/a")')
  })

  test("replaces email addresses", () => {
    expect(scrubErrorText("No account for jane.doe+test@cam.ac.uk, try again")).toBe(
      "No account for [email], try again",
    )
    expect(scrubErrorText("mailto:president@society.example.org")).toBe("mailto:[email]")
  })

  test("leaves ordinary messages and stack lines alone", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'key')",
      "    at TalkPage (/var/task/.next/server/chunks/ssr/app_talks_abc123._.js:1:2345)",
      "    at async Promise.all (index 0)",
      "    at Foo.#bar (file:///var/task/x.js:3:4)",
    ].join("\n")
    expect(scrubErrorText(stack)).toBe(stack)
  })

  test("caps the length", () => {
    expect(scrubErrorText("x".repeat(MAX_TEXT + 50))).toHaveLength(MAX_TEXT)
  })
})

describe("scrubExceptionList", () => {
  test("scrubs messages, keeps only frame paths and drops source lines", () => {
    const list = scrubExceptionList([
      {
        type: "Error",
        value: "Lookup failed for a@b.co at https://camsocs.uk/events?when=today",
        mechanism: { handled: false, type: "onerror" },
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              filename: "https://camsocs.uk/_next/static/chunks/main.js?dpl=dpl_123#x",
              abs_path: "https://camsocs.uk/_next/static/chunks/main.js?dpl=dpl_123",
              function: "onClick",
              lineno: 1,
              colno: 99,
              in_app: true,
              chunk_id: "debug-id-1",
              context_line: "const email = 'a@b.co'",
              pre_context: ["line"],
              post_context: ["line"],
              vars: { secret: "x" },
            },
            "not a frame",
          ],
        },
      },
      "not an exception",
    ])
    expect(list).toEqual([
      {
        type: "Error",
        value: "Lookup failed for [email] at https://camsocs.uk/events",
        mechanism: { handled: false, type: "onerror" },
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              filename: "https://camsocs.uk/_next/static/chunks/main.js",
              abs_path: "https://camsocs.uk/_next/static/chunks/main.js",
              function: "onClick",
              lineno: 1,
              colno: 99,
              in_app: true,
              chunk_id: "debug-id-1",
            },
          ],
        },
      },
    ])
  })

  test("anything but a list says nothing", () => {
    expect(scrubExceptionList("TypeError: boom")).toEqual([])
    expect(scrubExceptionList(undefined)).toEqual([])
  })
})

describe("scrubExceptionProps", () => {
  test("scrubs flat exception strings and removes breadcrumbs", () => {
    const props: Record<string, unknown> = {
      $exception_message: "bad /talks?q=x for x@y.org",
      $exception_steps: [{ $message: "clicked", email: "x@y.org" }],
      $exception_list: "garbage",
      $pathname: "/talks",
    }
    scrubExceptionProps(props)
    expect(props).toEqual({
      $exception_message: "bad /talks for [email]",
      $exception_list: [],
      $pathname: "/talks",
    })
  })
})
