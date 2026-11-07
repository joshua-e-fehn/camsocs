import { describe, expect, test } from "bun:test"
import { api } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import { newTest, signedInAs, type TestConvex, withEnv } from "../lib/harness.testing"
import {
  fetchSummaryOf,
  MAX_RUNS,
  median,
  RUNNING_STALE_MS,
  STATUS_SCAN,
  summariseStages,
} from "./pipeline"

/**
 * The broker's pipeline-status reads (convex/broker/pipeline.ts) over
 * synthetic run logs: statuses, medians, fail streaks, freshness, the talks
 * join, the run picker and the notes behind `stageDetail`. Refusal of
 * non-brokers is also covered for every export by gating.test.ts.
 */

const BROKER = "broker@example.com"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 7, 12)

type Stage = Doc<"harvestRuns">["stages"][number]
type RunRow = Omit<Doc<"harvestRuns">, "_id" | "_creationTime">

function stage(name: string, fields: Partial<Stage> = {}): Stage {
  return {
    name,
    status: "ok",
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    error: null,
    notes: [],
    ...fields,
  }
}

let serial = 0
function run(startedAt: number, stages: Stage[], fields: Partial<RunRow> = {}): RunRow {
  serial++
  const finished = fields.finishedAt === undefined ? startedAt + HOUR : fields.finishedAt
  return {
    runKey: `20261107T000000Z-${serial.toString(16).padStart(6, "0")}`,
    command: "sync --group events",
    requestedStages: stages.map((s) => s.name),
    pipelineVersion: "0.1.0",
    status: finished === null ? "running" : "success",
    startedAt,
    finishedAt: finished,
    stages: finished === null ? [] : stages,
    warnings: [],
    error: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...fields,
  }
}

/** Newest first, as the query hands them over. */
function newestFirst(rows: RunRow[]) {
  return [...rows].sort((a, b) => b.startedAt - a.startedAt)
}

function only(rows: RunRow[], name: string, now = NOW) {
  const row = summariseStages(newestFirst(rows), { now }).find((r) => r.name === name)
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

async function insertRuns(t: TestConvex, rows: RunRow[]) {
  await t.run(async (ctx) => {
    for (const row of rows) await ctx.db.insert("harvestRuns", row)
  })
}

describe("median", () => {
  test("odd, even and empty", () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe("fetchSummaryOf", () => {
  test("null without fetch counters; errors add unreachable, http errors and 5xx", () => {
    expect(fetchSummaryOf(undefined)).toBeNull()
    expect(fetchSummaryOf({ quarantineHeld: 2 })).toBeNull()
    expect(
      fetchSummaryOf({
        fetchRequests: 40,
        fetchUnreachable: 2,
        fetchHttpError: 3,
        fetchStatus5xx: 4,
        fetchStatus4xx: 6,
        fetchRobotsBlocked: 1,
        fetchRetries: 7,
        fetchTooMany: 5,
      }),
    ).toEqual({
      requests: 40,
      errors: 9,
      status4xx: 6,
      status5xx: 4,
      robotsBlocked: 1,
      retries: 7,
      tooMany: 5,
    })
  })
})

describe("summariseStages", () => {
  test("medians are over the ok results before the newest one, within 7 and 28 days", () => {
    const yields = (n: number) => stage("camdram_events", { inserted: n })
    const rows = [
      run(NOW - 1 * DAY, [yields(2)]), // newest: judged, not part of the baseline
      run(NOW - 2 * DAY, [yields(10)]),
      run(NOW - 3 * DAY, [yields(20)]),
      run(NOW - 4 * DAY, [yields(30)]),
      run(NOW - 5 * DAY, [stage("camdram_events", { status: "failed", inserted: 999 })]),
      run(NOW - 10 * DAY, [yields(40)]),
      run(NOW - 20 * DAY, [yields(50)]),
      run(NOW - 40 * DAY, [yields(1000)]), // outside 28 days
    ]
    const row = only(rows, "camdram_events")
    expect(row.yield).toBe(2)
    expect(row.yieldMedian7d).toBe(20)
    expect(row.yieldSamples7d).toBe(3)
    expect(row.yieldMedian28d).toBe(30)
    expect(row.yieldSamples28d).toBe(5)
  })

  test("yield is inserted + updated + unchanged; counts and duration come from the newest result", () => {
    const row = only(
      [
        run(NOW - DAY, [
          stage("su_whatson", {
            inserted: 1,
            updated: 2,
            unchanged: 3,
            skipped: 4,
            durationMs: 1234,
            metrics: { fetchRequests: 20, fetchStatus4xx: 1 },
          }),
        ]),
        run(NOW - 2 * DAY, [stage("su_whatson", { inserted: 50, durationMs: 9 })]),
      ],
      "su_whatson",
    )
    expect(row).toMatchObject({
      inserted: 1,
      updated: 2,
      unchanged: 3,
      skipped: 4,
      yield: 6,
      durationMs: 1234,
      lastStatus: "ok",
    })
    expect(row.fetch?.requests).toBe(20)
    expect(row.fetch?.status4xx).toBe(1)
  })

  test("a result posted before durations were recorded reads durationMs null", () => {
    expect(only([run(NOW - DAY, [stage("playwaze")])], "playwaze").durationMs).toBeNull()
  })

  test("failStreak counts the newest failures, skips not_run and stops at ok", () => {
    const rows = [
      run(NOW - 1 * DAY, [stage("uni_events", { status: "failed", error: "boom" })]),
      run(NOW - 2 * DAY, [stage("uni_events", { status: "not_run" })]),
      run(NOW - 3 * DAY, [stage("uni_events", { status: "failed" })]),
      run(NOW - 4 * DAY, [stage("uni_events", { status: "ok", inserted: 3 })]),
      run(NOW - 5 * DAY, [stage("uni_events", { status: "failed" })]),
    ]
    const row = only(rows, "uni_events")
    expect(row.lastStatus).toBe("failed")
    expect(row.failStreak).toBe(2)
    expect(row.lastOkAt).toBe(NOW - 4 * DAY + HOUR)
  })

  test("freshness: lastOkAt is the newest ok, lastProductiveAt the newest ok with a yield", () => {
    const rows = [
      run(NOW - 1 * DAY, [stage("cucbc_events")]), // ok, nothing found
      run(NOW - 2 * DAY, [stage("cucbc_events", { status: "failed", inserted: 9 })]),
      run(NOW - 3 * DAY, [stage("cucbc_events", { unchanged: 4 })]),
    ]
    const row = only(rows, "cucbc_events")
    expect(row.lastOkAt).toBe(NOW - 1 * DAY + HOUR)
    expect(row.lastProductiveAt).toBe(NOW - 3 * DAY + HOUR)
    expect(row.failStreak).toBe(0)
  })

  test("never ok: freshness is null", () => {
    const row = only([run(NOW - DAY, [stage("instagram", { status: "failed" })])], "instagram")
    expect(row.lastOkAt).toBeNull()
    expect(row.lastProductiveAt).toBeNull()
    expect(row.yieldMedian7d).toBeNull()
  })

  test("running, abandoned, not_run and not_requested", () => {
    const open = run(NOW - HOUR, [stage("talks_cam")], { finishedAt: null })
    const older = run(NOW - DAY, [stage("talks_cam", { inserted: 7 }), stage("resolve")])
    const running = summariseStages([open, older], { now: NOW })
    expect(running.find((r) => r.name === "talks_cam")).toMatchObject({
      lastStatus: "running",
      lastRunKey: open.runKey,
      inserted: 7, // from the last posted result
    })
    expect(running.find((r) => r.name === "resolve")?.lastStatus).toBe("not_requested")
    expect(running.find((r) => r.name === "resolve")?.lastRunKey).toBe(older.runKey)

    const later = NOW + RUNNING_STALE_MS
    expect(only([open, older], "talks_cam", later).lastStatus).toBe("not_run")

    const crashed = run(NOW - HOUR, [stage("load")], { stages: [], error: "health check failed" })
    expect(only([crashed], "load").lastStatus).toBe("not_run")
  })

  test("stages follow the newest run's order, then older ones", () => {
    const rows = [
      run(NOW - DAY, [stage("term_dates"), stage("resolve"), stage("load")]),
      run(NOW - 2 * DAY, [stage("su_directory"), stage("resolve")]),
    ]
    expect(summariseStages(rows, { now: NOW }).map((r) => r.name)).toEqual([
      "term_dates",
      "resolve",
      "load",
      "su_directory",
    ])
  })
})

describe("broker.pipeline queries", () => {
  test("stageStatus filters by group (recorded or parsed) and joins talkRuns into talks", async () => {
    const t = newTest()
    const now = Date.now()
    await insertRuns(t, [
      run(now - 1 * HOUR, [stage("talks", { inserted: 5 })], {
        command: "sync --stages talks",
        group: "talks",
      }),
      run(now - 2 * HOUR, [stage("camdram_events", { inserted: 4 })]),
      run(now - 3 * HOUR, [stage("su_directory", { inserted: 3 }), stage("camdram_events")], {
        command: "sync --group full",
      }),
      run(now - 4 * HOUR, [stage("resolve")], { command: "sync --stages resolve" }),
    ])
    await t.run(async (ctx) => {
      await ctx.db.insert("talkRuns", {
        runId: "talk-run-1",
        status: "partial",
        startedAt: now - 2 * HOUR,
        finishedAt: now - HOUR,
        sourcesOk: 3,
        sourcesFailed: 1,
        talksReceived: 12,
        inserted: 2,
        updated: 1,
        unchanged: 9,
        missing: 0,
        errors: ["synthetic aggregate error"],
        createdAt: now,
        updatedAt: now,
      })
    })
    const broker = await signedInAs(t, BROKER)
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const all = await broker.query(api.broker.pipeline.stageStatus, {})
      expect(all.map((r) => r.name)).toEqual(["talks", "camdram_events", "su_directory", "resolve"])

      const events = await broker.query(api.broker.pipeline.stageStatus, { group: "events" })
      expect(events.map((r) => r.name)).toEqual(["camdram_events"])
      expect(events[0].yield).toBe(4)

      const full = await broker.query(api.broker.pipeline.stageStatus, { group: "full" })
      expect(full.map((r) => r.name)).toEqual(["su_directory", "camdram_events"])

      const talks = await broker.query(api.broker.pipeline.stageStatus, { group: "talks" })
      expect(talks).toHaveLength(1)
      expect(talks[0].talkRun).toMatchObject({ runId: "talk-run-1", errorCount: 1 })
      // Counts only: no error text leaves through the status read.
      expect(JSON.stringify(talks)).not.toContain("synthetic aggregate error")
      expect(all.find((r) => r.name === "camdram_events")?.talkRun).toBeNull()

      expect(await broker.query(api.broker.pipeline.stageStatus, { group: "nope" })).toEqual([])
    })
  })

  test("stageStatus reads at most the newest STATUS_SCAN runs", async () => {
    const t = newTest()
    const now = Date.now()
    const rows = Array.from({ length: STATUS_SCAN }, (_, i) =>
      run(now - (i + 1) * HOUR, [stage("playwaze", { inserted: 1 })]),
    )
    rows.push(run(now - 100 * DAY, [stage("ancient_stage")]))
    await insertRuns(t, rows)
    const broker = await signedInAs(t, BROKER)
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const status = await broker.query(api.broker.pipeline.stageStatus, {})
      expect(status.map((r) => r.name)).toEqual(["playwaze"])
      expect(status[0].yieldSamples7d).toBe(STATUS_SCAN - 1)
    })
  })

  test("runs: newest first, group filter, clamped limit, no notes or errors", async () => {
    const t = newTest()
    const now = Date.now()
    const rows = Array.from({ length: MAX_RUNS + 5 }, (_, i) =>
      run(
        now - (i + 1) * HOUR,
        [stage("load", { notes: ["secret note"], error: "secret error" })],
        {
          command: i % 2 === 0 ? "sync --group events" : "sync --group full",
          revision: i === 0 ? "abc1234" : undefined,
          warnings: ["secret warning"],
        },
      ),
    )
    await insertRuns(t, rows)
    const broker = await signedInAs(t, BROKER)
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const latest = await broker.query(api.broker.pipeline.runs, {})
      expect(latest).toHaveLength(10)
      expect(latest[0]).toMatchObject({
        runKey: rows[0].runKey,
        group: "events",
        revision: "abc1234",
        durationMs: HOUR,
        warningCount: 1,
      })
      expect(latest[0].stages[0].failed).toBe(true)
      expect(latest[1].revision).toBeNull()
      const text = JSON.stringify(latest)
      expect(text).not.toContain("secret")

      const many = await broker.query(api.broker.pipeline.runs, { limit: 1000 })
      expect(many).toHaveLength(MAX_RUNS)
      expect(await broker.query(api.broker.pipeline.runs, { limit: 0 })).toHaveLength(1)

      const full = await broker.query(api.broker.pipeline.runs, { group: "full", limit: 30 })
      expect(full.length).toBe(Math.floor((MAX_RUNS + 5) / 2))
      expect(full.every((r) => r.group === "full")).toBe(true)
    })
  })

  test("stageDetail returns notes and the error; null for an unknown run or stage", async () => {
    const t = newTest()
    const now = Date.now()
    const row = run(now - HOUR, [
      stage("website_events", {
        status: "failed",
        notes: ["3 pages unreachable"],
        error: "TimeoutError",
        metrics: { fetchRequests: 3 },
        durationMs: 500,
      }),
    ])
    await insertRuns(t, [row])
    const broker = await signedInAs(t, BROKER)
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const detail = await broker.query(api.broker.pipeline.stageDetail, {
        runKey: row.runKey,
        stage: "website_events",
      })
      expect(detail).toMatchObject({
        name: "website_events",
        status: "failed",
        notes: ["3 pages unreachable"],
        error: "TimeoutError",
        metrics: { fetchRequests: 3 },
        durationMs: 500,
        group: "events",
      })
      expect(
        await broker.query(api.broker.pipeline.stageDetail, { runKey: row.runKey, stage: "nope" }),
      ).toBeNull()
      expect(
        await broker.query(api.broker.pipeline.stageDetail, { runKey: "nope", stage: "load" }),
      ).toBeNull()
    })
  })

  test("a non-broker is refused by every query", async () => {
    const t = newTest()
    const stranger = await signedInAs(t, "ab123@cam.ac.uk")
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      await expect(stranger.query(api.broker.pipeline.stageStatus, {})).rejects.toThrow(
        "Not authorized",
      )
      await expect(stranger.query(api.broker.pipeline.runs, {})).rejects.toThrow("Not authorized")
      await expect(
        stranger.query(api.broker.pipeline.stageDetail, { runKey: "x", stage: "load" }),
      ).rejects.toThrow("Not authorized")
    })
  })
})
