import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import { newTest } from "./lib/harness.testing"
import { deriveRunStatus, runGroup } from "./runs"

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

describe("run-log widen (optional group, revision, durationMs)", () => {
  test("runGroup prefers the recorded group, falls back to the command, else null", () => {
    expect(runGroup({ group: "talks", command: "sync --group events" })).toBe("talks")
    expect(runGroup({ command: "sync --group events" })).toBe("events")
    expect(runGroup({ command: "sync --group full" })).toBe("full")
    expect(runGroup({ command: "sync" })).toBeNull()
    expect(runGroup({ command: "sync --group" })).toBeNull()
    expect(runGroup({ command: "sync --group Events; rm" })).toBeNull()
  })

  test("an old runs.start payload is still accepted and records neither field", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)
    const [run] = await t.query(internal.runs.latest, {})
    expect("group" in run).toBe(false)
    expect("revision" in run).toBe(false)
    expect(runGroup(run)).toBeNull()
  })

  test("runs.start stores group and revision when posted", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, {
      ...startArgs,
      command: "sync --group events",
      group: "events",
      revision: "0123456789abcdef0123456789abcdef01234567",
    })
    const [run] = await t.query(internal.runs.latest, {})
    expect(run.group).toBe("events")
    expect(run.revision).toBe("0123456789abcdef0123456789abcdef01234567")
    expect(runGroup(run)).toBe("events")
  })

  test("a blank group or revision records nothing", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, { ...startArgs, group: "  ", revision: "" })
    const [run] = await t.query(internal.runs.latest, {})
    expect("group" in run).toBe(false)
    expect("revision" in run).toBe(false)
  })

  test("an old runs.finish payload without durationMs is still accepted", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, startArgs)
    const result = await t.mutation(internal.runs.finish, {
      runKey: startArgs.runKey,
      stages: [STAGE, { ...STAGE, name: "parse", metrics: { quarantineHeld: 2 } }],
      warnings: [],
      error: null,
    })
    expect(result.status).toBe("success")
    const [run] = await t.query(internal.runs.latest, {})
    expect(run.stages.every((stage) => !("durationMs" in stage))).toBe(true)
  })

  test("durationMs is stored per stage, and a retried finish stays idempotent", async () => {
    const t = newTest()
    await t.mutation(internal.runs.start, { ...startArgs, group: "events" })
    const finish = {
      runKey: startArgs.runKey,
      stages: [
        { ...STAGE, durationMs: 1234.5 },
        { ...STAGE, name: "parse", durationMs: 0 },
      ],
      warnings: [],
      error: null,
    }
    const first = await t.mutation(internal.runs.finish, finish)
    expect(first.unchanged).toBe(false)

    const [run] = await t.query(internal.runs.latest, {})
    expect(run.stages.map((stage) => stage.durationMs)).toEqual([1234.5, 0])
    expect(run.group).toBe("events")

    const again = await t.mutation(internal.runs.finish, finish)
    expect(again).toEqual({ runKey: startArgs.runKey, status: "success", unchanged: true })

    // A different duration is a different result: the finished record is evidence.
    await expect(
      t.mutation(internal.runs.finish, {
        ...finish,
        stages: [{ ...STAGE, durationMs: 9999 }, finish.stages[1]],
      }),
    ).rejects.toThrow(/already finished/)
  })
})
