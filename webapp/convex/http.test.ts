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

describe("POST /api/pipeline/* data routes", () => {
  const claim = {
    entityType: "organisation",
    entityKey: "org-zz-test-fixture",
    field: "name",
    value: "ZZ Test Fixture",
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-x",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: Date.now() - 1_000,
  }

  test("claims round-trips through the router and reports counts", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      const a = post("/api/pipeline/claims", { runKey: "r1", claims: [claim] })
      const response = await t.fetch(a.path, a.init)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        inserted: 1,
        entities: { created: 1 },
        rejected: [],
      })
      const denied = post("/api/pipeline/claims", { claims: [claim] }, "wrong")
      expect((await t.fetch(denied.path, denied.init)).status).toBe(401)
    })
  })

  test("a posted confidence is a 400 naming the field", async () => {
    await withEnv(ENV, async () => {
      const a = post("/api/pipeline/claims", { claims: [{ ...claim, confidence: 1 }] })
      const response = await newTest().fetch(a.path, a.init)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/confidence/)
    })
  })

  test("files stores a PNG once and refuses what it is not", async () => {
    await withEnv(ENV, async () => {
      const t = newTest()
      // A 1×1 transparent PNG.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
      const a = post("/api/pipeline/files", { data: png, contentType: "image/png" })
      const first = await (await t.fetch(a.path, a.init)).json()
      expect(first).toMatchObject({ inserted: 1, unchanged: 0 })
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
      const second = await (await t.fetch(a.path, a.init)).json()
      expect(second).toMatchObject({ storageId: first.storageId, inserted: 0, unchanged: 1 })

      const lying = post("/api/pipeline/files", { data: png, contentType: "image/jpeg" })
      expect((await t.fetch(lying.path, lying.init)).status).toBe(400)
      const svg = post("/api/pipeline/files", {
        data: btoa("<svg/>"),
        contentType: "image/svg+xml",
      })
      expect((await t.fetch(svg.path, svg.init)).status).toBe(400)
    })
  })

  test("inbound/pending answers with the query's result", async () => {
    await withEnv(ENV, async () => {
      const a = post("/api/pipeline/inbound/pending", { limit: 10 })
      const response = await newTest().fetch(a.path, a.init)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([])
    })
  })

  test("crosswalk answers a page of organisations", async () => {
    await withEnv(ENV, async () => {
      const a = post("/api/pipeline/crosswalk", { cursor: null })
      const response = await newTest().fetch(a.path, a.init)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ rows: [], isDone: true })
    })
  })

  test("purge refuses on a deployment that is not dev, even with the right key and body", async () => {
    await withEnv({ ...ENV, CONVEX_CLOUD_URL: "https://prod-otter-1.convex.cloud" }, async () => {
      const a = post("/api/pipeline/purge", { confirm: "PURGE-DEV" })
      const response = await newTest().fetch(a.path, a.init)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/not the dev deployment/)
      const noConfirm = post("/api/pipeline/purge", {})
      expect((await newTest().fetch(noConfirm.path, noConfirm.init)).status).toBe(400)
    })
  })
})
