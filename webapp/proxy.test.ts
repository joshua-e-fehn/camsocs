import { describe, expect, test } from "bun:test"
import { boundaryRedirect, config } from "./proxy"

/**
 * The proxy's matcher decides which requests it ever sees. The talks pillar's
 * AI-agent 403 (owner decisions G1 and G6, lib/crawlers.ts) must see every
 * request under /talks: a prefetch header is the agent's to send, so no
 * entry for /talks may be skipped on one (review of 2026-11-02).
 */

type Entry = { source: string; missing?: unknown[]; has?: unknown[] }

const entries = config.matcher as Entry[]

describe("the proxy matcher", () => {
  test("matches the talks pillar and its feed with no conditions", () => {
    for (const source of ["/talks/:path*", "/talks.ics"]) {
      const entry = entries.find((row) => row.source === source)
      expect(entry).toBeDefined()
      expect(entry?.missing).toBeUndefined()
      expect(entry?.has).toBeUndefined()
    }
  })

  test("keeps router and speculative prefetches off the society and event gates", () => {
    for (const source of ["/societies/:key", "/events/:key"]) {
      const entry = entries.find((row) => row.source === source)
      expect(entry?.missing?.length).toBe(3)
    }
  })
})

describe("the talks boundary's redirect", () => {
  test("is a 308 on the same host that no browser stores", () => {
    const from = new URL(`http://localhost:3000/events/evt-${"0".repeat(40)}?ref=x`)
    const response = boundaryRedirect(from, `/talks/events/evt-${"0".repeat(40)}`)
    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(
      `http://localhost:3000/talks/events/evt-${"0".repeat(40)}?ref=x`,
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
