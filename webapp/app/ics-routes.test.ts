import { expect, test } from "bun:test"

/**
 * The `.ics` route handlers count what they serve (ENG-7): `ics_feed_fetched
 * { feed, key? }` through `captureServerEvent` inside `after()`, never for a
 * 400 / 404 / 503, never with the feed's filters, and with the response
 * (status, headers including Cache-Control, body) the same whether the
 * capture works, rejects, throws or `after()` itself throws.
 *
 * The assertions live in `ics-routes.testing.ts`, run in its own process so
 * its module mocks (Convex, the session, `next/server`, the PostHog sender)
 * never leak into the rest of the suite.
 */
test("the .ics routes count served responses without changing them", () => {
  const result = Bun.spawnSync([process.execPath, "run", "app/ics-routes.testing.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(new TextDecoder().decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
})
