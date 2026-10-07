import { describe, expect, test } from "bun:test"
import { makeFunctionReference } from "convex/server"
import { newTest, signedInAs, type TestConvex, withEnv } from "../lib/harness.testing"

/**
 * The privacy boundary, enumerated: **every** function exported from any
 * module in convex/broker/ refuses a caller who is not a verified broker.
 *
 * The modules are read from disk, so a new file or a new export is covered
 * without touching this test (and a module missing from the convex-test
 * harness fails here too). Each function is called with arguments generated
 * from its own validator, so the call passes validation and the refusal must
 * come from `requireBrokerUser` — asserted by its exact message.
 */

const BROKER = "broker@example.com"
const BROKER_DIR = new URL("./", import.meta.url).pathname

type ValidatorJson = {
  type: string
  value?: unknown
}

/** A value its validator accepts — the simplest one. */
function sample(json: ValidatorJson): unknown {
  switch (json.type) {
    case "string":
      return "x"
    case "number":
      return 0
    case "bigint":
      return BigInt(0)
    case "boolean":
      return false
    case "null":
    case "any":
      return null
    case "literal":
      return json.value
    case "array":
      return []
    case "record":
      return {}
    case "bytes":
      return new ArrayBuffer(0)
    case "union":
      return sample((json.value as ValidatorJson[])[0])
    case "object":
      return Object.fromEntries(
        Object.entries(
          json.value as Record<string, { fieldType: ValidatorJson; optional: boolean }>,
        )
          .filter(([, field]) => !field.optional)
          .map(([name, field]) => [name, sample(field.fieldType)]),
      )
    default:
      throw new Error(`No sample for validator type ${json.type}`)
  }
}

type Registered = {
  isQuery?: boolean
  isMutation?: boolean
  isPublic?: boolean
  exportArgs: () => string
}

type BrokerFunction = {
  name: string
  kind: "query" | "mutation" | "action"
  isPublic: boolean
  args: unknown
}

async function brokerFunctions(): Promise<BrokerFunction[]> {
  // Function modules only: `*.test.ts` / `*.testing.ts` carry a second dot.
  const files = [...new Bun.Glob("*.ts").scanSync({ cwd: BROKER_DIR })]
    .filter((file) => file.split(".").length === 2)
    .sort()
  const out: BrokerFunction[] = []
  for (const file of files) {
    const module = (await import(`./${file}`)) as Record<string, unknown>
    for (const [exportName, value] of Object.entries(module)) {
      // Registered Convex functions are callables carrying these markers.
      if (typeof value !== "function" || !("exportArgs" in value)) continue
      const fn = value as unknown as Registered
      out.push({
        name: `broker/${file.replace(/\.ts$/, "")}:${exportName}`,
        kind: fn.isQuery ? "query" : fn.isMutation ? "mutation" : "action",
        isPublic: fn.isPublic === true,
        args: sample(JSON.parse(fn.exportArgs()) as ValidatorJson),
      })
    }
  }
  return out
}

type Client = Pick<TestConvex, "query" | "mutation" | "action">

async function call(client: Client, fn: BrokerFunction) {
  if (fn.kind === "query") {
    return await client.query(makeFunctionReference<"query">(fn.name), fn.args as never)
  }
  if (fn.kind === "mutation") {
    return await client.mutation(makeFunctionReference<"mutation">(fn.name), fn.args as never)
  }
  return await client.action(makeFunctionReference<"action">(fn.name), fn.args as never)
}

/** Every function refuses `client` with requireBrokerUser's one message. */
async function expectAllRefused(client: Client) {
  for (const fn of await brokerFunctions()) {
    let outcome = "ALLOWED"
    try {
      await call(client, fn)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = message.includes("Not authorized") ? "Not authorized" : message
    }
    // A failure names the function and what happened instead.
    expect(`${fn.name}: ${outcome}`).toBe(`${fn.name}: Not authorized`)
  }
}

describe("convex/broker/* gating", () => {
  test("finds the broker functions (the test cannot pass vacuously)", async () => {
    const fns = await brokerFunctions()
    expect(fns.length).toBeGreaterThanOrEqual(25)
    // Internal functions do not belong here: nothing a cron or the pipeline
    // calls can pass requireBrokerUser.
    expect(fns.filter((fn) => !fn.isPublic).map((fn) => fn.name)).toEqual([])
  })

  test("every function refuses a signed-out caller", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      await expectAllRefused(newTest())
    })
  })

  test("every function refuses a signed-in caller who is not on BROKER_EMAILS", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      await expectAllRefused(await signedInAs(newTest(), "ab123@cam.ac.uk"))
    })
  })

  test("every function refuses the broker's address when it is unverified", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      await expectAllRefused(await signedInAs(newTest(), BROKER, { emailVerified: false }))
    })
  })

  test("every function refuses everyone when BROKER_EMAILS is unset", async () => {
    await withEnv({ BROKER_EMAILS: undefined }, async () => {
      await expectAllRefused(await signedInAs(newTest(), BROKER))
    })
  })
})
