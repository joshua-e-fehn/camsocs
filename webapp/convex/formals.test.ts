import { describe, expect, test } from "bun:test"
import { api, components } from "./_generated/api"
import { newTest, signedInAs, type TestConvex, withEnv } from "./lib/harness.testing"

/**
 * The formal tracker (ENG-272): each member's own ticks, details and
 * profile; the leaderboard for verified members only. Invented accounts.
 */

const TRINITY = "org-trinity-college"
const GIRTON = "org-girton-college"
const KINGS = "org-kings-college"

async function as(t: TestConvex, email: string, emailVerified = true) {
  return (await signedInAs(t, email, { emailVerified })) as unknown as TestConvex
}

describe("formals.mine", () => {
  test("is null signed out, and never throws", async () => {
    const t = newTest()
    expect(await t.query(api.formals.mine, {})).toBeNull()
    expect(await t.query(api.formals.leaderboard, {})).toBeNull()
  })

  test("an empty tracker for a new member", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    expect(await me.query(api.formals.mine, {})).toEqual({
      entries: [],
      profile: null,
      canJoinLeaderboard: true,
    })
  })
})

describe("ticks and details", () => {
  test("a tick counts one formal; details keep the tick in step with visits", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    await me.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true })
    await me.mutation(api.formals.saveDetails, {
      collegeKey: GIRTON,
      visitedOn: "2026-10-20",
      visits: 3,
      notes: "  Long walk, worth it  ",
    })
    let mine = await me.query(api.formals.mine, {})
    expect(mine?.profile).toMatchObject({ colleges: 2, visits: 4, onLeaderboard: false })
    const girton = mine?.entries.find((e) => e.collegeKey === GIRTON)
    expect(girton).toMatchObject({ attended: true, visits: 3, notes: "Long walk, worth it" })

    // Ticking again keeps the count; unticking clears it but keeps the notes.
    await me.mutation(api.formals.setAttended, { collegeKey: GIRTON, attended: true })
    expect(
      (await me.query(api.formals.mine, {}))?.entries.find((e) => e.collegeKey === GIRTON)?.visits,
    ).toBe(3)
    await me.mutation(api.formals.setAttended, { collegeKey: GIRTON, attended: false })
    mine = await me.query(api.formals.mine, {})
    expect(mine?.entries.find((e) => e.collegeKey === GIRTON)).toMatchObject({
      attended: false,
      visits: 0,
      visitedOn: "2026-10-20",
      notes: "Long walk, worth it",
    })
    expect(mine?.profile).toMatchObject({ colleges: 1, visits: 1 })

    // Details with zero visits untick.
    await me.mutation(api.formals.saveDetails, {
      collegeKey: TRINITY,
      visitedOn: null,
      visits: 0,
      notes: "",
    })
    expect((await me.query(api.formals.mine, {}))?.profile).toMatchObject({ colleges: 0 })
  })

  test("refuses bad input and signed-out writes", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    await expect(
      t.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true }),
    ).rejects.toThrow(/Not authenticated/)
    await expect(
      me.mutation(api.formals.setAttended, { collegeKey: "org-hogwarts", attended: true }),
    ).rejects.toThrow(/31 Cambridge colleges/)
    const details = { collegeKey: TRINITY, visitedOn: null, visits: 1, notes: "" }
    await expect(
      me.mutation(api.formals.saveDetails, { ...details, visitedOn: "2999-01-01" }),
    ).rejects.toThrow(/future/)
    await expect(
      me.mutation(api.formals.saveDetails, { ...details, visitedOn: "2026-02-30" }),
    ).rejects.toThrow(/real day/)
    await expect(me.mutation(api.formals.saveDetails, { ...details, visits: 201 })).rejects.toThrow(
      /0 to 200/,
    )
    await expect(
      me.mutation(api.formals.saveDetails, { ...details, notes: "x".repeat(2001) }),
    ).rejects.toThrow(/2,000/)
    expect((await me.query(api.formals.mine, {}))?.entries).toEqual([])
  })

  test("members never see each other's rows", async () => {
    const t = newTest()
    const a = await as(t, "aa111@cam.ac.uk")
    const b = await as(t, "bb222@cam.ac.uk")
    await a.mutation(api.formals.saveDetails, {
      collegeKey: KINGS,
      visitedOn: null,
      visits: 1,
      notes: "secret",
    })
    expect((await b.query(api.formals.mine, {}))?.entries).toEqual([])
  })
})

describe("profile and leaderboard", () => {
  test("joining needs a name and a verified @cam.ac.uk address", async () => {
    const t = newTest()
    const outsider = await as(t, "visitor@example.com")
    const unverified = await as(t, "cc333@cam.ac.uk", false)
    const me = await as(t, "aa111@cam.ac.uk")
    const join = { displayName: "Formal Fiend", onLeaderboard: true, homeCollegeKey: null }
    await expect(outsider.mutation(api.formals.saveProfile, join)).rejects.toThrow(/verified/)
    await expect(unverified.mutation(api.formals.saveProfile, join)).rejects.toThrow(/verified/)
    await expect(
      me.mutation(api.formals.saveProfile, { ...join, displayName: null }),
    ).rejects.toThrow(/leaderboard name/)
    await expect(
      me.mutation(api.formals.saveProfile, { ...join, displayName: "aa111" }),
    ).rejects.toThrow(/CRSid/)
    await expect(
      me.mutation(api.formals.saveProfile, { ...join, homeCollegeKey: "nope" }),
    ).rejects.toThrow(/31 Cambridge colleges/)
    // Saving a name without joining is fine for anyone signed in.
    await outsider.mutation(api.formals.saveProfile, { ...join, onLeaderboard: false })
    expect((await outsider.query(api.formals.mine, {}))?.canJoinLeaderboard).toBe(false)
    expect(await outsider.query(api.formals.leaderboard, {})).toBeNull()
  })

  test("orders by colleges, then formals, then who got there first", async () => {
    const t = newTest()
    const a = await as(t, "aa111@cam.ac.uk")
    const b = await as(t, "bb222@cam.ac.uk")
    const c = await as(t, "cc333@cam.ac.uk")
    const hidden = await as(t, "dd444@cam.ac.uk")
    for (const [who, keys] of [
      [a, [TRINITY]],
      [b, [TRINITY, GIRTON]],
      [c, [TRINITY]],
      [hidden, [TRINITY, GIRTON, KINGS]],
    ] as const) {
      for (const collegeKey of keys) {
        await who.mutation(api.formals.setAttended, { collegeKey, attended: true })
      }
    }
    await c.mutation(api.formals.saveDetails, {
      collegeKey: TRINITY,
      visitedOn: null,
      visits: 2,
      notes: "",
    })
    await a.mutation(api.formals.saveProfile, {
      displayName: "Alpha",
      onLeaderboard: true,
      homeCollegeKey: KINGS,
    })
    await b.mutation(api.formals.saveProfile, {
      displayName: "Bravo",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    await c.mutation(api.formals.saveProfile, {
      displayName: "Charlie",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    await hidden.mutation(api.formals.saveProfile, {
      displayName: "Hidden",
      onLeaderboard: false,
      homeCollegeKey: null,
    })
    const board = await a.query(api.formals.leaderboard, {})
    expect(board).toEqual([
      { rank: 1, displayName: "Bravo", homeCollege: null, colleges: 2, visits: 2, isMe: false },
      { rank: 2, displayName: "Charlie", homeCollege: null, colleges: 1, visits: 2, isMe: false },
      { rank: 3, displayName: "Alpha", homeCollege: "King’s", colleges: 1, visits: 1, isMe: true },
    ])
  })

  test("equal colleges and formals: who got there first ranks higher", async () => {
    const t = newTest()
    const late = await as(t, "aa111@cam.ac.uk")
    const early = await as(t, "bb222@cam.ac.uk")
    // Late's profile row is created first, so insertion order cannot explain the result.
    await late.mutation(api.formals.saveProfile, {
      displayName: "Late",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    await early.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true })
    await early.mutation(api.formals.saveProfile, {
      displayName: "Early",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await late.mutation(api.formals.setAttended, { collegeKey: GIRTON, attended: true })
    const board = await late.query(api.formals.leaderboard, {})
    expect(board?.map((row) => row.displayName)).toEqual(["Early", "Late"])
  })

  test("saving a profile before any tick creates it with zero counts", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    await me.mutation(api.formals.saveProfile, {
      displayName: "Fresher",
      onLeaderboard: true,
      homeCollegeKey: GIRTON,
    })
    expect((await me.query(api.formals.mine, {}))?.profile).toEqual({
      displayName: "Fresher",
      onLeaderboard: true,
      homeCollegeKey: GIRTON,
      colleges: 0,
      visits: 0,
    })
    expect(await me.query(api.formals.leaderboard, {})).toEqual([
      {
        rank: 1,
        displayName: "Fresher",
        homeCollege: "Girton",
        colleges: 0,
        visits: 0,
        isMe: true,
      },
    ])
  })

  test("leaving the leaderboard hides the row and keeps the counts", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    await me.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true })
    await me.mutation(api.formals.setAttended, { collegeKey: GIRTON, attended: true })
    const join = { displayName: "Alpha", onLeaderboard: true, homeCollegeKey: null }
    await me.mutation(api.formals.saveProfile, join)
    expect(await me.query(api.formals.leaderboard, {})).toHaveLength(1)
    await me.mutation(api.formals.saveProfile, { ...join, onLeaderboard: false })
    expect(await me.query(api.formals.leaderboard, {})).toEqual([])
    expect((await me.query(api.formals.mine, {}))?.profile).toMatchObject({
      onLeaderboard: false,
      colleges: 2,
      visits: 2,
    })
  })

  test("a member who has since lost their verified address drops off", async () => {
    const t = newTest()
    const viewer = await as(t, "aa111@cam.ac.uk")
    const leaver = await as(t, "bb222@cam.ac.uk")
    await leaver.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true })
    await leaver.mutation(api.formals.saveProfile, {
      displayName: "Leaver",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    expect((await viewer.query(api.formals.leaderboard, {}))?.map((r) => r.displayName)).toEqual([
      "Leaver",
    ])
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        update: { email: "leaver@example.com" },
        where: [{ field: "email", value: "bb222@cam.ac.uk" }],
      },
    })
    expect(await viewer.query(api.formals.leaderboard, {})).toEqual([])
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: "user",
        update: { email: "bb222@cam.ac.uk", emailVerified: false },
        where: [{ field: "email", value: "leaver@example.com" }],
      },
    })
    expect(await viewer.query(api.formals.leaderboard, {})).toEqual([])
  })

  test("the broker may see the leaderboard", async () => {
    await withEnv({ BROKER_EMAILS: "broker@example.com" }, async () => {
      const t = newTest()
      const broker = await as(t, "broker@example.com")
      expect(await broker.query(api.formals.leaderboard, {})).toEqual([])
    })
  })

  test("erase removes every row and the profile", async () => {
    const t = newTest()
    const me = await as(t, "aa111@cam.ac.uk")
    await me.mutation(api.formals.setAttended, { collegeKey: TRINITY, attended: true })
    await me.mutation(api.formals.setAttended, { collegeKey: GIRTON, attended: true })
    await me.mutation(api.formals.saveProfile, {
      displayName: "Alpha",
      onLeaderboard: true,
      homeCollegeKey: null,
    })
    expect(await me.mutation(api.formals.eraseMine, {})).toEqual({ deleted: 3 })
    expect(await me.query(api.formals.mine, {})).toMatchObject({ entries: [], profile: null })
    expect(await me.query(api.formals.leaderboard, {})).toEqual([])
    await t.run(async (ctx) => {
      expect(await ctx.db.query("formalEntries").collect()).toEqual([])
      expect(await ctx.db.query("formalProfiles").collect()).toEqual([])
    })
  })
})
