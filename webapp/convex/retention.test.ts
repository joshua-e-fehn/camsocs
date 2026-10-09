import { describe, expect, test } from "bun:test"
import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { ClaimInput } from "./ingest/claims"
import { newTest, type TestConvex } from "./lib/harness.testing"
import { RETENTION } from "./retention"

/**
 * The retention schedule (docs/compliance/retention.md), run as the daily
 * cron would: `retention.daily` with a pinned clock, then every walk it
 * schedules to the end.
 */

const DAY = 86_400_000
const NOW = Date.now()
const daysAgo = (days: number) => NOW - days * DAY

async function runDaily(t: TestConvex) {
  await t.mutation(internal.retention.daily, { now: NOW })
  await t.finishAllScheduledFunctions(() => {})
}

function eventClaims(key: string, startsAt: number, extra: Partial<ClaimInput>[] = []) {
  const base = {
    entityType: "event" as const,
    entityKey: key,
    evidence: "primary" as const,
    method: "parser" as const,
    extractor: "test",
    sourceKey: `src-${key}`,
    sourceUrl: `https://example.org/${key}`,
    sourceType: "ics_feed" as const,
    retrievedAt: NOW - DAY,
  }
  const fields: [string, unknown][] = [
    ["title", `Event ${key}`],
    ["startsAt", startsAt],
    ["visibility", "public"],
    ["source", "ics"],
    ["externalId", key],
    ["sourceUrl", `https://example.org/${key}`],
  ]
  return [
    ...fields.map(([field, value]) => ({ ...base, field, value })),
    ...extra.map((part) => ({ ...base, ...part }) as ClaimInput),
  ]
}

async function storeImage(t: TestConvex, label: string) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([label], { type: "image/png" }))
    await ctx.db.insert("storedFiles", {
      sha256: label,
      storageId,
      contentType: "image/png",
      size: label.length,
      createdAt: NOW,
    })
    return storageId
  })
}

describe("retention", () => {
  test("R3: events a year past their end go, with claims, links and unused images", async () => {
    const t = newTest()
    const oldImage = await storeImage(t, "old")
    const sharedImage = await storeImage(t, "shared")
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        {
          entityType: "organisation",
          entityKey: "org-chess",
          field: "name",
          value: "CU Chess Club",
          evidence: "primary",
          method: "parser",
          extractor: "test",
          sourceKey: "src-chess",
          sourceUrl: "https://cuchess.org/",
          sourceType: "society_website",
          retrievedAt: NOW - DAY,
        },
        {
          entityType: "organisation",
          entityKey: "org-chess",
          field: "logo",
          value: { storageId: sharedImage, sourceUrl: "https://cuchess.org/logo.png" },
          evidence: "primary",
          method: "parser",
          extractor: "test",
          sourceKey: "src-chess",
          sourceUrl: "https://cuchess.org/",
          sourceType: "society_website",
          retrievedAt: NOW - DAY,
        },
        ...eventClaims("evt-old", daysAgo(400), [
          { field: "image", value: { storageId: oldImage } },
        ]),
        ...eventClaims("evt-old-shared", daysAgo(400), [
          { field: "image", value: { storageId: sharedImage } },
        ]),
        ...eventClaims("evt-recent", daysAgo(10)),
      ],
    })
    await t.mutation(internal.ingest.relationships.setEventOrganisers, {
      events: [
        { eventKey: "evt-old", organisers: [{ orgKey: "org-chess", role: "organiser" }] },
        { eventKey: "evt-recent", organisers: [{ orgKey: "org-chess", role: "organiser" }] },
      ],
    })

    await runDaily(t)

    const after = await t.run(async (ctx) => ({
      events: (await ctx.db.query("events").take(10)).map((event) => event.key),
      links: (await ctx.db.query("eventOrganisers").take(10)).map((link) => link.eventKey),
      oldClaims: await ctx.db
        .query("fieldClaims")
        .withIndex("by_entity_review", (q) =>
          q.eq("entityType", "event").eq("entityKey", "evt-old").eq("reviewStatus", "accepted"),
        )
        .take(10),
      oldFile: await ctx.db.system.get("_storage", oldImage as Id<"_storage">),
      sharedFile: await ctx.db.system.get("_storage", sharedImage as Id<"_storage">),
      files: (await ctx.db.query("storedFiles").take(10)).map((row) => row.sha256),
    }))
    expect(after.events).toEqual(["evt-recent"])
    expect(after.links).toEqual(["evt-recent"])
    expect(after.oldClaims).toEqual([])
    expect(after.oldFile).toBeNull()
    // Still the club's logo.
    expect(after.sharedFile).not.toBeNull()
    expect(after.files).toEqual(["shared"])
  })

  test("R4: processed mail loses its body after 30 days and the row after 90", async () => {
    const t = newTest()
    const ids = await t.run(async (ctx) => {
      const html = await ctx.storage.store(new Blob(["<p>hi</p>"], { type: "text/html" }))
      const mail = (messageId: string, extraction: "done" | "pending", days: number) => ({
        messageId,
        receivedAt: daysAgo(days),
        from: "list@example.org",
        subject: "Events this week",
        text: "Talk on Tuesday",
        attachments: [],
        extraction,
        extractedEventKeys: [],
        createdAt: daysAgo(days),
        updatedAt: daysAgo(days),
      })
      return {
        html,
        stripped: await ctx.db.insert("inboundEmails", {
          ...mail("m-40-done", "done", 40),
          htmlStorageId: html,
        }),
        pending: await ctx.db.insert("inboundEmails", mail("m-40-pending", "pending", 40)),
        fresh: await ctx.db.insert("inboundEmails", mail("m-5-done", "done", 5)),
        old: await ctx.db.insert("inboundEmails", mail("m-100-pending", "pending", 100)),
      }
    })
    await runDaily(t)
    const after = await t.run(async (ctx) => ({
      stripped: await ctx.db.get("inboundEmails", ids.stripped),
      pending: await ctx.db.get("inboundEmails", ids.pending),
      fresh: await ctx.db.get("inboundEmails", ids.fresh),
      old: await ctx.db.get("inboundEmails", ids.old),
      html: await ctx.db.system.get("_storage", ids.html),
    }))
    expect(after.stripped).toMatchObject({ text: "", attachments: [], bodyDeletedAt: NOW })
    expect(after.stripped?.htmlStorageId).toBeUndefined()
    expect(after.html).toBeNull()
    // Not yet processed: its body is still needed.
    expect(after.pending?.text).toBe("Talk on Tuesday")
    expect(after.fresh?.text).toBe("Talk on Tuesday")
    expect(after.old).toBeNull()
  })

  test("R5: people go 30 days past their handover; broker rows are archived first", async () => {
    const t = newTest()
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    await t.run(async (ctx) => {
      const person = (
        key: string,
        staleAfter: string,
        method: "llm" | "manual",
        extra: { archived?: boolean; consent?: boolean; updatedAt?: number } = {},
      ) => ({
        key,
        name: key,
        orgKey: "org-a",
        role: "President",
        academicYear: "2025-26",
        staleAfter,
        stale: true,
        sourceUrl: "https://a.org",
        seenAt: 0,
        publicLinks: [],
        consentBasis: extra.consent ? ("consent" as const) : ("public_source" as const),
        method,
        archived: extra.archived ?? false,
        createdAt: 0,
        updatedAt: extra.updatedAt ?? NOW,
      })
      await ctx.db.insert("people", person("per-harvested", iso(daysAgo(60)), "llm"))
      await ctx.db.insert("people", person("per-recent", iso(daysAgo(10)), "llm"))
      await ctx.db.insert("people", person("per-broker", iso(daysAgo(60)), "manual"))
      await ctx.db.insert(
        "people",
        person("per-broker-old", iso(daysAgo(600)), "manual", {
          archived: true,
          updatedAt: daysAgo(400),
        }),
      )
      await ctx.db.insert(
        "people",
        person("per-consent", iso(daysAgo(60)), "llm", { consent: true }),
      )
      await ctx.db.insert("people", {
        ...person("per-unflagged", iso(daysAgo(60)), "llm"),
        stale: false,
      })
    })
    await runDaily(t)
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("people").take(20)).map((p) => [p.key, p.archived]),
    )
    expect(Object.fromEntries(rows)).toEqual({
      "per-recent": false,
      "per-broker": true,
      "per-consent": false,
    })
  })

  test("R6, R8, R10: interactions, requests and runs by age", async () => {
    const t = newTest()
    const years = (n: number) => daysAgo(n * 365)
    await t.run(async (ctx) => {
      const interaction = (key: string, orgKey: string, date: number) => ({
        key,
        date,
        orgKey,
        channel: "email" as const,
        summary: "Wrote to them",
        createdAt: date,
        updatedAt: date,
      })
      await ctx.db.insert("interactions", interaction("int-old-active", "org-a", years(4)))
      await ctx.db.insert("interactions", interaction("int-new", "org-a", years(1)))
      await ctx.db.insert("interactions", interaction("int-old-quiet", "org-b", years(4)))
      await ctx.db.insert("introductions", {
        key: "intro-old",
        partyA: { orgKey: "org-a" },
        partyB: { orgKey: "org-b" },
        reason: "Both run chess events",
        date: years(4),
        status: "met",
        createdAt: years(4),
        updatedAt: years(4),
      })
      const requestRow = (
        key: string,
        status: "open" | "rejected" | "accepted" | "done",
        days: number,
      ) => ({
        key,
        orgKey: "org-a",
        kind: "correct" as const,
        submitterEmail: "someone@example.org",
        message: "Please fix our website",
        status,
        createdAt: daysAgo(days + 1),
        ...(status === "open" ? {} : { resolvedAt: daysAgo(days) }),
      })
      await ctx.db.insert("listingRequests", requestRow("lr-rejected-old", "rejected", 100))
      await ctx.db.insert("listingRequests", requestRow("lr-rejected-new", "rejected", 30))
      await ctx.db.insert("listingRequests", requestRow("lr-accepted", "accepted", 365))
      await ctx.db.insert("listingRequests", requestRow("lr-done-old", "done", 3 * 365))
      await ctx.db.insert("listingRequests", requestRow("lr-open-old", "open", 3 * 365))
      for (const [runKey, days] of [
        ["run-old", RETENTION.runDays + 5],
        ["run-new", 3],
      ] as const) {
        await ctx.db.insert("harvestRuns", {
          runKey,
          command: "sync",
          requestedStages: [],
          pipelineVersion: "0.1.0",
          status: "success",
          startedAt: daysAgo(days),
          finishedAt: daysAgo(days),
          stages: [],
          warnings: [],
          error: null,
          createdAt: daysAgo(days),
          updatedAt: daysAgo(days),
        })
      }
    })
    await runDaily(t)
    const after = await t.run(async (ctx) => ({
      interactions: (await ctx.db.query("interactions").take(10)).map((row) => row.key).sort(),
      introductions: await ctx.db.query("introductions").take(10),
      requests: (await ctx.db.query("listingRequests").take(10)).map((row) => row.key).sort(),
      runs: (await ctx.db.query("harvestRuns").take(10)).map((row) => row.runKey),
    }))
    expect(after.interactions).toEqual(["int-new", "int-old-active"])
    expect(after.introductions).toEqual([])
    expect(after.requests).toEqual(["lr-accepted", "lr-open-old", "lr-rejected-new"])
    expect(after.runs).toEqual(["run-new"])
  })
})
