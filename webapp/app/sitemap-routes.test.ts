import { expect, test } from "bun:test"

/**
 * The sitemap routes (lib/sitemap.ts): the index, each file with its
 * lastmod, every page of a paginated read, a 404 for an unknown file and a
 * 503 — never a partial 200 — when the backend fails. The assertions live in
 * `sitemap-routes.testing.ts`, run in its own process so its Convex mock never
 * leaks into the rest of the suite.
 */
test("the sitemap routes serve whole files or a 503", () => {
  const result = Bun.spawnSync([process.execPath, "run", "app/sitemap-routes.testing.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
})
