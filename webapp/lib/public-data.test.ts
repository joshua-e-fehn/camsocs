import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PUBLIC_DATA_REVALIDATE } from "./public-data"

function run(env: Record<string, string>) {
  const result = Bun.spawnSync([process.execPath, "run", "lib/public-data.testing.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { stderr: new TextDecoder().decode(result.stderr), exitCode: result.exitCode }
}

// Isolate module mocks from the rest of the suite (which exercises real
// Convex queries). Verify the cache boundary, not Next's cache internals.
test("anonymous reads share one cache entry per function and arguments, with no token", () => {
  const { stderr, exitCode } = run({
    NEXT_PUBLIC_CONVEX_URL: "https://happy-otter-123.convex.cloud",
  })
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
})

test("a placeholder build marks every page that reads Convex dynamic", () => {
  const { stderr, exitCode } = run({
    NEXT_PUBLIC_CONVEX_URL: "https://placeholder-build-check-000.convex.cloud",
    PUBLIC_DATA_EXPECT_DEFERRED: "1",
  })
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
})

test("a cached read lives as long as the public page that makes it", () => {
  const layout = readFileSync(
    path.join(import.meta.dir, "..", "app", "(site)", "layout.tsx"),
    "utf8",
  )
  expect(/export const revalidate = (\d+)/.exec(layout)?.[1]).toBe(String(PUBLIC_DATA_REVALIDATE))
})
