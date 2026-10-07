import { describe, expect, test } from "bun:test"
import { v } from "convex/values"
import schema from "../schema"
import { checkValue } from "./checkValue"
import {
  assertRegistryMatchesVocab,
  EVENT_SPECS,
  hostOf,
  isHttpUrl,
  normaliseUrl,
  ORGANISATION_SPECS,
  SESSION_SPECS,
  TEAM_SPECS,
  VENUE_SPECS,
} from "./fields"

/**
 * The field registry is the bridge between lib/vocab.ts (field names, shared
 * with the pipeline), the claim validator and the schema's columns. These
 * tests keep the three in step.
 */

describe("registry", () => {
  test("covers exactly the claimable fields listed in lib/vocab.ts", () => {
    expect(() => assertRegistryMatchesVocab()).not.toThrow()
  })

  test("every plain (undotted) field's validator is the table column's validator", () => {
    const tables = {
      organisations: ORGANISATION_SPECS,
      events: EVENT_SPECS,
      teams: TEAM_SPECS,
      sessions: SESSION_SPECS,
      venues: VENUE_SPECS,
    } as const
    for (const [table, specs] of Object.entries(tables)) {
      const columns = (
        schema.tables[table as keyof typeof tables].validator as unknown as {
          fields: Record<string, { json: unknown; isOptional: string }>
        }
      ).fields
      for (const [field, spec] of Object.entries(specs)) {
        if (field.includes(".")) continue
        const column = columns[field]
        expect(column, `${table}.${field} is not a column`).toBeDefined()
        const columnJson = { ...(column.json as object), optional: undefined }
        const specJson = {
          ...(spec.validator as unknown as { json: object }).json,
          optional: undefined,
        }
        expect(columnJson, `${table}.${field}`).toEqual(specJson)
      }
    }
  })

  test("dotted sub-fields live inside their object column", () => {
    const sport = (
      schema.tables.organisations.validator as unknown as {
        fields: { sport: { json: { value: { value: Record<string, unknown> } } } }
      }
    ).fields.sport
    for (const field of Object.keys(ORGANISATION_SPECS).filter((f) => f.startsWith("sport."))) {
      expect(JSON.stringify(sport.json)).toContain(`"${field.slice("sport.".length)}"`)
    }
  })
})

describe("checkValue", () => {
  const shape = v.object({
    platform: v.union(v.literal("instagram"), v.literal("x")),
    url: v.string(),
    handle: v.optional(v.string()),
    tags: v.array(v.string()),
    counts: v.record(v.string(), v.number()),
  })
  const ok = { platform: "x", url: "https://x.com/a", tags: [], counts: { a: 1 } }

  test("accepts a conforming value, with optional fields absent", () => {
    expect(checkValue(shape, ok)).toBeNull()
  })

  test("names the path of the first problem", () => {
    expect(checkValue(shape, { ...ok, platform: "myspace" })).toMatch(/value\.platform/)
    expect(checkValue(shape, { ...ok, tags: ["a", 2] })).toMatch(/value\.tags\[1\]/)
    expect(checkValue(shape, { ...ok, counts: { a: "1" } })).toMatch(/value\.counts\.a/)
    expect(checkValue(shape, { ...ok, extra: 1 })).toMatch(/unexpected field/)
    expect(checkValue(shape, { platform: "x" })).toMatch(/required/)
    expect(checkValue(v.number(), Number.NaN)).toMatch(/finite/)
    expect(checkValue(shape, null)).toMatch(/expected an object/)
  })
})

describe("field checks", () => {
  const check = (spec: { check?: (value: unknown) => string | null }, value: unknown) =>
    spec.check?.(value) ?? null

  test("URLs must be http(s)", () => {
    expect(check(ORGANISATION_SPECS.website, "https://cugs.org")).toBeNull()
    expect(check(ORGANISATION_SPECS.website, "javascript:alert(1)")).not.toBeNull()
    expect(check(ORGANISATION_SPECS.website, "ftp://cugs.org")).not.toBeNull()
    expect(
      check(ORGANISATION_SPECS.socials, [{ platform: "x", url: "data:text/html,hi" }]),
    ).not.toBeNull()
    expect(isHttpUrl("https://a.b/c?d=e")).toBe(true)
  })

  test("emails, keys, times and ranges", () => {
    expect(check(ORGANISATION_SPECS.email, "a@b.org")).toBeNull()
    expect(check(ORGANISATION_SPECS.email, "not an email")).not.toBeNull()
    expect(check(ORGANISATION_SPECS.collegeKeys, ["org-trinity-college"])).toBeNull()
    expect(check(ORGANISATION_SPECS.collegeKeys, ["Trinity"])).not.toBeNull()
    expect(check(SESSION_SPECS.startTime, "19:30")).toBeNull()
    expect(check(SESSION_SPECS.startTime, "7.30pm")).not.toBeNull()
    expect(check(SESSION_SPECS.dayOfWeek, 7)).not.toBeNull()
    expect(check(VENUE_SPECS.lat, 52.2)).toBeNull()
    expect(check(VENUE_SPECS.lat, 152.2)).not.toBeNull()
    expect(check(EVENT_SPECS.startsAt, 1)).not.toBeNull()
    expect(check(ORGANISATION_SPECS.shortDescription, "x".repeat(201))).not.toBeNull()
    expect(check(ORGANISATION_SPECS.tags, ["film-nights"])).toBeNull()
    expect(check(ORGANISATION_SPECS.tags, ["Film Nights"])).not.toBeNull()
  })

  test("chat invite links are never stored", () => {
    expect(
      check(ORGANISATION_SPECS.chatChannels, [
        { platform: "whatsapp", howToJoin: "Ask on Instagram" },
      ]),
    ).toBeNull()
    expect(
      check(ORGANISATION_SPECS.chatChannels, [
        { platform: "whatsapp", howToJoin: "https://chat.whatsapp.com/AbC" },
      ]),
    ).toMatch(/never stored/)
    expect(
      check(ORGANISATION_SPECS.chatChannels, [{ platform: "discord", howToJoin: "discord.gg/x" }]),
    ).toMatch(/never stored/)
  })

  test("an event's sourceUrl may be an internal URI (mailing-list events)", () => {
    expect(check(EVENT_SPECS.sourceUrl, "inbound:<abc@lists.cam.ac.uk>")).toBeNull()
    expect(check(EVENT_SPECS.sourceUrl, "no scheme")).not.toBeNull()
  })
})

describe("URL helpers", () => {
  test("normaliseUrl and hostOf", () => {
    expect(normaliseUrl("HTTPS://WWW.Instagram.com/cugs/")).toBe("instagram.com/cugs")
    expect(normaliseUrl("http://instagram.com/cugs?hl=en#top")).toBe("instagram.com/cugs?hl=en")
    expect(hostOf("https://www.cambridgesu.co.uk/organisation/1/")).toBe("cambridgesu.co.uk")
    expect(hostOf("inbound:abc")).toBe("inbound:abc")
  })
})
