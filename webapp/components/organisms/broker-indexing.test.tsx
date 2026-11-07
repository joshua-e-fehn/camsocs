import { describe, expect, test } from "bun:test"
import type { FunctionReturnType } from "convex/server"
import { renderToString } from "react-dom/server"
import { IndexingView } from "@/components/organisms/broker-indexing"
import type { api } from "@/convex/_generated/api"

type Summary = NonNullable<FunctionReturnType<typeof api.indexing.summary>>

const NOW = Date.UTC(2026, 10, 8, 7)
const zero = { indexed: 0, waiting: 0, not_indexed: 0, problem: 0, unchecked: 0 }

/** Synthetic numbers and invented URLs only. */
const SUMMARY: Summary = {
  runAt: NOW,
  inspected: 1234,
  counts: {
    page: { ...zero, indexed: 9, waiting: 3, problem: 1 },
    hub: { ...zero, indexed: 8, waiting: 9 },
    society: { ...zero, indexed: 500 },
    event: { ...zero, waiting: 400 },
  },
  problems: [
    { url: "https://example.org/terms", kind: "page", problem: "our page carries noindex" },
  ],
  lagging: [
    {
      url: "https://example.org/guides",
      kind: "page",
      listedSince: NOW - 12 * 86_400_000,
      state: "waiting",
    },
  ],
  sitemaps: [{ path: "/sitemaps/events.xml", issue: "not read for 5 days" }],
  alerts: ["1 sitemap URL cannot be indexed: /terms (our page carries noindex)"],
}

describe("IndexingView", () => {
  test("counts per kind, the problems, the lagging key pages and the sitemap issue", () => {
    const html = renderToString(<IndexingView summary={SUMMARY} />)
    expect(html).toContain("Google indexing")
    expect(html).toContain("1 to fix")
    expect(html).toContain("/terms")
    expect(html).toContain("our page carries noindex")
    expect(html).toContain("/guides")
    expect(html).toContain("waiting for Google")
    expect(html).toContain("not read for 5 days")
    expect(html).toContain("1,234")
  })

  test("before the first run, and with nothing to fix", () => {
    expect(renderToString(<IndexingView summary={null} />)).toContain("Not checked yet")
    const clean = renderToString(
      <IndexingView summary={{ ...SUMMARY, problems: [], lagging: [], alerts: [] }} />,
    )
    expect(clean).toContain("Nothing to fix")
    expect(clean).not.toContain("/terms")
  })
})
