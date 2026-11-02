import { describe, expect, test } from "bun:test"
import { londonIsoDate, londonMidnight } from "../lib/calendar"
import { api, internal } from "./_generated/api"
import { londonWeekOf, MAX_TALK_BATCH, SWEEP_PAGE, TALK_RETENTION_DAYS } from "./ingest/talks"
import { newTest, type TestConvex, withEnv } from "./lib/harness.testing"
import { createSuppression } from "./lib/suppressionEffects"
import { contactHash, nameHash } from "./lib/suppressions"
import { talkKey, talkSearchText } from "./lib/talks"

/**
 * The talks pillar (talks-redesign-spec §4, decision D7): ingest upserts,
 * the per-source sweep, retention, the stats walk and the public queries.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.now()

const CST = {
  key: "dept-computer-science-and-technology",
  slug: "computer-science-and-technology",
  name: "Department of Computer Science and Technology",
  shortName: "Computer Science",
  school: "technology" as const,
  website: "https://www.cst.cam.ac.uk",
  aliases: ["Computer Laboratory"],
}
const HISTORY = {
  key: "dept-history",
  slug: "history",
  name: "Faculty of History",
  shortName: "History",
  school: "arts_humanities" as const,
  website: "https://www.hist.cam.ac.uk",
  aliases: [],
}

type Wire = {
  key: string
  sourceType: "talks_cam" | "dept_ics" | "dept_rss" | "dept_json" | "dept_jsonld" | "dept_drupal"
  source: string
  externalId: string
  url: string
  sourceUrl: string
  title: string
  speakers: { name: string; affiliation?: string }[]
  series?: string
  departmentKeys: string[]
  startsAt: number
  endsAt?: number
  allDay: boolean
  venue?: string
  online: boolean
  kind: "seminar" | "lecture" | "workshop" | "conference" | "other"
  cancelled: boolean
  abstract?: string
  specialMessage?: string
  retrievedAt: number
}

/** A talks.cam talk `id` starting at `startsAt`, by default a CST seminar. */
function talk(id: string, startsAt: number, overrides: Partial<Wire> = {}): Wire {
  const sourceType = overrides.sourceType ?? "talks_cam"
  const externalId = overrides.externalId ?? id
  return {
    key: talkKey(sourceType, externalId),
    sourceType,
    source: "talks_cam",
    externalId,
    url: `https://talks.cam.ac.uk/talk/index/${id}`,
    sourceUrl: "https://talks.cam.ac.uk/api/talks",
    title: `Talk ${id}`,
    speakers: [{ name: "Ada Lovelace", affiliation: "Analytical Engines Ltd" }],
    series: "Computer Laboratory Systems Research Group Seminar",
    departmentKeys: [CST.key],
    startsAt,
    endsAt: startsAt + HOUR,
    allDay: false,
    venue: "FW26, William Gates Building",
    online: false,
    kind: "seminar",
    cancelled: false,
    abstract: `Abstract of ${id}`,
    retrievedAt: NOW,
    ...overrides,
  }
}

/** A department ICS talk (source `<dept>#0`). */
function deptTalk(id: string, startsAt: number, overrides: Partial<Wire> = {}): Wire {
  return talk(id, startsAt, {
    sourceType: "dept_ics",
    externalId: `uid-${id}@hist.cam.ac.uk`,
    source: `${HISTORY.key}#0`,
    url: `https://www.hist.cam.ac.uk/events/${id}`,
    sourceUrl: "https://www.hist.cam.ac.uk/events.ics",
    departmentKeys: [HISTORY.key],
    series: undefined,
    venue: "Seeley Library",
    ...overrides,
  })
}

async function seed(t: TestConvex) {
  await t.mutation(internal.ingest.talks.departmentsUpsert, { departments: [CST, HISTORY] })
}

async function post(t: TestConvex, runId: string, talks: Wire[]) {
  return await t.mutation(internal.ingest.talks.batch, { runId, talks })
}

async function rowOf(t: TestConvex, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("talks")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  )
}

async function settle(t: TestConvex) {
  await t.finishAllScheduledFunctions(() => {})
}

const page = { numItems: 50, cursor: null }

describe("talkKey", () => {
  test("matches the pipeline's talk_key (talks/model.py)", () => {
    // Values printed by `talk_key` in pipeline/src/camsocs_pipeline/talks/model.py.
    expect(talkKey("talks_cam", "12345")).toBe("talk-e1db06584b598cb47e57")
    expect(talkKey("dept_ics", "uid-1@example.cam.ac.uk")).toBe("talk-1b48355fc4fc96ab367b")
  })
})

describe("talkSearchText", () => {
  test("lower-cases title, speakers, affiliations, series, venue and departments", () => {
    const text = talkSearchText(
      {
        title: "Proofs  and\nTypes",
        speakers: [{ name: "Jean-Yves Girard", affiliation: "Marseille" }],
        series: "Logic Seminar",
        venue: "LT1",
      },
      ["Computer Science"],
    )
    expect(text).toBe(
      "proofs and types jean-yves girard marseille logic seminar lt1 computer science",
    )
  })
})

describe("talks/departments", () => {
  test("upserts by key: inserted, then unchanged, then updated", async () => {
    const t = newTest()
    expect(
      await t.mutation(internal.ingest.talks.departmentsUpsert, { departments: [CST, HISTORY] }),
    ).toEqual({ inserted: 2, updated: 0, unchanged: 0 })
    expect(
      await t.mutation(internal.ingest.talks.departmentsUpsert, { departments: [CST] }),
    ).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
    expect(
      await t.mutation(internal.ingest.talks.departmentsUpsert, {
        departments: [{ ...CST, shortName: "CST" }],
      }),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
  })

  test("refuses a key that is not dept-<slug> and a bad website", async () => {
    const t = newTest()
    await expect(
      t.mutation(internal.ingest.talks.departmentsUpsert, {
        departments: [{ ...CST, key: "dept-cst" }],
      }),
    ).rejects.toThrow(/dept-<slug>/)
    await expect(
      t.mutation(internal.ingest.talks.departmentsUpsert, {
        departments: [{ ...CST, website: "javascript:alert(1)" }],
      }),
    ).rejects.toThrow(/website/)
  })
})

describe("talks/batch", () => {
  test("inserts with derived fields and details", async () => {
    const t = newTest()
    await seed(t)
    const one = talk("1", NOW + DAY)
    expect(await post(t, "run-1", [one])).toEqual({ inserted: 1, updated: 0, unchanged: 0 })
    const row = await rowOf(t, one.key)
    expect(row?.primaryDepartmentKey).toBe(CST.key)
    expect(row?.school).toBe("technology")
    expect(row?.listing).toBe("listed")
    expect(row?.lastRunId).toBe("run-1")
    expect(row?.searchText).toContain("ada lovelace")
    expect(row?.searchText).toContain("computer science")
    expect(row).not.toHaveProperty("abstract")
    const details = await t.run(async (ctx) => ctx.db.query("talkDetails").collect())
    expect(details).toHaveLength(1)
    expect(details[0].abstract).toBe("Abstract of 1")
  })

  test("a re-sent talk is unchanged and only its sighting moves", async () => {
    const t = newTest()
    await seed(t)
    const one = talk("1", NOW + DAY)
    await post(t, "run-1", [one])
    const before = await rowOf(t, one.key)
    expect(await post(t, "run-2", [one])).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
    const after = await rowOf(t, one.key)
    expect(after?.lastRunId).toBe("run-2")
    expect(after?.updatedAt).toBe(before?.updatedAt as number)
    expect(after?.firstSeenAt).toBe(before?.firstSeenAt as number)
  })

  test("a changed title, abstract or dropped series is an update", async () => {
    const t = newTest()
    await seed(t)
    const one = talk("1", NOW + DAY)
    await post(t, "run-1", [one])
    expect(await post(t, "run-2", [{ ...one, title: "Renamed" }])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    })
    expect((await rowOf(t, one.key))?.title).toBe("Renamed")
    expect(await post(t, "run-3", [{ ...one, title: "Renamed", abstract: "New" }])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    })
    expect(
      await post(t, "run-4", [{ ...one, title: "Renamed", abstract: "New", series: undefined }]),
    ).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect((await rowOf(t, one.key))?.series).toBeUndefined()
    // No abstract and no special message: the details row goes.
    await post(t, "run-5", [{ ...one, abstract: undefined }])
    expect(await t.run(async (ctx) => ctx.db.query("talkDetails").collect())).toHaveLength(0)
  })

  test("caps count code points like the pipeline; a bad end is dropped, not refused", async () => {
    const t = newTest()
    await seed(t)
    // 4000 code points, 4001+ UTF-16 units: Python's clip keeps it.
    const mathy = talk("1", NOW + DAY, { abstract: `${"x".repeat(3999)}\u{1D53D}` })
    const backwards = talk("2", NOW + DAY, { endsAt: NOW })
    const sprawling = talk("3", NOW + DAY, { endsAt: NOW + 60 * DAY })
    expect(await post(t, "run-1", [mathy, backwards, sprawling])).toEqual({
      inserted: 3,
      updated: 0,
      unchanged: 0,
    })
    expect((await rowOf(t, backwards.key))?.endsAt).toBeNull()
    expect((await rowOf(t, sprawling.key))?.endsAt).toBeNull()
    await expect(
      post(t, "run-1", [talk("4", NOW, { abstract: `${"x".repeat(4000)}\u{1D53D}` })]),
    ).rejects.toThrow(/abstract is longer/)
  })

  test("a talk with no department has no School", async () => {
    const t = newTest()
    await seed(t)
    const loose = talk("2", NOW + DAY, { departmentKeys: [] })
    await post(t, "run-1", [loose])
    const row = await rowOf(t, loose.key)
    expect(row?.primaryDepartmentKey).toBeNull()
    expect(row?.school).toBeNull()
  })

  test("refuses a wrong key, an unknown department, an over-cap field and a big batch", async () => {
    const t = newTest()
    await seed(t)
    await expect(
      post(t, "r", [{ ...talk("1", NOW), key: "talk-00000000000000000000" }]),
    ).rejects.toThrow(/key is not/)
    await expect(post(t, "r", [talk("1", NOW, { departmentKeys: ["dept-nope"] })])).rejects.toThrow(
      /department not found/,
    )
    await expect(post(t, "r", [talk("1", NOW, { title: "x".repeat(501) })])).rejects.toThrow(
      /title is longer/,
    )
    await expect(post(t, "r", [talk("1", NOW, { source: "somewhere" })])).rejects.toThrow(/source/)
    const many = Array.from({ length: MAX_TALK_BATCH + 1 }, (_, i) => talk(`${i}`, NOW))
    await expect(post(t, "r", many)).rejects.toThrow(/Batch too large/)
    expect(await t.run(async (ctx) => ctx.db.query("talks").collect())).toHaveLength(0)
  })
})

describe("talks/sweep", () => {
  test("marks missing only the swept sources' unseen talks inside the window", async () => {
    const t = newTest()
    await seed(t)
    const kept = talk("1", NOW + DAY)
    const gone = talk("2", NOW + 2 * DAY)
    const later = talk("3", NOW + 90 * DAY)
    const otherSource = deptTalk("4", NOW + DAY)
    await post(t, "run-1", [kept, gone, later, otherSource])
    // Run 2 reads talks.cam completely but only sees `kept`.
    await post(t, "run-2", [kept])
    const result = await t.mutation(internal.ingest.talks.sweep, {
      runId: "run-2",
      from: NOW,
      to: NOW + 60 * DAY,
      sources: ["talks_cam"],
    })
    expect(result).toEqual({ missing: 1, done: true, cursor: null })
    expect((await rowOf(t, kept.key))?.listing).toBe("listed")
    expect((await rowOf(t, gone.key))?.listing).toBe("missing")
    expect((await rowOf(t, later.key))?.listing).toBe("listed")
    expect((await rowOf(t, otherSource.key))?.listing).toBe("listed")

    // Never deleted; listed again when a later run posts it.
    expect(await post(t, "run-3", [gone])).toEqual({ inserted: 0, updated: 1, unchanged: 0 })
    expect((await rowOf(t, gone.key))?.listing).toBe("listed")
  })

  test("a talk that already started stays listed when its source drops it", async () => {
    const t = newTest()
    await seed(t)
    // Yesterday's talk, and one that started an hour ago and is still on.
    const ended = deptTalk("e1", NOW - DAY)
    const running = deptTalk("e2", NOW - HOUR, { endsAt: NOW + HOUR })
    const upcoming = deptTalk("e3", NOW + DAY)
    const kept = deptTalk("e4", NOW + 2 * DAY)
    await post(t, "run-1", [ended, running, upcoming, kept])
    // An upcoming-only page: run 2 sees only `kept`.
    await post(t, "run-2", [kept])
    const result = await t.mutation(internal.ingest.talks.sweep, {
      runId: "run-2",
      from: NOW - 2 * DAY,
      to: NOW + 60 * DAY,
      sources: [`${HISTORY.key}#0`],
    })
    expect(result.missing).toBe(1)
    expect((await rowOf(t, ended.key))?.listing).toBe("listed")
    expect((await rowOf(t, running.key))?.listing).toBe("listed")
    expect((await rowOf(t, upcoming.key))?.listing).toBe("missing")
    expect(await t.query(api.talks.get, { key: ended.key })).not.toBeNull()
  })

  test("pages through a large source with a cursor; the route loops to the end", async () => {
    const t = newTest()
    await seed(t)
    const total = SWEEP_PAGE + 50
    for (let start = 0; start < total; start += MAX_TALK_BATCH) {
      const chunk = Array.from({ length: Math.min(MAX_TALK_BATCH, total - start) }, (_, i) =>
        talk(`${start + i}`, NOW + DAY + (start + i) * 60_000),
      )
      await post(t, "run-1", chunk)
    }
    await post(t, "run-1", [deptTalk("h", NOW + DAY)])
    const args = {
      runId: "run-2",
      from: NOW,
      to: NOW + 30 * DAY,
      sources: ["talks_cam", `${HISTORY.key}#0`],
    }
    const first = await t.mutation(internal.ingest.talks.sweep, args)
    expect(first.done).toBe(false)
    expect(first.missing).toBe(SWEEP_PAGE)
    const second = await t.mutation(internal.ingest.talks.sweep, { ...args, cursor: first.cursor })
    expect(second).toEqual({ missing: 51, done: true, cursor: null })

    // Through the HTTP route, a fresh run's sweep finds them already missing.
    await withEnv(
      { PIPELINE_API_KEY: "k", BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789" },
      async () => {
        const response = await t.fetch("/api/pipeline/talks/sweep", {
          method: "POST",
          headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
          body: JSON.stringify({ ...args, runId: "run-3" }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ missing: 0, done: true, cursor: null })
      },
    )
  })

  test("the route sums missing across calls", async () => {
    const t = newTest()
    await seed(t)
    const total = SWEEP_PAGE + 10
    for (let start = 0; start < total; start += MAX_TALK_BATCH) {
      const chunk = Array.from({ length: Math.min(MAX_TALK_BATCH, total - start) }, (_, i) =>
        talk(`${start + i}`, NOW + DAY + (start + i) * 60_000),
      )
      await post(t, "run-1", chunk)
    }
    await withEnv(
      { PIPELINE_API_KEY: "k", BETTER_AUTH_SECRET: "test-secret-for-better-auth-0123456789" },
      async () => {
        const response = await t.fetch("/api/pipeline/talks/sweep", {
          method: "POST",
          headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: "run-2",
            from: NOW,
            to: NOW + 30 * DAY,
            sources: ["talks_cam"],
          }),
        })
        expect(await response.json()).toEqual({ missing: total, done: true, cursor: null })
      },
    )
  })

  test("refuses a bad source and an inverted window", async () => {
    const t = newTest()
    await expect(
      t.mutation(internal.ingest.talks.sweep, { runId: "r", from: 0, to: DAY, sources: ["nope"] }),
    ).rejects.toThrow(/Not a talk source/)
    await expect(
      t.mutation(internal.ingest.talks.sweep, { runId: "r", from: DAY, to: 0, sources: [] }),
    ).rejects.toThrow(/after/)
  })
})

describe("talks/runs", () => {
  const run = {
    runId: "run-1",
    status: "ok" as const,
    startedAt: NOW - HOUR,
    finishedAt: NOW,
    sourcesOk: 3,
    sourcesFailed: 0,
    talksReceived: 120,
    inserted: 100,
    updated: 10,
    unchanged: 10,
    missing: 2,
    errors: [],
  }

  test("upserts by runId and feeds overview.lastRunAt", async () => {
    const t = newTest()
    expect(await t.mutation(internal.ingest.talks.runs, run)).toEqual({
      runId: "run-1",
      outcome: "inserted",
    })
    expect(
      await t.mutation(internal.ingest.talks.runs, { ...run, errors: ["x".repeat(900)] }),
    ).toEqual({ runId: "run-1", outcome: "updated" })
    const rows = await t.run(async (ctx) => ctx.db.query("talkRuns").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0].errors[0].length).toBe(500)
    expect((await t.query(api.talks.overview, {})).lastRunAt).toBe(NOW)
  })

  test("refuses negative counts", async () => {
    const t = newTest()
    await expect(t.mutation(internal.ingest.talks.runs, { ...run, missing: -1 })).rejects.toThrow(
      /non-negative/,
    )
  })
})

describe("retention", () => {
  test("deletes talks and details ended more than 30 days ago, listed or missing", async () => {
    const t = newTest()
    await seed(t)
    const cutoffDays = TALK_RETENTION_DAYS
    const old = talk("old", NOW - (cutoffDays + 2) * DAY)
    const recent = talk("recent", NOW - (cutoffDays - 2) * DAY)
    // Started long ago, ended recently (a long workshop run).
    const long = talk("long", NOW - (cutoffDays + 10) * DAY, {
      endsAt: NOW - (cutoffDays - 20) * DAY,
    })
    const oldMissing = deptTalk("om", NOW - (cutoffDays + 5) * DAY)
    await post(t, "run-1", [old, recent, long, oldMissing])
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("talks")
        .withIndex("by_key", (q) => q.eq("key", oldMissing.key))
        .unique()
      if (row) await ctx.db.patch(row._id, { listing: "missing" })
    })
    await t.mutation(internal.ingest.talks.purgeExpired, { now: NOW })
    await settle(t)
    const keys = (await t.run(async (ctx) => ctx.db.query("talks").collect())).map((row) => row.key)
    expect(keys.sort()).toEqual([long.key, recent.key].sort())
    const details = await t.run(async (ctx) => ctx.db.query("talkDetails").collect())
    expect(details.map((row) => row.talkKey).sort()).toEqual([long.key, recent.key].sort())
  })
})

describe("public queries", () => {
  async function fixture() {
    const t = newTest()
    await seed(t)
    const talks = {
      cst: talk("1", NOW + 2 * HOUR),
      cstWorkshop: talk("2", NOW + DAY, { kind: "workshop", online: true }),
      history: deptTalk("3", NOW + 2 * DAY, { title: "Medieval Fenland Charters" }),
      loose: talk("4", NOW + 3 * DAY, { departmentKeys: [], series: "Darwin College Lectures" }),
      cancelled: talk("5", NOW + 3 * DAY, { cancelled: true }),
      past: talk("6", NOW - 3 * DAY, { title: "Fenland drainage, past" }),
      far: talk("7", NOW + 40 * DAY),
      gone: talk("8", NOW + DAY),
    }
    await post(t, "run-1", Object.values(talks))
    await post(
      t,
      "run-2",
      Object.values(talks).filter((row) => row !== talks.gone),
    )
    await t.mutation(internal.ingest.talks.sweep, {
      runId: "run-2",
      from: NOW - 7 * DAY,
      to: NOW + 60 * DAY,
      sources: ["talks_cam", `${HISTORY.key}#0`],
    })
    await settle(t)
    return { t, talks }
  }

  test("list: listed talks in the window by start, without abstracts", async () => {
    const { t, talks } = await fixture()
    const result = await t.query(api.talks.list, {
      from: NOW,
      to: NOW + 30 * DAY,
      paginationOpts: page,
    })
    // Same start: insertion order (loose before cancelled).
    expect(result.page.map((row) => row.key)).toEqual([
      talks.cst.key,
      talks.cstWorkshop.key,
      talks.history.key,
      talks.loose.key,
      talks.cancelled.key,
    ])
    expect(result.page[0]).not.toHaveProperty("abstract")
    expect(result.page[0].departments).toEqual([
      { key: CST.key, slug: CST.slug, shortName: CST.shortName, school: "technology" },
    ])
    expect(result.page.find((row) => row.key === talks.loose.key)?.departments).toEqual([])
  })

  test("list: School, department slug, other-series, kind and online filters", async () => {
    const { t, talks } = await fixture()
    const window = { from: NOW, to: NOW + 30 * DAY, paginationOpts: page }
    const keys = async (args: Record<string, unknown>) =>
      (await t.query(api.talks.list, { ...window, ...args })).page.map((row) => row.key)
    expect(await keys({ school: "arts_humanities" })).toEqual([talks.history.key])
    expect(await keys({ department: "history" })).toEqual([talks.history.key])
    expect(await keys({ department: "other-series" })).toEqual([talks.loose.key])
    expect(await keys({ department: "no-such-department" })).toEqual([])
    expect(await keys({ kind: "workshop" })).toEqual([talks.cstWorkshop.key])
    expect(await keys({ online: true })).toEqual([talks.cstWorkshop.key])
    expect(await keys({ department: CST.slug, school: "arts_humanities" })).toEqual([])
  })

  test("list: paginates and refuses a window over 186 days", async () => {
    const { t } = await fixture()
    const first = await t.query(api.talks.list, {
      from: NOW,
      to: NOW + 60 * DAY,
      paginationOpts: { numItems: 2, cursor: null },
    })
    expect(first.page).toHaveLength(2)
    expect(first.isDone).toBe(false)
    const rest = await t.query(api.talks.list, {
      from: NOW,
      to: NOW + 60 * DAY,
      paginationOpts: { numItems: 50, cursor: first.continueCursor },
    })
    expect(rest.page).toHaveLength(4)
    await expect(
      t.query(api.talks.list, { from: NOW, to: NOW + 200 * DAY, paginationOpts: page }),
    ).rejects.toThrow(/limited/)
  })

  test("search: upcoming listed matches only, filterable", async () => {
    const { t, talks } = await fixture()
    const hits = await t.query(api.talks.search, { q: "fenland", from: NOW })
    expect(hits.map((row) => row.key)).toEqual([talks.history.key])
    expect(await t.query(api.talks.search, { q: "fenland", school: "technology" })).toEqual([])
    expect((await t.query(api.talks.search, { q: "darwin" })).map((row) => row.key)).toEqual([
      talks.loose.key,
    ])
    expect(await t.query(api.talks.search, { q: "  " })).toEqual([])
    const inDepartment = async (department: string, q: string) =>
      (await t.query(api.talks.search, { q, department })).map((row) => row.key)
    expect(await inDepartment("history", "fenland")).toEqual([talks.history.key])
    expect(await inDepartment(CST.slug, "fenland")).toEqual([])
    expect(await inDepartment("other-series", "darwin")).toEqual([talks.loose.key])
    expect(await inDepartment("other-series", "fenland")).toEqual([])
    expect(await inDepartment("no-such-department", "fenland")).toEqual([])
  })

  test("get: abstract and provenance; null for a missing talk", async () => {
    const { t, talks } = await fixture()
    const one = await t.query(api.talks.get, { key: talks.cst.key })
    expect(one?.abstract).toBe("Abstract of 1")
    expect(one?.specialMessage).toBeNull()
    expect(one?.sourceUrl).toBe(talks.cst.sourceUrl)
    expect(await t.query(api.talks.get, { key: talks.gone.key })).toBeNull()
    expect(await t.query(api.talks.get, { key: "talk-nope" })).toBeNull()
  })

  test("exists: true for a listed talk only (the ENG-20 404 gate)", async () => {
    const { t, talks } = await fixture()
    expect(await t.query(api.talks.exists, { key: talks.cst.key })).toBe(true)
    expect(await t.query(api.talks.exists, { key: talks.gone.key })).toBe(false)
    expect(await t.query(api.talks.exists, { key: "talk-nope" })).toBe(false)
  })

  test("dayCounts: every London day, zeros included, cancelled not counted", async () => {
    const { t, talks } = await fixture()
    const firstDay = londonIsoDate(NOW)
    const from = londonMidnight(firstDay)
    const counts = await t.query(api.talks.dayCounts, { from, to: from + 7 * DAY })
    expect(counts).toHaveLength(7)
    expect(counts[0].day).toBe(firstDay)
    const total = counts.reduce((sum, day) => sum + day.count, 0)
    // cst, workshop, history, loose (cancelled and past excluded; `gone` is missing).
    const inWindow = [talks.cst, talks.cstWorkshop, talks.history, talks.loose].filter(
      (row) => row.startsAt >= from && row.startsAt < from + 7 * DAY,
    )
    expect(total).toBe(inWindow.length)
    const history = await t.query(api.talks.dayCounts, {
      from,
      to: from + 7 * DAY,
      department: "history",
    })
    expect(history.find((day) => day.day === londonIsoDate(talks.history.startsAt))?.count).toBe(1)
    await expect(t.query(api.talks.dayCounts, { from, to: from + 70 * DAY })).rejects.toThrow(
      /limited/,
    )
  })

  test("dayCounts: a talk at 23:30 UTC in summer time is on the next London day", async () => {
    const t = newTest()
    await seed(t)
    const at = Date.UTC(2026, 6, 14, 23, 30) // 00:30 BST on 15 July
    await post(t, "run-1", [talk("bst", at)])
    const from = londonMidnight("2026-07-14")
    const counts = await t.query(api.talks.dayCounts, { from, to: from + 2 * DAY })
    expect(counts).toEqual([
      { day: "2026-07-14", count: 0 },
      { day: "2026-07-15", count: 1 },
    ])
  })

  test("departments and overview read the stats a finished sweep refreshed", async () => {
    const { t, talks } = await fixture()
    const rows = await t.query(api.talks.departments, {})
    expect(rows.map((row) => row.slug)).toEqual([
      "history",
      "computer-science-and-technology",
      "other-series",
    ])
    const cst = rows.find((row) => row.key === CST.key)
    // cst + workshop (cancelled, past, the 40-day one and the missing one are out).
    expect(cst?.upcomingCount).toBe(2)
    expect(cst?.nextStartsAt).toBe(talks.cst.startsAt)
    const other = rows[rows.length - 1]
    expect(other).toMatchObject({ virtual: true, upcomingCount: 1, school: "other", website: null })

    const overview = await t.query(api.talks.overview, {})
    expect(overview.next28Days).toBe(4)
    expect(overview.departments).toBe(2)
    expect(overview.departmentsTotal).toBe(2)
    const week = londonWeekOf(overview.computedAt as number)
    const listedThisWeek = [
      talks.cst,
      talks.cstWorkshop,
      talks.history,
      talks.loose,
      talks.past,
    ].filter((row) => row.startsAt >= week.start && row.startsAt < week.end).length
    expect(overview.thisWeek).toBe(listedThisWeek)
  })

  test("with no stats yet, the counts are zero", async () => {
    const t = newTest()
    await seed(t)
    expect(await t.query(api.talks.overview, {})).toMatchObject({
      thisWeek: 0,
      next28Days: 0,
      departments: 0,
      lastRunAt: null,
      computedAt: null,
    })
    expect((await t.query(api.talks.departments, {})).every((row) => row.upcomingCount === 0)).toBe(
      true,
    )
  })
})

describe("suppressions", () => {
  /** A talk naming Anna Smith as speaker, host and contact. */
  const named = (id: string) =>
    talk(id, NOW + DAY, {
      title: "Chess engines, with Anna Smith",
      speakers: [
        { name: "anna smith", affiliation: "Analytical Engines Ltd" },
        { name: "Prof. Anna Smith" },
        { name: "Ada Lovelace" },
      ],
      abstract: "Questions to anna.smith@gmail.com, Anna Smith hosts.",
      specialMessage: "Ask Anna Smith for the room.",
    })

  async function suppress(t: TestConvex) {
    await t.run(async (ctx) => {
      await createSuppression(ctx, { scope: "name", valueHash: nameHash("Anna Smith") })
      await createSuppression(ctx, {
        scope: "contact",
        valueHash: contactHash("anna.smith@gmail.com"),
      })
    })
  }

  async function shown(t: TestConvex, key: string) {
    const window = { from: NOW, to: NOW + 7 * DAY, paginationOpts: page }
    return {
      get: await t.query(api.talks.get, { key }),
      list: (await t.query(api.talks.list, window)).page.find((row) => row.key === key),
      search: await t.query(api.talks.search, { q: "anna smith", from: NOW }),
    }
  }

  test("a suppressed speaker and address are never stored, shown or found", async () => {
    const t = newTest()
    await seed(t)
    await suppress(t)
    const posted = named("s1")
    expect(await post(t, "run-1", [posted])).toEqual({ inserted: 1, updated: 0, unchanged: 0 })
    const { get, list, search } = await shown(t, posted.key)
    expect(get?.speakers).toEqual([{ name: "Ada Lovelace" }])
    expect(get?.title).toBe("Chess engines, with [name removed]")
    expect(get?.abstract).toBe("Questions to [address removed], [name removed] hosts.")
    expect(get?.specialMessage).toBe("Ask [name removed] for the room.")
    expect(list?.speakers).toEqual([{ name: "Ada Lovelace" }])
    expect(search).toEqual([])
    const stored = await t.run(async (ctx) => ({
      talks: await ctx.db.query("talks").collect(),
      details: await ctx.db.query("talkDetails").collect(),
    }))
    expect(JSON.stringify(stored).toLowerCase()).not.toContain("anna")
    // The next run posts it unchanged: still clean, and unchanged.
    expect(await post(t, "run-2", [posted])).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
  })

  test("accepting one hides what is stored at once and the walk rewrites it", async () => {
    const t = newTest()
    await seed(t)
    const posted = named("s2")
    await post(t, "run-1", [posted])
    expect(await t.query(api.talks.search, { q: "anna smith", from: NOW })).toHaveLength(1)

    await suppress(t)
    // The query backstop, before the walk ran.
    const before = await shown(t, posted.key)
    expect(before.get?.speakers).toEqual([{ name: "Ada Lovelace" }])
    expect(before.get?.abstract).toBe("Questions to [address removed], [name removed] hosts.")
    expect(before.list?.title).toBe("Chess engines, with [name removed]")
    expect(before.search).toEqual([])

    await settle(t)
    const row = await rowOf(t, posted.key)
    expect(row?.speakers).toEqual([{ name: "Ada Lovelace" }])
    expect(row?.searchText).not.toContain("anna")
    const details = await t.run(async (ctx) => ctx.db.query("talkDetails").collect())
    expect(JSON.stringify(details).toLowerCase()).not.toContain("anna")
    // Still found by what remains.
    expect(
      (await t.query(api.talks.search, { q: "lovelace", from: NOW })).map((hit) => hit.key),
    ).toEqual([posted.key])
    expect(await post(t, "run-2", [posted])).toEqual({ inserted: 0, updated: 0, unchanged: 1 })
  })
})
