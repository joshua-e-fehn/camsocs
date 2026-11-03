import { expect, test } from "bun:test"

/**
 * An event page's title with its start time when another of its name starts
 * at another time that day (SEO re-check 2026-11-03, duplicate-event-titles).
 * The assertions live in `event-metadata.testing.ts`, run in its own process
 * so its Convex mock never leaks into the rest of the suite.
 */
test("a repeated event's page title gets its start time", () => {
  const result = Bun.spawnSync([process.execPath, "run", "app/event-metadata.testing.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
})
