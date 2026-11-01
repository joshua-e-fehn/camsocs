import { describe, expect, test } from "bun:test"
import { api, internal } from "./_generated/api"
import type { ClaimInput } from "./ingest/claims"
import { newTest } from "./lib/harness.testing"

/** `orgs.categoryExamples`: the home page's "three societies per category",
 * and `orgs.home`, which reads the cards once for it and the facets. */

const NOW = Date.now()

function claim(entityKey: string, field: string, value: unknown): ClaimInput {
  return {
    entityType: "organisation",
    entityKey,
    field,
    value,
    evidence: "primary",
    method: "parser",
    extractor: "test",
    sourceKey: "src-site",
    sourceUrl: "https://example.org/",
    sourceType: "society_website",
    retrievedAt: NOW - 60_000,
  }
}

function society(key: string, name: string, categories: string[], description?: string) {
  return [
    claim(key, "name", name),
    claim(key, "orgType", "society"),
    claim(key, "level", "university"),
    claim(key, "categories", categories),
    ...(description ? [claim(key, "shortDescription", description)] : []),
  ]
}

describe("orgs.categoryExamples", () => {
  test("at most three listed societies per category, described ones first, never colleges", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ...society("org-a", "Alpha Music Society", ["music"]),
        ...society("org-b", "Bravo Band", ["music"], "Brass on Thursdays"),
        ...society("org-c", "Charlie Choir", ["music", "faith"]),
        ...society("org-d", "Delta Drummers", ["music"]),
        ...society("org-e", "Echo Chess", ["hobbies_games"]),
        claim("org-trinity", "name", "Trinity College"),
        claim("org-trinity", "orgType", "college"),
        // A college with a category must still not stand in for a society.
        claim("org-trinity", "categories", ["faith"]),
      ],
    })
    const examples = await t.query(api.orgs.categoryExamples, {})
    expect(examples.music).toHaveLength(3)
    expect(examples.music[0]).toEqual({ key: "org-b", slug: "b", name: "Bravo Band" })
    expect(examples.faith.map((org) => org.name)).toEqual(["Charlie Choir"])
    expect(examples.hobbies_games.map((org) => org.slug)).toEqual(["e"])
    const named = Object.values(examples)
      .flat()
      .map((org) => org.name)
    expect(named).not.toContain("Trinity College")
    // The same picks every time: the order is a function of the keys.
    expect(await t.query(api.orgs.categoryExamples, {})).toEqual(examples)
  })
})

describe("orgs.home", () => {
  test("equals the unfiltered facets and the category examples, from one read", async () => {
    const t = newTest()
    await t.mutation(internal.ingest.claims.ingest, {
      claims: [
        ...society("org-a", "Alpha Music Society", ["music"]),
        ...society("org-b", "Bravo Band", ["music"], "Brass on Thursdays"),
        ...society("org-e", "Echo Chess", ["hobbies_games"]),
        claim("org-trinity", "name", "Trinity College"),
        claim("org-trinity", "orgType", "college"),
      ],
    })
    const home = await t.query(api.orgs.home, {})
    expect(home.facets).toEqual(await t.query(api.orgs.facets, {}))
    expect(home.categoryExamples).toEqual(await t.query(api.orgs.categoryExamples, {}))
    expect(home.facets.total).toBe(4)
    expect(home.facets.categories.music).toBe(2)
    expect(home.facets.truncated).toBe(false)
  })

  test("an empty directory: zero counts and no examples", async () => {
    const t = newTest()
    const home = await t.query(api.orgs.home, {})
    expect(home.facets.total).toBe(0)
    expect(home.categoryExamples).toEqual({})
  })
})
