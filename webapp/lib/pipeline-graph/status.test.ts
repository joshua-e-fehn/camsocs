import { describe, expect, test } from "bun:test"
import {
  type RunSummary,
  RUNNING_STALE_MS as SERVER_RUNNING_STALE_MS,
  STAGE_STATES,
  type StageStatusRow,
} from "@/convex/broker/pipeline"
import { PIPELINE_GRAPH, type StageNode, stageNodes } from "./graph"
import {
  fetchErrorShare,
  formatCount,
  formatDuration,
  isYieldDrop,
  medianWindow,
  NODE_STATES,
  RUNNING_STALE_MS,
  STATE_WORDS,
  sourceStatusRows,
  stageViews,
  stateCounts,
  statusText,
  viewFromRun,
  viewFromStatus,
  yieldRatio,
} from "./status"

/**
 * The status mapping behind the stage nodes and the status table. Every run,
 * count and key here is invented.
 */

const stages = new Map(stageNodes(PIPELINE_GRAPH).map((s) => [s.name, s]))
const stage = (name: string): StageNode => stages.get(name)!

function row(name: string, over: Partial<StageStatusRow> = {}): StageStatusRow {
  return {
    name,
    lastStatus: "ok",
    lastRunKey: "20261101T043000Z-abc123",
    lastStartedAt: 1_000,
    lastOkAt: 2_000,
    lastProductiveAt: 2_000,
    inserted: 3,
    updated: 4,
    unchanged: 100,
    skipped: 1,
    durationMs: 65_000,
    failStreak: 0,
    yield: 107,
    yieldMedian7d: 100,
    yieldMedian28d: 90,
    yieldSamples7d: 5,
    yieldSamples28d: 12,
    fetch: null,
    talkRun: null,
    ...over,
  }
}

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runKey: "20261102T043000Z-def456",
    command: "sync --group events",
    group: "events",
    revision: null,
    pipelineVersion: "0.1.0",
    status: "success",
    startedAt: 10_000,
    finishedAt: 20_000,
    durationMs: 10_000,
    requestedStages: ["camdram_events", "playwaze"],
    stages: [
      {
        name: "camdram_events",
        status: "ok",
        inserted: 1,
        updated: 2,
        unchanged: 3,
        skipped: 0,
        durationMs: 5_000,
        failed: false,
      },
    ],
    warningCount: 0,
    hasError: false,
    ...over,
  }
}

describe("states", () => {
  test("the node states are the server's stage states, each with a word", () => {
    expect([...NODE_STATES]).toEqual([...STAGE_STATES])
    for (const state of NODE_STATES) expect(STATE_WORDS[state].length).toBeGreaterThan(0)
  })

  test("the stale-run cut-off equals the server's", () => {
    expect(RUNNING_STALE_MS).toBe(SERVER_RUNNING_STALE_MS)
  })
})

describe("viewFromStatus", () => {
  test("copies the newest result", () => {
    const view = viewFromStatus(stage("camdram_events"), row("camdram_events"))
    expect(view.state).toBe("ok")
    expect(view.yield).toBe(107)
    expect(view.durationMs).toBe(65_000)
    expect(view.runKey).toBe("20261101T043000Z-abc123")
    expect(view.yieldDrop).toBe(false)
  })

  test("events-group stages use the 7-day median, full-only ones the 28-day", () => {
    expect(medianWindow(stage("camdram_events"))).toBe(7)
    expect(medianWindow(stage("su_directory"))).toBe(28)
    expect(viewFromStatus(stage("camdram_events"), row("camdram_events")).median).toBe(100)
    expect(viewFromStatus(stage("su_directory"), row("su_directory")).median).toBe(90)
  })

  test("a yield under a quarter of the median is flagged, with enough samples", () => {
    const low = row("camdram_events", { yield: 24, yieldMedian7d: 100, yieldSamples7d: 3 })
    expect(viewFromStatus(stage("camdram_events"), low).yieldDrop).toBe(true)
    // Exactly a quarter is not a drop.
    const quarter = row("camdram_events", { yield: 25, yieldMedian7d: 100 })
    expect(viewFromStatus(stage("camdram_events"), quarter).yieldDrop).toBe(false)
    // Too few prior runs, or too small a median, never flags.
    const few = row("camdram_events", { yield: 0, yieldSamples7d: 2 })
    expect(viewFromStatus(stage("camdram_events"), few).yieldDrop).toBe(false)
    const tiny = row("camdram_events", { yield: 0, yieldMedian7d: 4 })
    expect(viewFromStatus(stage("camdram_events"), tiny).yieldDrop).toBe(false)
    // A failed stage shows "failed", not a yield drop.
    const failed = row("camdram_events", { lastStatus: "failed", yield: 0 })
    expect(viewFromStatus(stage("camdram_events"), failed).yieldDrop).toBe(false)
    expect(isYieldDrop(null, 100, 9)).toBe(false)
    expect(isYieldDrop(0, 5, 3)).toBe(true)
  })

  test("a stage outside the chosen group is not requested", () => {
    const view = viewFromStatus(stage("su_directory"), row("su_directory"), "events")
    expect(view.state).toBe("not_requested")
    expect(view.yield).toBeNull()
  })

  test("a stage no scanned run mentions has not run", () => {
    expect(viewFromStatus(stage("su_directory"), undefined).state).toBe("not_run")
    expect(viewFromStatus(stage("camdram_events"), undefined, "events").state).toBe("not_run")
  })

  test("stageViews covers every stage", () => {
    const views = stageViews(PIPELINE_GRAPH, {
      kind: "status",
      rows: [row("talks", { lastStatus: "running" })],
      group: "talks",
    })
    expect(Object.keys(views)).toHaveLength(25)
    expect(views.talks.state).toBe("running")
    expect(views.load.state).toBe("not_requested")
  })
})

describe("viewFromRun", () => {
  test("a stage the run did not ask for is not requested", () => {
    expect(viewFromRun(stage("su_directory"), run(), 30_000).state).toBe("not_requested")
  })

  test("a finished result shows its counts", () => {
    const view = viewFromRun(stage("camdram_events"), run(), 30_000)
    expect(view.state).toBe("ok")
    expect(view.yield).toBe(6)
    expect(view.durationMs).toBe(5_000)
    expect(view.runKey).toBe("20261102T043000Z-def456")
  })

  test("requested without a result: running while the run is open, else not run", () => {
    const open = run({ finishedAt: null, status: "running", durationMs: null })
    expect(viewFromRun(stage("playwaze"), open, 10_000 + 60_000).state).toBe("running")
    expect(viewFromRun(stage("playwaze"), open, 10_000 + RUNNING_STALE_MS).state).toBe("not_run")
    expect(viewFromRun(stage("playwaze"), run(), 30_000).state).toBe("not_run")
  })

  test("a failed result counts as a streak of one", () => {
    const failed = run({
      stages: [
        {
          name: "camdram_events",
          status: "failed",
          inserted: 0,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          durationMs: null,
          failed: true,
        },
      ],
    })
    const view = viewFromRun(stage("camdram_events"), failed, 30_000)
    expect(statusText(view)).toBe("failed")
  })
})

describe("text and numbers", () => {
  test("statusText adds the streak and the yield flag", () => {
    expect(statusText({ state: "failed", failStreak: 3, yieldDrop: false })).toBe("failed ×3")
    expect(statusText({ state: "ok", failStreak: 0, yieldDrop: true })).toBe("ok · yield ↓")
    expect(statusText({ state: "not_requested", failStreak: 0, yieldDrop: false })).toBe(
      "not requested",
    )
  })

  test("formatDuration", () => {
    expect(formatDuration(null)).toBe("—")
    expect(formatDuration(850)).toBe("850 ms")
    expect(formatDuration(4_200)).toBe("4.2 s")
    expect(formatDuration(185_000)).toBe("3 min 05 s")
    expect(formatDuration(4_320_000)).toBe("1 h 12 min")
  })

  test("formatCount", () => {
    expect(formatCount(null)).toBe("—")
    expect(formatCount(1204)).toBe("1,204")
  })

  test("fetch error share and yield ratio", () => {
    expect(fetchErrorShare(null)).toBeNull()
    const fetch = {
      requests: 40,
      errors: 10,
      status4xx: 1,
      status5xx: 2,
      robotsBlocked: 0,
      retries: 0,
      tooMany: 0,
    }
    expect(fetchErrorShare(fetch)).toBe(0.25)
    expect(fetchErrorShare({ ...fetch, requests: 0 })).toBeNull()
    expect(yieldRatio({ yield: 50, median: 100 })).toBe(0.5)
    expect(yieldRatio({ yield: 50, median: null })).toBeNull()
  })

  test("stateCounts", () => {
    const views = stageViews(PIPELINE_GRAPH, {
      kind: "status",
      rows: [
        row("camdram_events", { yield: 1, yieldSamples7d: 4 }),
        row("playwaze", { lastStatus: "failed" }),
      ],
    })
    const counts = stateCounts(Object.values(views))
    expect(counts.ok).toBe(1)
    expect(counts.failed).toBe(1)
    expect(counts.yieldDrop).toBe(1)
    expect(counts.not_run).toBe(23)
  })
})

describe("sourceStatusRows", () => {
  test("one row per manifest source, in manifest order, sharing a stage where they do", () => {
    const rows = sourceStatusRows(PIPELINE_GRAPH, [
      row("enrich", { fetch: { ...emptyFetch(), requests: 20, errors: 5 } }),
    ])
    expect(rows.map((r) => r.source.key)).toEqual(PIPELINE_GRAPH.sources.map((s) => s.key))
    const enrich = rows.filter((r) => r.stage?.name === "enrich")
    expect(enrich.map((r) => r.source.key).sort()).toEqual(["linktree", "society_websites"])
    for (const r of enrich) {
      expect(r.view.state).toBe("ok")
      expect(r.errorShare).toBe(0.25)
    }
    expect(rows.find((r) => r.source.key === "su_directory")?.view.state).toBe("not_run")
  })
})

function emptyFetch() {
  return {
    requests: 0,
    errors: 0,
    status4xx: 0,
    status5xx: 0,
    robotsBlocked: 0,
    retries: 0,
    tooMany: 0,
  }
}
