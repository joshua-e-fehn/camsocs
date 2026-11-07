import { isTalksCamUrl, isTalksDerivedEvent, type TalksBoundaryRecord } from "../talks-boundary"
import { isSensitiveSociety } from "./sensitive"

/**
 * The ecosystem map of the broker's graph page (/dashboard/graph): which
 * organisations work with which, in four layers the broker can stack.
 *
 *  - `relationships` (the default, the page as it always was): every
 *    relationship edge, public and internal.
 *  - `cohosting`: events two organisations host together, from the
 *    `eventOrganisers` rows with a co-host or a sponsor. Hosted events only
 *    (not one a society only takes part in, decision D6), never a cancelled or
 *    superseded one; counted org↔org per academic year.
 *  - `sponsors`: the broker's record of past sponsors
 *    (`orgBrokerProfiles.pastSponsorKeys`) and `sponsors` relationships.
 *  - `outreach`: the broker's own work, introductions as edges and
 *    interactions as a count on each organisation.
 *
 * The rules this module enforces, whatever the layers:
 *  - a node's id is `${campus}:${key}` (decision D8: a later cross-campus
 *    view federates deployments by that id);
 *  - people are never nodes: an organisation carries only a count of the
 *    people held for it, and an introduction or interaction with a person
 *    counts for the person's organisation;
 *  - a sensitive society (Art 9, lib/broker/sensitive.ts) is flagged
 *    `sensitive` so the page names it with an icon and the word, and it never
 *    gets a node per person either;
 *  - hidden and suppressed organisations are left out of every layer but the
 *    default (which shows the broker what it always did);
 *  - nothing read from talks.cam counts (owner decision G1,
 *    lib/talks-boundary.ts): a relationship sighting on talks.cam or from a
 *    talks.cam-derived event (or from an event that was not read, so cannot
 *    be cleared), and a talks.cam-derived co-hosted event;
 *  - at most `MAX_NODES` organisations are drawn (`limitView`).
 *
 * Pure: no React and no server imports, so the Convex query
 * (convex/broker/graph.ts `ecosystem`) and the page share it.
 */

export const ECOSYSTEM_LAYERS = ["relationships", "cohosting", "sponsors", "outreach"] as const
export type EcosystemLayer = (typeof ECOSYSTEM_LAYERS)[number]

/** Today's page: the relationship graph alone. */
export const DEFAULT_LAYERS: readonly EcosystemLayer[] = ["relationships"]

export const LAYER_LABELS: Record<EcosystemLayer, string> = {
  relationships: "Relationships",
  cohosting: "Co-hosting",
  sponsors: "Sponsors",
  outreach: "Outreach",
}

/** More nodes than this stop being readable; the best-connected are kept. */
export const MAX_NODES = 250

/** The edge types of the layers other than `relationships` (which uses
 * `RELATIONSHIP_TYPES`). */
export const ECOSYSTEM_EDGE_TYPES = ["co_host", "sponsor", "past_sponsor", "introduction"] as const

export const ECOSYSTEM_EDGE_LABELS: Record<(typeof ECOSYSTEM_EDGE_TYPES)[number], string> = {
  co_host: "Co-hosted events",
  sponsor: "Sponsored an event",
  past_sponsor: "Past sponsor",
  introduction: "Introduction",
}

const CAMPUS_ID = /^[a-z]{2,8}$/

/**
 * The deployment's campus id (decision D8): `CAMSOCS_CAMPUS` as the Convex
 * env holds it, `cam` when unset. A value of the wrong shape throws rather
 * than minting ids nothing can federate.
 */
export function campusId(value: string | undefined): string {
  const id = value?.trim() || "cam"
  if (!CAMPUS_ID.test(id)) throw new Error(`Not a campus id: ${JSON.stringify(value)}`)
  return id
}

/** The node id of an organisation: `${campus}:${key}`. */
export function nodeId(campus: string, key: string): string {
  return `${campus}:${key}`
}

// --- inputs -----------------------------------------------------------------------------

/** An organisation as the map needs it: its card, or the full row of a hidden
 * one (which has no card). */
export type EcosystemOrg = {
  key: string
  slug?: string
  name: string
  orgType?: string
  isCounterpart: boolean
  categories: readonly string[]
  audiences: readonly string[]
  hidden?: boolean
}

export type EcosystemRelationship = {
  key: string
  fromKey: string
  toKey: string
  type: string
  visibility: "public" | "internal"
  confidence: number
  evidence: readonly { sourceUrl: string; eventKey?: string }[]
  lastSeenAt: number
}

export type EcosystemOrganiser = { orgKey: string; role: "organiser" | "co_host" | "sponsor" }

/** A stored event with at least one co-host or sponsor, every field the talks
 * boundary reads, and its academic year ("2026-27", from its start). */
export type EcosystemEvent = TalksBoundaryRecord & {
  key: string
  startsAt: number
  academicYear: string
  visibility: string
  hosting?: "hosts" | "takes_part"
  cancelled?: boolean
  supersededBy?: string
  organisers: readonly EcosystemOrganiser[]
}

export type EcosystemParty = { orgKey?: string; personKey?: string }

export type EcosystemInput = {
  campus: string
  layers: readonly EcosystemLayer[]
  /** Relationship types the `relationships` layer keeps; empty or absent: all. */
  types?: readonly string[]
  orgs: ReadonlyMap<string, EcosystemOrg>
  /** Listings under an `organisation` suppression. */
  suppressedOrgs: ReadonlySet<string>
  relationships?: readonly EcosystemRelationship[]
  /** Events read whole: the co-hosted ones of the window, and those
   * relationship sightings name (read to judge the sighting by its event). */
  events?: readonly EcosystemEvent[]
  /** The events the `cohosting` layer counts: those the server's windowed
   * organiser scan selected. An event read only because a relationship
   * sighting names it never counts as co-hosting, so the layer's yearly counts
   * do not depend on which other layers are on. Absent: every one of `events`. */
  cohostEventKeys?: ReadonlySet<string>
  /** Every event key the server looked up, found or not. A sighting naming an
   * event outside it is not counted: an event left unread (over a read limit,
   * or suppressed) cannot be cleared of talks.cam, so the boundary fails
   * closed. Absent: the keys of `events`. */
  judgedEventKeys?: ReadonlySet<string>
  profiles?: readonly { orgKey: string; pastSponsorKeys: readonly string[] }[]
  interactions?: readonly (EcosystemParty & { date: number })[]
  introductions?: readonly {
    key: string
    partyA: EcosystemParty
    partyB: EcosystemParty
    date: number
    status: string
  }[]
  /** The broker's people: only counted, per organisation. */
  people?: readonly { key: string; orgKey: string; archived: boolean }[]
  suppressedPeople?: ReadonlySet<string>
}

// --- output -----------------------------------------------------------------------------

export type EcosystemNode = {
  id: string
  key: string
  slug?: string
  name: string
  orgType?: string
  isCounterpart: boolean
  hidden: boolean
  /** A sensitive society (Art 9): shown with an icon and the word. */
  sensitive: boolean
  /** How many people the CRM holds for it: a count, never a node. */
  people: number
  /** The broker's interactions with it (outreach layer). */
  interactions: number
  lastInteractionAt?: number
  degree: number
}

export type EcosystemEdge = {
  id: string
  from: string
  to: string
  layer: EcosystemLayer
  type: string
  visibility: "public" | "internal"
  /** Sightings, events or introductions behind the edge. */
  weight: number
  lastSeenAt?: number
  /** Co-hosting: events per academic year, oldest first. */
  years: { academicYear: string; count: number }[]
  /** Outreach: the latest introduction's status. */
  status?: string
}

export type Ecosystem = {
  campus: string
  layers: EcosystemLayer[]
  nodes: EcosystemNode[]
  edges: EcosystemEdge[]
}

// --- aggregation ------------------------------------------------------------------------

type Draft = Omit<EcosystemEdge, "years"> & { years: Map<string, number> }

/**
 * The map of the requested layers. The inputs are whatever the server read;
 * every rule above is applied here.
 */
export function buildEcosystem(input: EcosystemInput): Ecosystem {
  const layers = ECOSYSTEM_LAYERS.filter((layer) => input.layers.includes(layer))
  const { campus, orgs } = input
  const id = (key: string) => nodeId(campus, key)

  /** Shown in a non-default layer: known, not hidden, not suppressed. */
  const listed = (key: string | undefined): key is string => {
    if (!key) return false
    const org = orgs.get(key)
    return org !== undefined && org.hidden !== true && !input.suppressedOrgs.has(key)
  }

  const talksEvents = new Set(
    (input.events ?? []).filter((event) => isTalksDerivedEvent(event)).map((event) => event.key),
  )
  const judged = input.judgedEventKeys ?? new Set((input.events ?? []).map((event) => event.key))
  /** A relationship sighting not read from talks.cam: not on talks.cam itself
   * and, when it names an event, one that was read and is not talks-derived. */
  const usable = (evidence: EcosystemRelationship["evidence"][number]) =>
    !isTalksCamUrl(evidence.sourceUrl) &&
    (evidence.eventKey === undefined ||
      (judged.has(evidence.eventKey) && !talksEvents.has(evidence.eventKey)))

  const edges = new Map<string, Draft>()
  const add = (draft: Omit<Draft, "years">, year?: string) => {
    const existing = edges.get(draft.id)
    const target = existing ?? { ...draft, weight: 0, years: new Map<string, number>() }
    if (existing) {
      if ((draft.lastSeenAt ?? 0) > (existing.lastSeenAt ?? 0)) {
        existing.lastSeenAt = draft.lastSeenAt
        if (draft.status) existing.status = draft.status
      }
      if (draft.visibility === "public") existing.visibility = "public"
    }
    target.weight += draft.weight
    if (year) target.years.set(year, (target.years.get(year) ?? 0) + draft.weight)
    edges.set(draft.id, target)
  }

  if (layers.includes("relationships")) {
    const wanted = input.types?.length ? new Set(input.types) : null
    for (const edge of input.relationships ?? []) {
      if (wanted && !wanted.has(edge.type)) continue
      const kept = edge.evidence.filter(usable)
      if (kept.length === 0) continue
      add({
        id: `${campus}:relationships:${edge.key}`,
        from: id(edge.fromKey),
        to: id(edge.toKey),
        layer: "relationships",
        type: edge.type,
        visibility: edge.visibility,
        weight: kept.length,
        lastSeenAt: edge.lastSeenAt,
      })
    }
  }

  if (layers.includes("cohosting")) {
    const counted = input.cohostEventKeys
    for (const event of input.events ?? []) {
      if (counted && !counted.has(event.key)) continue
      if (event.hosting === "takes_part" || event.cancelled || event.supersededBy) continue
      if (event.visibility === "members_only" || talksEvents.has(event.key)) continue
      const organisers = event.organisers.filter(({ orgKey }) => listed(orgKey))
      const roles = new Map<string, EcosystemOrganiser["role"]>()
      for (const { orgKey, role } of organisers) {
        // A host outranks a sponsor: an organisation listed both ways hosts.
        if (roles.get(orgKey) === undefined || roles.get(orgKey) === "sponsor") {
          roles.set(orgKey, role)
        }
      }
      const hosts = [...roles].filter(([, role]) => role !== "sponsor").map(([key]) => key)
      const sponsors = [...roles].filter(([, role]) => role === "sponsor").map(([key]) => key)
      const coHosted = organisers.some(({ role }) => role === "co_host")
      const sighting = { layer: "cohosting" as const, visibility: "internal" as const, weight: 1 }
      if (coHosted) {
        const sorted = [...hosts].sort()
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            add(
              {
                ...sighting,
                id: `${campus}:cohosting:co_host:${sorted[i]}|${sorted[j]}`,
                from: id(sorted[i]),
                to: id(sorted[j]),
                type: "co_host",
                lastSeenAt: event.startsAt,
              },
              event.academicYear,
            )
          }
        }
      }
      for (const sponsor of sponsors) {
        for (const host of hosts) {
          add(
            {
              ...sighting,
              id: `${campus}:cohosting:sponsor:${sponsor}>${host}`,
              from: id(sponsor),
              to: id(host),
              type: "sponsor",
              lastSeenAt: event.startsAt,
            },
            event.academicYear,
          )
        }
      }
    }
  }

  if (layers.includes("sponsors")) {
    for (const profile of input.profiles ?? []) {
      if (!listed(profile.orgKey)) continue
      for (const sponsor of new Set(profile.pastSponsorKeys)) {
        if (!listed(sponsor) || sponsor === profile.orgKey) continue
        add({
          id: `${campus}:sponsors:past_sponsor:${sponsor}>${profile.orgKey}`,
          from: id(sponsor),
          to: id(profile.orgKey),
          layer: "sponsors",
          type: "past_sponsor",
          visibility: "internal",
          weight: 1,
        })
      }
    }
    for (const edge of input.relationships ?? []) {
      if (edge.type !== "sponsors" || !listed(edge.fromKey) || !listed(edge.toKey)) continue
      const kept = edge.evidence.filter(usable)
      if (kept.length === 0) continue
      add({
        id: `${campus}:sponsors:sponsors:${edge.fromKey}>${edge.toKey}`,
        from: id(edge.fromKey),
        to: id(edge.toKey),
        layer: "sponsors",
        type: "sponsors",
        visibility: edge.visibility,
        weight: kept.length,
        lastSeenAt: edge.lastSeenAt,
      })
    }
  }

  const suppressedPeople = input.suppressedPeople ?? new Set<string>()
  const peopleByOrg = new Map<string, number>()
  const personOrg = new Map<string, string>()
  for (const person of input.people ?? []) {
    if (suppressedPeople.has(person.key)) continue
    personOrg.set(person.key, person.orgKey)
    if (!person.archived) peopleByOrg.set(person.orgKey, (peopleByOrg.get(person.orgKey) ?? 0) + 1)
  }
  /** The organisation a party stands for: its own, or its person's. */
  const orgOf = (party: EcosystemParty): string | undefined =>
    party.orgKey ??
    (party.personKey && !suppressedPeople.has(party.personKey)
      ? personOrg.get(party.personKey)
      : undefined)

  const touched = new Map<string, { count: number; lastAt: number }>()
  if (layers.includes("outreach")) {
    for (const interaction of input.interactions ?? []) {
      const key = orgOf(interaction)
      if (!listed(key)) continue
      const seen = touched.get(key) ?? { count: 0, lastAt: 0 }
      seen.count += 1
      seen.lastAt = Math.max(seen.lastAt, interaction.date)
      touched.set(key, seen)
    }
    for (const intro of input.introductions ?? []) {
      const a = orgOf(intro.partyA)
      const b = orgOf(intro.partyB)
      if (!listed(a) || !listed(b) || a === b) continue
      const [first, second] = [a, b].sort()
      add({
        id: `${campus}:outreach:introduction:${first}|${second}`,
        from: id(first),
        to: id(second),
        layer: "outreach",
        type: "introduction",
        visibility: "internal",
        weight: 1,
        lastSeenAt: intro.date,
        status: intro.status,
      })
    }
  }

  const finished: EcosystemEdge[] = [...edges.values()]
    .map(({ years, ...edge }) => ({
      ...edge,
      years: [...years]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([academicYear, count]) => ({ academicYear, count })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const degree = new Map<string, number>()
  for (const edge of finished) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const keys = new Set<string>()
  const keyOf = (node: string) => node.slice(campus.length + 1)
  for (const edge of finished) {
    keys.add(keyOf(edge.from))
    keys.add(keyOf(edge.to))
  }
  for (const key of touched.keys()) keys.add(key)

  const nodes: EcosystemNode[] = [...keys].sort().map((key) => {
    const org = orgs.get(key)
    const seen = touched.get(key)
    return {
      id: id(key),
      key,
      slug: org?.slug,
      name: org?.name ?? key,
      orgType: org?.orgType,
      isCounterpart: org?.isCounterpart ?? false,
      hidden: org?.hidden === true || input.suppressedOrgs.has(key),
      sensitive: org ? isSensitiveSociety(org) : false,
      people: peopleByOrg.get(key) ?? 0,
      interactions: seen?.count ?? 0,
      ...(seen ? { lastInteractionAt: seen.lastAt } : {}),
      degree: degree.get(id(key)) ?? 0,
    }
  })

  return { campus, layers: [...layers], nodes, edges: finished }
}

// --- the drawn view ---------------------------------------------------------------------

export type EcosystemView = {
  nodes: EcosystemNode[]
  edges: EcosystemEdge[]
  /** Organisations left out by the cap. */
  dropped: number
}

/**
 * What the page draws: the edges of the chosen visibility, the organisations
 * they touch (and, for outreach, those the broker has been in touch with),
 * ranked by degree and capped at `max` (`MAX_NODES`).
 */
export function limitView(
  graph: Pick<Ecosystem, "nodes" | "edges">,
  options: { visibility?: "all" | "public" | "internal"; max?: number } = {},
): EcosystemView {
  const visibility = options.visibility ?? "all"
  const max = options.max ?? MAX_NODES
  const edges = graph.edges.filter((edge) => visibility === "all" || edge.visibility === visibility)
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  const candidates = graph.nodes
    .filter((node) => degree.has(node.id) || (visibility !== "public" && node.interactions > 0))
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }))
    .sort(
      (a, b) =>
        b.degree - a.degree || b.interactions - a.interactions || a.name.localeCompare(b.name),
    )
  const nodes = candidates.slice(0, max)
  const kept = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    dropped: candidates.length - nodes.length,
  }
}
