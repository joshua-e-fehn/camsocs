import { describe, expect, test } from "bun:test"
import { countIcsFetch, ICS_FEED_FETCHED, icsFeedProperties } from "./ics-telemetry"
import { SERVER_EVENTS } from "./posthog-server"

/**
 * The calendar-feed count (ENG-7; P12): `countIcsFetch` hands exactly one
 * `ics_feed_fetched { feed, key? }` to `captureServerEvent` inside `after()`,
 * with the key only when it is a valid key of that feed's kind, and never
 * throws, whether `after()` itself throws (outside a request) or the capture
 * fails. The route handlers' own behaviour is in `app/ics-routes.test.ts`.
 */

const EVENT_KEY = `evt-${"a".repeat(40)}`
const TALK_KEY = `talk-${"b".repeat(20)}`

/** A recording `after()` and capture; `run()` runs the deferred tasks. */
function recorder(capture: (event: string, props: object) => Promise<void> = async () => {}) {
  const tasks: (() => Promise<void>)[] = []
  const captured: [string, object][] = []
  return {
    tasks,
    captured,
    deps: {
      after: (task: () => Promise<void>) => {
        tasks.push(task)
      },
      capture: async (event: string, props: object = {}) => {
        captured.push([event, props])
        await capture(event, props)
      },
    },
    run: () => Promise.all(tasks.map((task) => task())),
  }
}

describe("icsFeedProperties", () => {
  test("the feed, and a key only when it is a valid key of that kind", () => {
    expect(icsFeedProperties("talks")).toEqual({ feed: "talks" })
    expect(icsFeedProperties("talks", TALK_KEY)).toEqual({ feed: "talks" })
    expect(icsFeedProperties("event", EVENT_KEY)).toEqual({ feed: "event", key: EVENT_KEY })
    expect(icsFeedProperties("talk", TALK_KEY)).toEqual({ feed: "talk", key: TALK_KEY })
    expect(icsFeedProperties("event", TALK_KEY)).toEqual({ feed: "event" })
    expect(icsFeedProperties("talk", "jane doe")).toEqual({ feed: "talk" })
    expect(icsFeedProperties("event", `${EVENT_KEY}?q=x`)).toEqual({ feed: "event" })
  })

  test("only allow-listed properties exist", () => {
    const allowed = SERVER_EVENTS[ICS_FEED_FETCHED]
    for (const key of Object.keys(icsFeedProperties("event", EVENT_KEY))) {
      expect(allowed).toContain(key)
    }
  })
})

describe("countIcsFetch", () => {
  test("defers one capture to after(), with the allow-listed properties", async () => {
    const r = recorder()
    countIcsFetch("talk", TALK_KEY, r.deps)
    expect(r.tasks).toHaveLength(1)
    expect(r.captured).toHaveLength(0)
    await r.run()
    expect(r.captured).toEqual([["ics_feed_fetched", { feed: "talk", key: TALK_KEY }]])
  })

  test("never throws: after() outside a request, a capture that rejects or throws", async () => {
    expect(() =>
      countIcsFetch("talks", undefined, {
        after: () => {
          throw new Error("`after` was called outside a request scope")
        },
        capture: async () => {},
      }),
    ).not.toThrow()

    const rejecting = recorder(async () => {
      throw new Error("PostHog down")
    })
    countIcsFetch("event", EVENT_KEY, rejecting.deps)
    await expect(rejecting.run()).resolves.toBeDefined()

    const tasks: (() => Promise<void>)[] = []
    countIcsFetch("event", EVENT_KEY, {
      after: (task) => tasks.push(task),
      capture: (() => {
        throw new Error("sync throw")
      }) as never,
    })
    await expect(tasks[0]?.()).resolves.toBeUndefined()
  })
})
