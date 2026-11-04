import { describe, expect, test } from "bun:test"
import { bestRoleAddress, outreachAddresses } from "./brokerRows"

/**
 * The outreach address (the Art 14 notice goes to it): a role address only,
 * never a personal CRSid address, a lists.cam.ac.uk list (every member would
 * get it) or a webmail address (often one officer's own).
 */

type Org = Parameters<typeof bestRoleAddress>[0]
const org = (email: string | undefined, roleEmails: Org["roleEmails"] = []): Org => ({
  email,
  roleEmails,
})

describe("bestRoleAddress", () => {
  test("prefers the secretary, then the president, and gives the address's kind", () => {
    expect(
      bestRoleAddress(
        org("info@cuchess.org", [
          { role: "president", email: "president@cuchess.org" },
          { role: "secretary", email: "secretary@cuchess.org" },
        ]),
      ),
    ).toEqual({ email: "secretary@cuchess.org", role: "secretary", kind: "role_own_domain" })
  })

  test("never picks a lists.cam.ac.uk list, even as the only secretary address", () => {
    const best = bestRoleAddress(
      org("soc-chess@lists.cam.ac.uk", [
        { role: "secretary", email: "soc-chess-committee@lists.cam.ac.uk" },
        { role: "president", email: "president@cuchess.org" },
      ]),
    )
    expect(best).toEqual({
      email: "president@cuchess.org",
      role: "president",
      kind: "role_own_domain",
    })
    expect(bestRoleAddress(org("soc-chess@lists.cam.ac.uk"))).toBeUndefined()
  })

  test("never picks a webmail address, role-shaped or not", () => {
    expect(
      bestRoleAddress(
        org("cuchessclub@gmail.com", [{ role: "secretary", email: "chess.sec@outlook.com" }]),
      ),
    ).toBeUndefined()
    expect(
      bestRoleAddress(
        org("cuchessclub@gmail.com", [{ role: "treasurer", email: "treasurer@cuchess.org" }]),
      ),
    ).toEqual({ email: "treasurer@cuchess.org", role: "treasurer", kind: "role_own_domain" })
  })

  test("never picks a personal CRSid address", () => {
    expect(
      bestRoleAddress(org("ab123@cam.ac.uk", [{ role: "president", email: "xy99@cam.ac.uk" }])),
    ).toBeUndefined()
  })

  test("falls back to the general address when it is a role address", () => {
    expect(bestRoleAddress(org("chess@srcf.net"))).toEqual({
      email: "chess@srcf.net",
      role: "general",
      kind: "srcf",
    })
    expect(bestRoleAddress(org("president@chess.cambridgesu.co.uk"))?.kind).toBe("cambridgesu")
  })
})

describe("outreachAddresses (where the notice goes after a bounce)", () => {
  test("every usable address once, best first, the general one last", () => {
    expect(
      outreachAddresses(
        org("Info@CUChess.org", [
          { role: "treasurer", email: "treasurer@cuchess.org" },
          { role: "president", email: "president@cuchess.org" },
          { role: "secretary", email: "secretary@cuchess.org" },
          { role: "other", email: "info@cuchess.org" },
          { role: "welfare", email: "ab123@cam.ac.uk" },
          { role: "events", email: "soc-chess@lists.cam.ac.uk" },
          { role: "publicity", email: "chess.publicity@gmail.com" },
        ]),
      ).map((address) => `${address.role}:${address.email}`),
    ).toEqual([
      "secretary:secretary@cuchess.org",
      "president:president@cuchess.org",
      "other:info@cuchess.org",
      "treasurer:treasurer@cuchess.org",
    ])
  })

  test("the first is bestRoleAddress", () => {
    const sample = org("chess@srcf.net", [{ role: "captain", email: "captain@cuchess.org" }])
    expect(bestRoleAddress(sample)).toEqual(outreachAddresses(sample)[0])
    expect(outreachAddresses(org("cuchessclub@gmail.com"))).toEqual([])
  })
})
