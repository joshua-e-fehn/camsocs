import { describe, expect, test } from "bun:test"
import { newTest, withEnv } from "./lib/harness.testing"

/**
 * The pipeline's front door: Bearer check, deny-all when unset, and the 400/404
 * mapping. Exercised through convex-test's `t.fetch`, i.e. the real router.
 */

const KEY = "test-pipeline-key-0123456789"
const ENV = { PIPELINE_API_KEY: KEY, BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789" }

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

function post(path: string, body: unknown, key = KEY) {
  return {
    path,
    init: {
      method: "POST",
      headers: { ...bearer(key), "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  }
}

describe("GET /api/pipeline/health", () => {
  test("200 with the right key", async () => {
    await withEnv(ENV, async () => {
      const response = await newTest().fetch("/api/pipeline/health", { headers: bearer(KEY) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
    })
  })

  test("401 without a key, with a wrong key, and with a non-Bearer scheme", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      expect((await t.fetch("/api/pipeline/health")).status).toBe(401)
      expect((await t.fetch("/api/pipeline/health", { headers: bearer("nope") })).status).toBe(401)
      const basic = await t.fetch("/api/pipeline/health", { headers: { Authorization: KEY } })
      expect(basic.status).toBe(401)
    })
  })

  test("denies everyone when PIPELINE_API_KEY is unset on the deployment", async () => {
    await withEnv({ ...ENV, PIPELINE_API_KEY: undefined }, async () => {
      const t = newTest()
      // Including a caller presenting an empty key, which would equal an
      // empty expected value if the check compared before testing for unset.
      expect((await t.fetch("/api/pipeline/health", { headers: bearer("") })).status).toBe(401)
      expect((await t.fetch("/api/pipeline/health", { headers: bearer(KEY) })).status).toBe(401)
    })
  })
})

describe("POST /api/pipeline/runs/*", () => {
  const start = {
    runKey: "20261007T215500Z-abc123",
    command: "sync",
    requestedStages: ["fetch"],
    pipelineVersion: "0.1.0",
  }

  test("start then finish round-trips through the router", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const a = post("/api/pipeline/runs/start", start)
      const started = await t.fetch(a.path, a.init)
      expect(started.status).toBe(200)
      expect(await started.json()).toEqual({ runKey: start.runKey, created: true })

      const b = post("/api/pipeline/runs/finish", {
        runKey: start.runKey,
        stages: [],
        warnings: [],
        error: null,
      })
      const finished = await t.fetch(b.path, b.init)
      expect(finished.status).toBe(200)
      expect(await finished.json()).toMatchObject({ status: "success" })
    })
  })

  test("an unauthenticated write never reaches the mutation", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const a = post("/api/pipeline/runs/start", start, "wrong-key")
      expect((await t.fetch(a.path, a.init)).status).toBe(401)
      // Nothing was written: the same run key is still free.
      const ok = post("/api/pipeline/runs/start", start)
      expect((await t.fetch(ok.path, ok.init)).status).toBe(200)
    })
  })

  test("a validator rejection is a 400 naming the problem", async () => {
    await withEnv(ENV, async () => {
      const a = post("/api/pipeline/runs/start", { ...start, unexpected: true })
      const response = await newTest().fetch(a.path, a.init)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/unexpected/)
    })
  })

  test("malformed JSON and non-object bodies are 400", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const broken = post("/api/pipeline/runs/start", "{not json")
      expect((await t.fetch(broken.path, broken.init)).status).toBe(400)
      const array = post("/api/pipeline/runs/start", [start])
      expect((await t.fetch(array.path, array.init)).status).toBe(400)
    })
  })

  test("finishing an unknown run is a 404", async () => {
    await withEnv(ENV, async () => {
      const a = post("/api/pipeline/runs/finish", {
        runKey: "missing",
        stages: [],
        warnings: [],
        error: null,
      })
      expect((await newTest().fetch(a.path, a.init)).status).toBe(404)
    })
  })
})
