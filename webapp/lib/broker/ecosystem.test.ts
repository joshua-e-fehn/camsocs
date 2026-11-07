import { describe, expect, test } from "bun:test"
import {
  buildEcosystem,
  campusId,
  DEFAULT_LAYERS,
  ECOSYSTEM_LAYERS,
  type EcosystemEvent,
  type EcosystemInput,
  type EcosystemOrg,
  type EcosystemRelationship,
  limitView,
  MAX_NODES,
  nodeId,
} from "./ecosystem"

/**
 * The ecosystem map's aggregation (lib/broker/ecosystem.ts). Every
 * organisation, person and event here is invented.
 */

const org = (key: string, extra: Partial<EcosystemOrg> = {}): EcosystemOrg => ({
  key,
  slug: key.replace(/^org-/, ""),
  name: `Invented ${key.replace(/^org-/, "")}`,
  isCounterpart: false,
  categories: ["hobbies_games"],
  audiences: [],
  ...extra,
})

const ORGS = new Map(
  [
    org("org-chess"),
    org("org-go"),
    org("org-quiz"),
    org("org-bank", { isCounterpart: true, orgType: "company", categories: [] }),
    org("org-faith", { categories: ["faith"] }),
    org("org-pride", { audiences: ["lgbtq"] }),
    org("org-hidden", { hidden: true }),
    org("org-gone"),
  ].map((o) => [o.key, o]),
)

const relationship = (
  key: string,
  fromKey: string,
  toKey: string,
  type: string,
  evidence: EcosystemRelationship["evidence"] = [{ sourceUrl: "https://example.org/a" }],
  visibility: "public" | "internal" = "internal",
): EcosystemRelationship => ({
  key,
  fromKey,
  toKey,
  type,
  visibility,
  confidence: 0.8,
  evidence,
  lastSeenAt: 1_000,
})

const event = (key: string, extra: Partial<EcosystemEvent> = {}): EcosystemEvent => ({
  key,
  startsAt: Date.UTC(2026, 10, 1),
  academicYear: "2026-27",
  visibility: "public",
  source: "ics",
  sourceUrl: `https://example.org/${key}`,
  organisers: [
    { orgKey: "org-chess", role: "organiser" },
    { orgKey: "org-go", role: "co_host" },
  ],
  ...extra,
})

function base(extra: Partial<EcosystemInput> = {}): EcosystemInput {
  return {
    campus: "cam",
    layers: ECOSYSTEM_LAYERS,
    orgs: ORGS,
    suppressedOrgs: new Set(["org-gone"]),
    ...extra,
  }
}

describe("campusId and node ids", () => {
  test("defaults to cam, keeps a well-formed id, refuses anything else", () => {
    expect(campusId(undefined)).toBe("cam")
    expect(campusId("")).toBe("cam")
    expect(campusId("zz")).toBe("zz")
    expect(() => campusId("Cam")).toThrow("Not a campus id")
    expect(() => campusId("ox-prod")).toThrow("Not a campus id")
    expect(nodeId("cam", "org-chess")).toBe("cam:org-chess")
  })

  test("every node and edge end is campus:key", () => {
    const map = buildEcosystem(
      base({
        campus: "zz",
        relationships: [relationship("rel-1", "org-bank", "org-chess", "sponsors")],
        events: [event("evt-1")],
      }),
    )
    expect(map.campus).toBe("zz")
    expect(map.nodes.map((n) => n.id)).toEqual(["zz:org-bank", "zz:org-chess", "zz:org-go"])
    for (const node of map.nodes) expect(node.id).toBe(`zz:${node.key}`)
    for (const edge of map.edges) {
      expect(edge.from.startsWith("zz:org-")).toBe(true)
      expect(edge.to.startsWith("zz:org-")).toBe(true)
    }
  })
})

describe("layers", () => {
  test("the default is the relationship graph alone, as before", () => {
    expect(DEFAULT_LAYERS).toEqual(["relationships"])
    const map = buildEcosystem(
      base({
        layers: DEFAULT_LAYERS,
        relationships: [relationship("rel-1", "org-bank", "org-chess", "sponsors")],
        events: [event("evt-1")],
        profiles: [{ orgKey: "org-quiz", pastSponsorKeys: ["org-bank"] }],
      }),
    )
    expect(map.edges.map((e) => [e.layer, e.type])).toEqual([["relationships", "sponsors"]])
  })

  test("the relationships layer narrows to the chosen types", () => {
    const map = buildEcosystem(
      base({
        layers: ["relationships"],
        types: ["sister_of"],
        relationships: [
          relationship("rel-1", "org-bank", "org-chess", "sponsors"),
          relationship("rel-2", "org-chess", "org-go", "sister_of"),
        ],
      }),
    )
    expect(map.edges.map((e) => e.type)).toEqual(["sister_of"])
  })

  test("cohosting counts hosted events org↔org per academic year", () => {
    const map = buildEcosystem(
      base({
        layers: ["cohosting"],
        events: [
          event("evt-1", { academicYear: "2025-26", startsAt: Date.UTC(2025, 10, 1) }),
          event("evt-2"),
          event("evt-3"),
          // A sponsor credits the hosts, not the other way round.
          event("evt-4", {
            organisers: [
              { orgKey: "org-quiz", role: "organiser" },
              { orgKey: "org-bank", role: "sponsor" },
            ],
          }),
          // Organisers alone are no co-hosting.
          event("evt-5", {
            organisers: [
              { orgKey: "org-chess", role: "organiser" },
              { orgKey: "org-quiz", role: "organiser" },
            ],
          }),
        ],
      }),
    )
    const pair = map.edges.find((e) => e.type === "co_host")
    expect(pair).toMatchObject({
      from: "cam:org-chess",
      to: "cam:org-go",
      layer: "cohosting",
      weight: 3,
      years: [
        { academicYear: "2025-26", count: 1 },
        { academicYear: "2026-27", count: 2 },
      ],
    })
    expect(map.edges.find((e) => e.type === "sponsor")).toMatchObject({
      from: "cam:org-bank",
      to: "cam:org-quiz",
      weight: 1,
    })
    expect(map.edges).toHaveLength(2)
  })

  test("cohosting skips events taken part in, cancelled, superseded or members-only", () => {
    const map = buildEcosystem(
      base({
        layers: ["cohosting"],
        events: [
          event("evt-1", { hosting: "takes_part" }),
          event("evt-2", { cancelled: true }),
          event("evt-3", { supersededBy: "evt-9" }),
          event("evt-4", { visibility: "members_only" }),
        ],
      }),
    )
    expect(map.edges).toEqual([])
    expect(map.nodes).toEqual([])
  })

  test("cohosting counts only the window's events, whatever else was read", () => {
    // evt-old was read only because a relationship sighting names it.
    const input = base({
      relationships: [
        relationship("rel-1", "org-chess", "org-go", "co_hosted", [
          { sourceUrl: "https://example.org/old", eventKey: "evt-old" },
        ]),
      ],
      events: [
        event("evt-old", { academicYear: "2020-21", startsAt: Date.UTC(2020, 10, 1) }),
        event("evt-new"),
      ],
      cohostEventKeys: new Set(["evt-new"]),
    })
    const cohosting = (layers: EcosystemInput["layers"]) =>
      buildEcosystem({ ...input, layers }).edges.filter((e) => e.layer === "cohosting")
    const alone = cohosting(["cohosting"])
    expect(alone).toEqual([
      expect.objectContaining({
        type: "co_host",
        weight: 1,
        years: [{ academicYear: "2026-27", count: 1 }],
      }),
    ])
    expect(cohosting(["cohosting", "relationships"])).toEqual(alone)
    expect(cohosting(["cohosting", "sponsors"])).toEqual(alone)
    expect(cohosting(ECOSYSTEM_LAYERS)).toEqual(alone)
    // The sighting itself still counts: its event was read and is no talk.
    expect(buildEcosystem({ ...input, layers: ["relationships"] }).edges).toHaveLength(1)
  })

  test("sponsors joins the broker's past sponsors and sponsor relationships", () => {
    const map = buildEcosystem(
      base({
        layers: ["sponsors"],
        profiles: [{ orgKey: "org-quiz", pastSponsorKeys: ["org-bank", "org-bank"] }],
        relationships: [
          relationship("rel-1", "org-bank", "org-chess", "sponsors", undefined, "public"),
          relationship("rel-2", "org-chess", "org-go", "sister_of"),
        ],
      }),
    )
    expect(map.edges.map((e) => [e.type, e.from, e.to, e.visibility])).toEqual([
      ["past_sponsor", "cam:org-bank", "cam:org-quiz", "internal"],
      ["sponsors", "cam:org-bank", "cam:org-chess", "public"],
    ])
  })

  test("outreach: introductions are edges, interactions a count on the organisation", () => {
    const map = buildEcosystem(
      base({
        layers: ["outreach"],
        people: [{ key: "per-anna", orgKey: "org-go", archived: false }],
        introductions: [
          {
            key: "intro-1",
            partyA: { orgKey: "org-bank" },
            partyB: { personKey: "per-anna" },
            date: 10,
            status: "idea",
          },
          {
            key: "intro-2",
            partyA: { orgKey: "org-go" },
            partyB: { orgKey: "org-bank" },
            date: 20,
            status: "sent",
          },
        ],
        interactions: [
          { orgKey: "org-quiz", date: 5 },
          { personKey: "per-anna", date: 7 },
          { orgKey: "org-quiz", date: 9 },
        ],
      }),
    )
    expect(map.edges).toEqual([
      {
        id: "cam:outreach:introduction:org-bank|org-go",
        from: "cam:org-bank",
        to: "cam:org-go",
        layer: "outreach",
        type: "introduction",
        visibility: "internal",
        weight: 2,
        lastSeenAt: 20,
        status: "sent",
        years: [],
      },
    ])
    const quiz = map.nodes.find((n) => n.key === "org-quiz")
    expect(quiz).toMatchObject({ interactions: 2, lastInteractionAt: 9, degree: 0 })
    expect(map.nodes.find((n) => n.key === "org-go")).toMatchObject({ interactions: 1 })
  })
})

describe("privacy", () => {
  test("people are only a count: no person key or name ever reaches the output", () => {
    const map = buildEcosystem(
      base({
        relationships: [relationship("rel-1", "org-faith", "org-pride", "partner_of")],
        events: [
          event("evt-1", {
            organisers: [
              { orgKey: "org-faith", role: "organiser" },
              { orgKey: "org-pride", role: "co_host" },
            ],
          }),
        ],
        people: [
          { key: "per-anna-example", orgKey: "org-faith", archived: false },
          { key: "per-ben-example", orgKey: "org-faith", archived: false },
          { key: "per-old", orgKey: "org-faith", archived: true },
          { key: "per-objected", orgKey: "org-pride", archived: false },
        ],
        suppressedPeople: new Set(["per-objected"]),
        interactions: [{ personKey: "per-anna-example", date: 3 }],
        introductions: [
          {
            key: "intro-1",
            partyA: { personKey: "per-anna-example" },
            partyB: { orgKey: "org-chess" },
            date: 4,
            status: "idea",
          },
        ],
      }),
    )
    const text = JSON.stringify(map)
    expect(text).not.toContain("per-")
    expect(text).not.toContain("example")
    expect(map.nodes.every((n) => n.key.startsWith("org-"))).toBe(true)
    const faith = map.nodes.find((n) => n.key === "org-faith")
    expect(faith).toMatchObject({ sensitive: true, people: 2, interactions: 1 })
    const pride = map.nodes.find((n) => n.key === "org-pride")
    expect(pride).toMatchObject({ sensitive: true, people: 0 })
    expect(map.nodes.find((n) => n.key === "org-chess")?.sensitive).toBe(false)
  })

  test("hidden and suppressed listings stay out of every layer but the default", () => {
    const input = base({
      relationships: [
        relationship("rel-1", "org-hidden", "org-chess", "sponsors"),
        relationship("rel-2", "org-gone", "org-go", "sponsors"),
      ],
      events: [
        event("evt-1", {
          organisers: [
            { orgKey: "org-chess", role: "organiser" },
            { orgKey: "org-hidden", role: "co_host" },
            { orgKey: "org-gone", role: "co_host" },
          ],
        }),
      ],
      profiles: [{ orgKey: "org-quiz", pastSponsorKeys: ["org-hidden", "org-gone"] }],
      interactions: [
        { orgKey: "org-hidden", date: 1 },
        { orgKey: "org-gone", date: 1 },
      ],
      introductions: [
        {
          key: "intro-1",
          partyA: { orgKey: "org-gone" },
          partyB: { orgKey: "org-chess" },
          date: 1,
          status: "idea",
        },
      ],
    })
    const others = buildEcosystem({ ...input, layers: ["cohosting", "sponsors", "outreach"] })
    expect(others.edges).toEqual([])
    expect(others.nodes).toEqual([])

    // The default layer shows the broker what it always did, flagged.
    const all = buildEcosystem({ ...input, layers: ECOSYSTEM_LAYERS })
    expect(all.edges.every((e) => e.layer === "relationships")).toBe(true)
    expect(all.nodes.filter((n) => n.hidden).map((n) => n.key)).toEqual(["org-gone", "org-hidden"])
  })

  test("an unknown organisation never enters a non-default layer", () => {
    const map = buildEcosystem(
      base({
        layers: ["cohosting"],
        events: [
          event("evt-1", {
            organisers: [
              { orgKey: "org-chess", role: "organiser" },
              { orgKey: "org-unknown", role: "co_host" },
            ],
          }),
        ],
      }),
    )
    expect(map.edges).toEqual([])
  })
})

describe("the talks boundary", () => {
  test("a talks.cam sighting does not count; an edge with nothing else is dropped", () => {
    const map = buildEcosystem(
      base({
        layers: ["relationships", "sponsors"],
        relationships: [
          relationship("rel-1", "org-chess", "org-go", "co_hosted", [
            { sourceUrl: "https://talks.cam.ac.uk/talk/index/1" },
          ]),
          relationship("rel-2", "org-bank", "org-chess", "sponsors", [
            { sourceUrl: "https://www.talks.cam.ac.uk/show/index/2" },
            { sourceUrl: "https://example.org/sponsors" },
          ]),
          relationship("rel-3", "org-bank", "org-quiz", "sponsors", [
            { sourceUrl: "https://example.org/e", eventKey: "evt-talk" },
          ]),
        ],
        events: [
          event("evt-talk", {
            source: "talks_cam",
            sourceUrl: "https://talks.cam.ac.uk/talk/index/3",
            organisers: [
              { orgKey: "org-bank", role: "sponsor" },
              { orgKey: "org-quiz", role: "organiser" },
            ],
          }),
        ],
      }),
    )
    expect(map.edges.map((e) => [e.layer, e.type, e.from, e.to, e.weight])).toEqual([
      ["relationships", "sponsors", "cam:org-bank", "cam:org-chess", 1],
      ["sponsors", "sponsors", "cam:org-bank", "cam:org-chess", 1],
    ])
  })

  test("a sighting naming an event that was not read does not count (fails closed)", () => {
    const map = buildEcosystem(
      base({
        layers: ["relationships", "sponsors"],
        relationships: [
          // Over the server's read limit: cannot be cleared of talks.cam.
          relationship("rel-1", "org-bank", "org-chess", "sponsors", [
            { sourceUrl: "https://example.org/e", eventKey: "evt-unread" },
          ]),
          // Looked up, but no such event: nothing to judge, the URL decides.
          relationship("rel-2", "org-bank", "org-quiz", "sponsors", [
            { sourceUrl: "https://example.org/f", eventKey: "evt-missing" },
          ]),
          // No event named: the URL decides.
          relationship("rel-3", "org-chess", "org-go", "sister_of"),
        ],
        events: [],
        judgedEventKeys: new Set(["evt-missing"]),
      }),
    )
    expect(map.edges.map((e) => [e.layer, e.type, e.from, e.to])).toEqual([
      ["relationships", "sponsors", "cam:org-bank", "cam:org-quiz"],
      ["relationships", "sister_of", "cam:org-chess", "cam:org-go"],
      ["sponsors", "sponsors", "cam:org-bank", "cam:org-quiz"],
    ])
  })

  test("a talks.cam-derived event is no co-hosting, however it is linked", () => {
    const map = buildEcosystem(
      base({
        layers: ["cohosting"],
        events: [
          event("evt-1", { source: "talks_cam" }),
          event("evt-2", { externalUrl: "https://talks.cam.ac.uk/talk/index/4" }),
          event("evt-3", { description: "See talks.cam.ac.uk/talk/index/5" }),
          event("evt-4", {
            source: "camdram",
            meta: { description: { sourceUrl: "https://talks.cam.ac.uk/talk/index/6" } },
          }),
        ],
      }),
    )
    expect(map.edges).toEqual([])
  })
})

describe("limitView", () => {
  test("keeps the best-connected MAX_NODES and only edges between them", () => {
    const nodes = Array.from({ length: MAX_NODES + 10 }, (_, i) => ({
      id: `cam:org-${String(i).padStart(3, "0")}`,
      key: `org-${i}`,
      name: `Org ${String(i).padStart(3, "0")}`,
      isCounterpart: false,
      hidden: false,
      sensitive: false,
      people: 0,
      interactions: 0,
      degree: 0,
    }))
    // A star around node 0, then a chain.
    const edges = nodes.slice(1).map((node, i) => ({
      id: `e${i}`,
      from: i < 20 ? nodes[0].id : nodes[i].id,
      to: node.id,
      layer: "relationships" as const,
      type: "sister_of",
      visibility: (i % 2 ? "public" : "internal") as "public" | "internal",
      weight: 1,
      years: [],
    }))
    const view = limitView({ nodes, edges })
    expect(view.nodes).toHaveLength(MAX_NODES)
    expect(view.dropped).toBe(10)
    expect(view.nodes[0].id).toBe(nodes[0].id)
    const kept = new Set(view.nodes.map((n) => n.id))
    expect(view.edges.every((e) => kept.has(e.from) && kept.has(e.to))).toBe(true)

    const publicOnly = limitView({ nodes, edges }, { visibility: "public" })
    expect(publicOnly.edges.every((e) => e.visibility === "public")).toBe(true)
  })

  test("an organisation with interactions but no edge is drawn, except on the public view", () => {
    const node = {
      id: "cam:org-quiz",
      key: "org-quiz",
      name: "Invented quiz",
      isCounterpart: false,
      hidden: false,
      sensitive: false,
      people: 0,
      interactions: 2,
      degree: 0,
    }
    expect(limitView({ nodes: [node], edges: [] }).nodes).toHaveLength(1)
    expect(limitView({ nodes: [node], edges: [] }, { visibility: "public" }).nodes).toEqual([])
  })
})
