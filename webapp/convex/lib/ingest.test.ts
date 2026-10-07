import { describe, expect, test } from "bun:test"
import type { Doc } from "../_generated/dataModel"
import { newTest } from "./harness.testing"
import {
  assertBatchSize,
  MAX_BATCH,
  pageLimit,
  planPrune,
  pruneTable,
  sameFields,
  upsertRow,
  valuesEqual,
} from "./ingest"

describe("valuesEqual / sameFields", () => {
  test("compares nested Convex values structurally", () => {
    expect(valuesEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true)
    expect(valuesEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false)
    expect(valuesEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(valuesEqual(null, undefined)).toBe(false)
    expect(valuesEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true)
  })

  test("undefined equals a missing key, as in Convex", () => {
    expect(valuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true)
  })

  test("only the incoming keys decide — a patch leaves other fields alone", () => {
    const existing = { name: "Chess", members: 40, website: "https://chess.example" }
    expect(sameFields(existing, { name: "Chess" })).toBe(true)
    expect(sameFields(existing, { name: "Chess Society" })).toBe(false)
    // null is a value ("the source says none"), not the same as absent.
    expect(sameFields(existing, { website: null })).toBe(false)
  })
})

describe("planPrune", () => {
  const rows = ["a", "b", "c", "d"].map((key) => ({ key }))
  const keyOf = (row: { key: string }) => row.key

  test("returns the rows whose key was not kept", () => {
    expect(planPrune(rows, keyOf, ["a", "b", "c"], { unit: "rows" })).toEqual([{ key: "d" }])
  })

  test("refuses to delete more than half without an explicit flag", () => {
    expect(() => planPrune(rows, keyOf, ["a"], { unit: "societies" })).toThrow(
      /Refusing to delete 3 of 4 societies/,
    )
    expect(planPrune(rows, keyOf, ["a"], { unit: "rows", allowLargeDeletion: true })).toHaveLength(
      3,
    )
  })

  test("exactly half is allowed; an empty table prunes nothing", () => {
    expect(planPrune(rows, keyOf, ["a", "b"], { unit: "rows" })).toHaveLength(2)
    expect(planPrune([], keyOf, [], { unit: "rows" })).toEqual([])
  })
})

describe("batch bounds", () => {
  test("assertBatchSize rejects rather than truncates", () => {
    expect(() => assertBatchSize(MAX_BATCH, "rows")).not.toThrow()
    expect(() => assertBatchSize(MAX_BATCH + 1, "societies")).toThrow(/501 societies/)
  })

  test("pageLimit clamps and survives NaN", () => {
    expect(pageLimit(undefined)).toBe(50)
    expect(pageLimit(Number.NaN)).toBe(50)
    expect(pageLimit(0)).toBe(1)
    expect(pageLimit(1e9)).toBe(500)
  })
})

describe("upsertRow / pruneTable against a real table", () => {
  const fields = {
    runKey: "r1",
    command: "sync",
    requestedStages: ["fetch"],
    pipelineVersion: "0.1.0",
    status: "running" as const,
    startedAt: 1,
    finishedAt: null,
    stages: [],
    warnings: [],
    error: null,
  }

  async function find(
    ctx: Parameters<Parameters<ReturnType<typeof newTest>["run"]>[0]>[0],
    runKey: string,
  ) {
    return (await ctx.db
      .query("harvestRuns")
      .withIndex("by_runKey", (q) => q.eq("runKey", runKey))
      .unique()) as Doc<"harvestRuns"> | null
  }

  test("inserts, then reports unchanged without writing, then updates", async () => {
    const t = newTest()
    const outcomes = await t.run(async (ctx) => {
      const first = await upsertRow(ctx, "harvestRuns", null, fields, 100, {
        touchUpdatedAt: true,
      })
      const again = await upsertRow(ctx, "harvestRuns", await find(ctx, "r1"), fields, 200, {
        touchUpdatedAt: true,
      })
      const afterSame = await find(ctx, "r1")
      const changed = await upsertRow(
        ctx,
        "harvestRuns",
        afterSame,
        { ...fields, command: "backfill" },
        300,
        { touchUpdatedAt: true },
      )
      const final = await find(ctx, "r1")
      return {
        outcomes: [first.outcome, again.outcome, changed.outcome],
        updatedAtAfterSame: afterSame?.updatedAt,
        final,
      }
    })
    expect(outcomes.outcomes).toEqual(["inserted", "unchanged", "updated"])
    // An unchanged row is not touched at all — not even its updatedAt.
    expect(outcomes.updatedAtAfterSame).toBe(100)
    expect(outcomes.final?.updatedAt).toBe(300)
    expect(outcomes.final?.createdAt).toBe(100)
    expect(outcomes.final?.command).toBe("backfill")
  })

  test("pruneTable deletes the unkept rows and honours the guard", async () => {
    const t = newTest()
    const result = await t.run(async (ctx) => {
      for (const runKey of ["a", "b", "c", "d"]) {
        await upsertRow(ctx, "harvestRuns", null, { ...fields, runKey }, 1, {
          touchUpdatedAt: true,
        })
      }
      const pruned = await pruneTable(ctx, "harvestRuns", (row) => row.runKey, ["a", "b", "c"])
      let refused = ""
      try {
        await pruneTable(ctx, "harvestRuns", (row) => row.runKey, ["a"])
      } catch (error) {
        refused = (error as Error).message
      }
      const left = (await ctx.db.query("harvestRuns").take(100)).map((row) => row.runKey).sort()
      return { pruned, refused, left }
    })
    expect(result.pruned).toEqual({ deleted: 1 })
    expect(result.refused).toMatch(/Refusing to delete 2 of 3/)
    expect(result.left).toEqual(["a", "b", "c"])
  })
})
