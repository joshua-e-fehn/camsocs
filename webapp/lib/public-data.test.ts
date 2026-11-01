import { expect, test } from "bun:test"

// Isolate module mocks from the rest of the suite (which exercises real
// Convex queries). Verify the cache boundary, not Next's cache internals.
test("anonymous preloads share a cache; authenticated results never enter it", () => {
  const result = Bun.spawnSync([process.execPath, "run", "lib/public-data.testing.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
})
