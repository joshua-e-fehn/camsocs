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
    ).toBe("Failed to fetch https://camsocs.uk/talks (from /societies")
    expect(scrubErrorText("GET /api/thing?token=abc failed")).toBe("GET /api/thing failed")
    expect(scrubErrorText("redirect to https://x.example/a#access_token=abc")).toBe(
      "redirect to https://x.example/a",
    )
  })

  test("fails closed: the rest of the word after a ? goes, brackets and quotes included", () => {
    // Browsers leave these unencoded in a query, so a scrub that stopped at
    // them would let the rest of a search through.
    expect(scrubErrorText('fetch("https://x.example/a?b=c")')).toBe('fetch("https://x.example/a')
    expect(scrubErrorText("GET /search?q=foo(bar)&email=x")).toBe("GET /search")
    expect(scrubErrorText("https://camsocs.uk/talks?q='Jane")).toBe("https://camsocs.uk/talks")
    expect(scrubErrorText("https://react.dev/errors/31?args[]=object%20with%20keys")).toBe(
      "https://react.dev/errors/31",
    )
    // A relative path, with no scheme or leading slash.
    expect(scrubErrorText("bad link talks?q=secret here")).toBe("bad link talks here")
  })

  test("replaces email addresses", () => {
    expect(scrubErrorText("No account for jane.doe+test@cam.ac.uk, try again")).toBe(
      "No account for [email], try again",
    )
    expect(scrubErrorText("mailto:president@society.example.org")).toBe("mailto:[email]")
    expect(scrubErrorText("GET /u/john%40example.com failed")).toBe("GET /u/[email] failed")
  })

  test("leaves ordinary messages and stack lines alone", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'key')",
      "    at TalkPage (/var/task/.next/server/chunks/ssr/app_talks_abc123._.js:1:2345)",
      "    at async Promise.all (index 0)",
      "    at Foo.#bar (file:///var/task/x.js:3:4)",
      "Did you mean #main? Try again.",
    ].join("\n")
    expect(scrubErrorText(stack)).toBe(stack)
  })

  test("takes linear time on long input with nothing to scrub", () => {
    // The regexes only ever see the first MAX_TEXT characters plus a margin,
    // so a long path or message cannot stall a server instance or a tab.
    for (const text of ["/".repeat(200_000), "a".repeat(200_000), "/a".repeat(100_000)]) {
      const started = performance.now()
      expect(scrubErrorText(text)).toHaveLength(MAX_TEXT)
      expect(performance.now() - started).toBeLessThan(50)
    }
  })

  test("scrubs an email address or query string that straddles the cap", () => {
    const pad = "x ".repeat((MAX_TEXT - 10) / 2)
    expect(scrubErrorText(`${pad}jane.doe@cam.ac.uk tail`)).not.toContain("jane")
    expect(scrubErrorText(`${pad}/talks?q=jane+doe`)).not.toContain("jane")
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
