import { describe, expect, test } from "bun:test"
import { api } from "../_generated/api"
import { newTest, signedInAs, withEnv } from "../lib/harness.testing"

/**
 * `requireBrokerUser`, exercised through the first broker function. Every
 * refusal path must throw the same message, so a caller cannot probe the list.
 */

const BROKER = "broker@example.com"

describe("broker.session.me (requireBrokerUser)", () => {
  test("refuses a signed-out caller", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      await expect(newTest().query(api.broker.session.me, {})).rejects.toThrow("Not authorized")
    })
  })

  test("admits a listed, verified address", async () => {
    await withEnv({ BROKER_EMAILS: ` Other@Example.com , ${BROKER.toUpperCase()} ` }, async () => {
      const client = await signedInAs(newTest(), BROKER, { name: "Broker" })
      expect(await client.query(api.broker.session.me, {})).toEqual({
        email: BROKER,
        name: "Broker",
      })
    })
  })

  test("refuses a signed-in address that is not on the list", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const client = await signedInAs(newTest(), "someone@example.com")
      await expect(client.query(api.broker.session.me, {})).rejects.toThrow("Not authorized")
    })
  })

  test("refuses everyone when BROKER_EMAILS is unset or empty", async () => {
    for (const value of [undefined, "", " , "]) {
      await withEnv({ BROKER_EMAILS: value }, async () => {
        const client = await signedInAs(newTest(), BROKER)
        await expect(client.query(api.broker.session.me, {})).rejects.toThrow("Not authorized")
      })
    }
  })

  test("refuses a listed address whose email is not verified", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const client = await signedInAs(newTest(), BROKER, { emailVerified: false })
      await expect(client.query(api.broker.session.me, {})).rejects.toThrow("Not authorized")
    })
  })
})

describe("auth.getBrokerAccess", () => {
  test("reports the caller's own state without throwing", async () => {
    await withEnv({ BROKER_EMAILS: BROKER }, async () => {
      const t = newTest()
      expect(await t.query(api.auth.getBrokerAccess, {})).toEqual({
        signedIn: false,
        isBroker: false,
      })
      const broker = await signedInAs(t, BROKER)
      expect(await broker.query(api.auth.getBrokerAccess, {})).toEqual({
        signedIn: true,
        isBroker: true,
      })
      const other = await signedInAs(t, "someone@example.com")
      expect(await other.query(api.auth.getBrokerAccess, {})).toEqual({
        signedIn: true,
        isBroker: false,
      })
    })
  })
})
