import { mock } from "bun:test"
import assert from "node:assert/strict"

const calls: { args: unknown; token?: string }[] = []
const cachedValues = new Map<string, unknown>()
mock.module("convex/nextjs", () => ({
  preloadQuery: async (_query: unknown, args: unknown, options?: { token?: string }) => {
    const result = { args, token: options?.token, invocation: calls.length }
    calls.push(result)
    return result
  },
}))
mock.module("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    key: string[],
    options: { revalidate: number },
  ) => {
    assert.equal(options.revalidate, 60)
    return async (...args: unknown[]) => {
      const cacheKey = JSON.stringify([key, args])
      if (!cachedValues.has(cacheKey)) cachedValues.set(cacheKey, await fn(...args))
      return cachedValues.get(cacheKey)
    }
  },
}))
const { preloadEvents, preloadRestrictedCount, preloadPublicColleges } = await import(
  "./public-data"
)
const args = { from: 1, to: 2 }
const anonymous = await preloadEvents(args)
assert.deepEqual(await preloadEvents(args), anonymous)
assert.equal(calls.length, 1)
await preloadEvents({ from: 2, to: 3 })
assert.equal(calls.length, 2)
await preloadEvents(args, "session-a")
await preloadEvents(args, "session-b")
await preloadEvents(args, "session-a")
assert.equal(calls.length, 5)
assert.deepEqual(await preloadEvents(args), anonymous)
await preloadRestrictedCount(args)
await preloadRestrictedCount(args)
assert.equal(calls.length, 6)
await preloadRestrictedCount(args, "session-a")
assert.equal(calls.length, 7)
await preloadPublicColleges()
await preloadPublicColleges()
assert.equal(calls.length, 8)
assert(!JSON.stringify([...cachedValues]).includes("session-"))
