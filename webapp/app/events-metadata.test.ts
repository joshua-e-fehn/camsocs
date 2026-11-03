import { expect, test } from "bun:test"

/**
 * The /events page's robots and canonical for one society's calendar (SEO
 * re-check 2026-11-03, events-param-urls). The assertions live in
 * `events-metadata.testing.ts`, run in its own process so its Convex mock
 * never leaks into the rest of the suite.
 */
test("a society's calendar is indexable only while it lists an event", () => {
  const result = Bun.spawnSync([process.execPath, "run", "app/events-metadata.testing.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
})
