import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest } from "./lib/harness.testing"
import { deriveRunStatus } from "./runs"

const STAGE = {
  name: "fetch",
  status: "ok" as const,
  inserted: 3,
  updated: 1,
  unchanged: 10,
  skipped: 2,
  error: null,
  notes: [],
}

const startArgs = {
  runKey: "20261007T215500Z-abc123",
  command: "sync",
  requestedStages: ["discover", "fetch"],
  pipelineVersion: "0.1.0",
}

describe("deriveRunStatus", () => {
  test("all ok is success", () => {
    expect(deriveRunStatus([STAGE, STAGE], null)).toBe("success")
  })

  test("some failed is partial, all failed is failed", () => {
    const failed = { ...STAGE, status: "failed" as const }
    expect(deriveRunStatus([STAGE, failed], null)).toBe("partial")
    expect(deriveRunStatus([failed, failed], null)).toBe("failed")
  })

  test("a stage that did not run counts against success", () => {
    expect(deriveRunStatus([STAGE, { ...STAGE, status: "not_run" as const }], null)).toBe("partial")
  })

  test("a run-level error fails the run whatever the stages say", () => {
    expect(deriveRunStatus([STAGE], "health check failed")).toBe("failed")
  })

  test("a run with no stages and no error succeeded at nothing", () => {
    expect(deriveRunStatus([], null)).toBe("success")
  })
})

describe("runs.start / runs.finish", () => {
  test("a run is visible as running before it finishes", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)

    const [run] = await t.query(internal.runs.latest, {})
    expect(run.runKey).toBe(startArgs.runKey)
    expect(run.status).toBe("running")
    expect(run.finishedAt).toBeNull()
    expect(run.stages).toEqual([])
  })

  test("finish derives the status and stamps finishedAt", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)
    const result = await t.mutation(internal.runs.finish, {
      runKey: startArgs.runKey,
      stages: [STAGE, { ...STAGE, name: "parse", status: "failed", error: "boom" }],
      warnings: ["robots.txt unreachable for example.org"],
      error: null,
    })
    expect(result).toEqual({ runKey: startArgs.runKey, status: "partial", unchanged: false })

    const [run] = await t.query(internal.runs.latest, {})
    expect(run.status).toBe("partial")
    expect(run.finishedAt).not.toBeNull()
    expect(run.stages.map((stage) => stage.name)).toEqual(["fetch", "parse"])
  })

  test("a duplicate run key is refused", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)
    await expect(t.mutation(internal.runs.start, startArgs)).rejects.toThrow(/already exists/)
  })

  test("finishing an unknown run says not found (→ 404 over HTTP)", async () => {
    const t = newTest()
    await expect(
      t.mutation(internal.runs.finish, {
        runKey: "missing",
        stages: [],
        warnings: [],
        error: null,
      }),
    ).rejects.toThrow(/not found/)
  })

  test("an identical second finish is a no-op; a different one is refused", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)
    const finish = { runKey: startArgs.runKey, stages: [STAGE], warnings: [], error: null }
    await t.mutation(internal.runs.finish, finish)

    const again = await t.mutation(internal.runs.finish, finish)
    expect(again.unchanged).toBe(true)

    await expect(
      t.mutation(internal.runs.finish, { ...finish, error: "changed my mind" }),
    ).rejects.toThrow(/already finished/)
  })

  test("latest is newest first and bounded", async () => {
    const t = newTest()
    for (const key of ["a", "b", "c"]) {
      await t.mutation(internal.runs.start, { ...startArgs, runKey: key })
    }
    const runs = await t.query(internal.runs.latest, { limit: 2 })
    expect(runs).toHaveLength(2)
    expect(runs[0].startedAt).toBeGreaterThanOrEqual(runs[1].startedAt)
  })
})

describe("runs.lastHarvest (public)", () => {
  test("is the latest finished run that wrote data, and nothing else", async () => {
    const t = newTest()
    expect(await t.query(api.runs.lastHarvest, {})).toBeNull()

    await t.mutation(internal.runs.start, startArgs)
    expect(await t.query(api.runs.lastHarvest, {})).toBeNull()
    await t.mutation(internal.runs.finish, {
      runKey: startArgs.runKey,
      stages: [STAGE],
      warnings: ["a warning that must stay internal"],
      error: null,
    })
    const harvested = await t.query(api.runs.lastHarvest, {})
    expect(Object.keys(harvested ?? {})).toEqual(["finishedAt"])

    // A later failed run does not count as a harvest.
    await t.mutation(internal.runs.start, { ...startArgs, runKey: "20261008T010000Z-def456" })
    await t.mutation(internal.runs.finish, {
      runKey: "20261008T010000Z-def456",
      stages: [{ ...STAGE, status: "failed" as const }],
      warnings: [],
      error: null,
    })
    expect(await t.query(api.runs.lastHarvest, {})).toEqual(harvested)
  })
})
