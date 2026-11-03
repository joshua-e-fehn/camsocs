import { mock } from "bun:test"
import assert from "node:assert/strict"

// Run in its own process (lib/public-data.test.ts): the module mocks below
// would otherwise replace convex/nextjs for the rest of the suite.

const calls: { name: string; args: unknown; options?: unknown }[] = []
const cachedValues = new Map<string, unknown>()
let connections = 0
/** Set to make the next read fail as an unreachable deployment would. */
let failNext: unknown
/** What `connection()` does: nothing (a request), or Next's bail-out
 * during a prerender, which must never be swallowed. */
let connectionThrows: unknown
const warnings: string[] = []
console.warn = (...parts: unknown[]) => {
  warnings.push(parts.map(String).join(" "))
}

/** Next's control-flow errors carry a `digest`; `unstable_rethrow` rethrows them. */
class NextControlFlow extends Error {
  digest = "DYNAMIC_SERVER_USAGE"
}

mock.module("convex/nextjs", () => ({
  preloadQuery: async (query: unknown, args: unknown, options?: unknown) => {
    const { getFunctionName } = await import("convex/server")
    const name = getFunctionName(query as never)
    calls.push({ name, args, options })
    if (failNext !== undefined) {
      const error = failNext
      failNext = undefined
      throw error
    }
    return { _name: name, _argsJSON: args, _valueJSON: { name, invocation: calls.length } }
  },
  preloadedQueryResult: (preloaded: { _valueJSON: unknown }) => preloaded._valueJSON,
}))
mock.module("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    key: string[],
    options: { revalidate: number },
  ) => {
    assert.equal(options.revalidate, 300)
    assert.equal(key[0], "public-query-v1")
    return async (...args: unknown[]) => {
      // Next's own key: the key parts and the JSON of the arguments.
      const cacheKey = JSON.stringify([key, args])
      if (!cachedValues.has(cacheKey)) cachedValues.set(cacheKey, await fn(...args))
      return cachedValues.get(cacheKey)
    }
  },
}))
mock.module("next/server", () => ({
  connection: async () => {
    connections++
    if (connectionThrows !== undefined) throw connectionThrows
  },
}))
mock.module("next/navigation", () => ({
  unstable_rethrow: (error: unknown) => {
    if (error instanceof NextControlFlow) throw error
  },
}))

const { api } = await import("@/convex/_generated/api")
const { publicPreload, publicQuery } = await import("./public-data")

// One read per function and arguments, whichever helper asks.
const args = { from: 1, to: 2 }
const first = await publicPreload(api.events.list, args)
assert.deepEqual(await publicPreload(api.events.list, args), first)
assert.deepEqual(await publicQuery(api.events.list, args), first._valueJSON)
assert.equal(calls.length, 1)
assert.equal(calls[0].name, "events:list")
await publicPreload(api.events.list, { from: 2, to: 3 })
assert.equal(calls.length, 2)
await publicQuery(api.events.restrictedCount, args)
assert.equal(calls.length, 3, "another function with the same arguments is another entry")
await publicQuery(api.orgs.colleges, {})
await publicQuery(api.orgs.colleges, {})
assert.equal(calls.length, 4)

// Anonymous: no read carries a token or any other option.
assert(calls.every((call) => call.options === undefined))

// A real deployment's build never defers its pages; the placeholder's build
// defers every read (lib/public-data.test.ts sets which this run is).
if (process.env.PUBLIC_DATA_EXPECT_DEFERRED === "1") assert.equal(connections, 7)
else assert.equal(connections, 0)

// Review of the SEO audit 2026-11-02 (build-coupling): a failed read degrades
// during `next build` only. Fresh arguments each time, so the cache misses.
// Against a real deployment only: the placeholder defers before any read.
if (process.env.PUBLIC_DATA_EXPECT_DEFERRED !== "1") {
  const before = connections
  const unreachable = new Error("fetch failed: deployment unreachable")
  const settle = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error: unknown) => error,
    )

  // Outside the build: the error propagates unchanged, no warning, no deferral.
  delete process.env.NEXT_PHASE
  failNext = unreachable
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 1 } as never)), unreachable)
  assert.equal(connections, before)
  assert.deepEqual(warnings, [])

  // A running server (`next start`) is not the build either.
  process.env.NEXT_PHASE = "phase-production-server"
  failNext = unreachable
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 2 } as never)), unreachable)
  assert.equal(connections, before)

  // During the build: one warning naming the function, then `connection()`,
  // whose bail-out is what Next sees (the page becomes dynamic in this build).
  process.env.NEXT_PHASE = "phase-production-build"
  const bailOut = new NextControlFlow("bail out of prerendering")
  connectionThrows = bailOut
  failNext = unreachable
  assert.equal(await settle(publicPreload(api.events.list, { from: 9, to: 9 })), bailOut)
  assert.equal(connections, before + 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /events:list/)
  assert.match(warnings[0], /deployment unreachable/)

  // Next's own control flow from the read is rethrown as is: no warning, no deferral.
  const control = new NextControlFlow("not found")
  failNext = control
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 3 } as never)), control)
  assert.equal(connections, before + 1)
  assert.equal(warnings.length, 1)

  // Not on Vercel Production (build-fallback-production): there a failed read
  // is an outage, and the build fails so the last good deployment stays live.
  process.env.VERCEL_ENV = "production"
  failNext = unreachable
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 5 } as never)), unreachable)
  assert.equal(connections, before + 1)
  assert.equal(warnings.length, 1)
  // A preview build still degrades.
  process.env.VERCEL_ENV = "preview"
  failNext = unreachable
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 6 } as never)), bailOut)
  assert.equal(connections, before + 2)
  assert.equal(warnings.length, 2)
  delete process.env.VERCEL_ENV

  // A successful read during the build is untouched.
  connectionThrows = undefined
  assert.equal(await settle(publicQuery(api.orgs.colleges, { n: 4 } as never)), "resolved")
  assert.equal(connections, before + 2)
  delete process.env.NEXT_PHASE
}
