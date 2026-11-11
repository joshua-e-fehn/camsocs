import {
  fieldInput,
  isOwnerField,
  OWNER_FIELDS,
  type OwnerField,
  parseCorrection,
} from "../../lib/owner-corrections"
import {
  ORGANISATION_FIELD_LABELS,
  ORGANISATION_FIELDS,
  type OrganisationField,
  SUPPRESSION_SCOPES,
  type SuppressionScope,
} from "../../lib/vocab"
import { MAX_NAME_WORDS, nameWords } from "./suppressions"

/**
 * The request agent's draft (ENG-126): for each open claim, correction,
 * removal or objection, an agent on the VPS (pipeline `request_agent.py`,
 * through cliproxy) reads the request and the listing as it stands and
 * proposes what to apply. The broker reviews the draft in the accept dialog,
 * which it pre-fills, and confirms; the confirm runs the same mutations as a
 * hand-made acceptance (`acceptCorrections`, `acceptRemoval`). The agent
 * itself changes nothing.
 *
 * The request's text is the public's, unverified and possibly hostile, so
 * nothing the model says is taken on trust:
 *
 *  - **It never sees an address or a phone number.** Email addresses in the
 *    message and the proposed fields become tokens (`[sender]` for the
 *    submitter's own, `[email 1]` … for the others) and phone numbers
 *    `[phone]`; Convex keeps the map and swaps the tokens back in the draft.
 *    So an address in a draft is always one the request itself gave.
 *  - **No link or address it made up.** Every URL and address in a proposed
 *    value must appear in the request (message or fields); one that does not
 *    is dropped with the reason (AGENTS.md "Never invent or guess emails,
 *    handles or URLs").
 *  - **Every value is typed and checked** by `parseCorrection`, the same parser
 *    as the dialog, and again by the claims ingestion on confirm. A value the
 *    listing already shows is dropped as no change.
 *  - **An events page is a link the request gives** (ENG-158): when the
 *    request says where the society lists its events, the model returns that
 *    link (`eventsUrl`) and nothing else about it. The code checks it is in
 *    the request, refuses a platform that hosts many organisers, and derives
 *    the site's home page from it (`eventsSourceFrom`); when the listing shows
 *    no website on that host, the home page is proposed as its `website`.
 *    The agent then reads the site (the scraper's own rules) and the draft
 *    shows what it found; confirmed, the scraper reads it daily.
 *  - **A removal names only what the request names**: an address by its token,
 *    a person's name as the message spells it, an event key the request
 *    carries. Named people in the broker tables (scope `person`) are left to
 *    the broker.
 *
 * Pure: the module and the tests share it.
 */

export const DRAFT_KINDS = ["claim", "correct", "remove", "object"] as const
/** Tries per request before the agent gives up (a "Redraft" starts again). */
export const DRAFT_MAX_ATTEMPTS = 3
/** Wait before a failed draft is tried again. */
export const DRAFT_RETRY_AFTER_MS = 5 * 60 * 1000
/** Requests older than this get no draft (the agent's first run drafts the
 * open requests of the last two weeks, then only new ones). */
export const DRAFT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** Tries per site check and per job before the agent gives up. */
export const CHECK_MAX_ATTEMPTS = 3
export const JOB_MAX_ATTEMPTS = 3
/** A job still `running` after this long is taken to have died, and is run
 * again (the unit's own time limit is 45 minutes). */
export const JOB_STALE_MS = 60 * 60 * 1000
/** The agent is shown as offline when it has not called for this long. */
export const AGENT_STALE_MS = 5 * 60 * 1000
/** Characters of message the agent reads at most. */
export const MESSAGE_MAX = 6_000

export const SENDER_TOKEN = "[sender]"
const PHONE_TOKEN = "[phone]"

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g
const URL_RE = /https?:\/\/[^\s<>"'()[\]{}]+/gi
const TOKEN_RE = /\[(?:sender|email \d{1,3})\]/g
const HAS_TOKEN = /\[(?:sender|email \d{1,3}|phone)\]/
const EVENT_KEY_RE = /^evt-[0-9a-f]{40}$/

/** Addresses by token, and the request's texts with them masked. */
export type Masked = { texts: string[]; addresses: Record<string, string> }

/**
 * Masks every email address (`[sender]` for `sender`, `[email N]` for the
 * others, one token per address) and phone number (nine digits or more, so a
 * date or a year is left alone) in `texts`. Deterministic: the same request
 * masks the same way on every call, so the draft can be unmasked later.
 */
export function maskContacts(texts: readonly string[], sender: string): Masked {
  const addresses: Record<string, string> = {}
  const byAddress = new Map<string, string>()
  const own = sender.trim().toLowerCase()
  if (own) {
    addresses[SENDER_TOKEN] = own
    byAddress.set(own, SENDER_TOKEN)
  }
  const tokenFor = (raw: string) => {
    const address = raw.toLowerCase()
    let token = byAddress.get(address)
    if (!token) {
      token = `[email ${byAddress.size + (own ? 0 : 1)}]`
      byAddress.set(address, token)
      addresses[token] = address
    }
    return token
  }
  const masked = texts.map((text) =>
    text
      .replace(EMAIL_RE, (match) => tokenFor(match))
      .replace(PHONE_RE, (match) => (match.replace(/\D/g, "").length >= 9 ? PHONE_TOKEN : match)),
  )
  return { texts: masked, addresses }
}

/** `text` with every address and phone number replaced by `[listed address]`
 * and `[phone]`: the listing's own values, shown to the agent for comparison. */
export function hideContacts(text: string): string {
  return text
    .replace(EMAIL_RE, "[listed address]")
    .replace(PHONE_RE, (match) => (match.replace(/\D/g, "").length >= 9 ? PHONE_TOKEN : match))
}

/** `text` with each address token swapped back; an unknown token stays. */
export function unmask(text: string, addresses: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN_RE, (token) => addresses[token] ?? token)
}

function bareUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/.,;:!?]+$/, "")
}

/**
 * The links and addresses in `value` that the request (`requestText`, its
 * message and proposed fields, unmasked) does not contain. A link counts as
 * given when the request has it without its scheme, `www.` or a trailing
 * slash.
 */
export function unsupportedContacts(value: string, requestText: string): string[] {
  const haystack = requestText.toLowerCase().replace(/https?:\/\/(www\.)?/g, "")
  const missing: string[] = []
  for (const url of value.match(URL_RE) ?? []) {
    if (!haystack.includes(bareUrl(url))) missing.push(url)
  }
  const withoutUrls = value.replace(URL_RE, " ")
  for (const address of withoutUrls.match(EMAIL_RE) ?? []) {
    if (!haystack.includes(address.toLowerCase())) missing.push(address)
  }
  return missing
}

/**
 * Hosts that carry many organisers' pages, or that the scraper never reads as
 * a society's own site: an events link there gives no home page to derive,
 * so it is left to the broker (the pipeline's `SKIP_HOSTS` and
 * `NEVER_FETCH_HOSTS` hold on the VPS whatever this list says).
 */
const SHARED_HOSTS = [
  "talks.cam.ac.uk",
  "cambridgesu.co.uk",
  "facebook.com",
  "fb.me",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "linktr.ee",
  "eventbrite.com",
  "eventbrite.co.uk",
  "fixr.co",
  "lu.ma",
  "luma.com",
  "ticketsource.co.uk",
  "meetup.com",
  "google.com",
  "notion.site",
  "notion.so",
  "whatsapp.com",
  "discord.gg",
  "discord.com",
] as const

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}

export type EventsSource = { url: string; website: string }

/**
 * The events page a request points to, from the link the model returned, or
 * why it is refused. The link must be one the request gives (`requestText`);
 * the home page is its scheme and host, derived here and never by the model.
 */
export function eventsSourceFrom(
  raw: string | undefined,
  requestText: string,
): { source: EventsSource } | { refused: string } | null {
  const text = (raw ?? "").trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { refused: "not a link" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: "not a web link" }
  if (url.username || url.password) return { refused: "not a plain web link" }
  if (unsupportedContacts(text, requestText).length > 0) {
    return { refused: `not in the request: ${text.slice(0, 200)}` }
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (!host.includes(".")) return { refused: "not a public site" }
  if (SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))) {
    return { refused: `${host} hosts many organisers: not read as the society's own site` }
  }
  return { source: { url: text.slice(0, 500), website: `${url.protocol}//${url.host}/` } }
}

/** How a field's value is written, for the agent (the dialog's editor format). */
export function fieldFormat(field: OwnerField): string {
  const input = fieldInput(field)
  switch (input.kind) {
    case "text":
      return input.max ? `plain text, at most ${input.max} characters` : "plain text"
    case "url":
      return "one http(s) link"
    case "email":
      return "one email address"
    case "boolean":
      return '"yes" or "no"'
    case "choice":
      return `exactly one of: ${input.options.join(", ")}`
    case "choices":
      return `one or more of, comma-separated: ${input.options.join(", ")}`
    case "lines":
      return `one item per line (${input.hint})`
    case "json":
      return `a JSON value like ${input.example}`
  }
}

const label = (field: string) => ORGANISATION_FIELD_LABELS[field as OrganisationField] ?? field

/** The correctable fields, their labels and formats, for the agent's prompt. */
export function fieldGuide(): { field: string; label: string; format: string }[] {
  return OWNER_FIELDS.map((field) => ({ field, label: label(field), format: fieldFormat(field) }))
}

/** A stored value as the dialog's editor would write it. */
export function displayValue(field: OwnerField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  const input = fieldInput(field)
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return input.kind === "choices" ? value.join(", ") : value.join("\n")
  }
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

/** Fields a removal may take off a listing (as `acceptRemoval`). */
const REMOVABLE_FIELDS = ORGANISATION_FIELDS.filter(
  (field) => field !== "name" && field !== "isCounterpart",
) as readonly string[]

/** Scopes the agent may propose: not `person`, which needs the broker's keys. */
export const AGENT_REMOVAL_SCOPES = SUPPRESSION_SCOPES.filter((scope) => scope !== "person")

/** The model's reply, as the agent posts it. */
export type AgentReply = {
  summary: string
  action: "corrections" | "removal" | "none"
  corrections: { field: string; value: string; reason?: string }[]
  removal: {
    scope: string
    fields?: string[]
    address?: string
    name?: string
    eventKeys?: string[]
  } | null
  concerns: string[]
  reply: string
  /** The page where the society lists its events, when the request gives it. */
  eventsUrl?: string
}

export type DraftRemoval = {
  scope: SuppressionScope
  fields?: string[]
  address?: string
  name?: string
  eventKeys?: string[]
}

export type DraftBody = {
  summary: string
  concerns: string[]
  corrections: { field: string; text: string; current?: string; reason?: string }[]
  removal?: DraftRemoval
  dropped: { field: string; reason: string }[]
  reply: string
  eventsSource?: EventsSource
}

/** What `buildDraft` needs to know about the request and its listing. */
export type DraftContext = {
  kind: string
  /** Token → address, from `maskContacts` over the same texts. */
  addresses: Readonly<Record<string, string>>
  /** The request's message and proposed values, unmasked. */
  requestText: string
  message: string
  eventKey?: string
  /** The listing's stored value of a field, or undefined. */
  current: (field: OwnerField) => unknown
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Turns the model's reply into the stored draft: each correction typed and
 * checked (a refused one goes to `dropped` with the reason), a removal kept
 * only when everything it names comes from the request. Pure.
 */
export function buildDraft(reply: AgentReply, context: DraftContext): DraftBody {
  const dropped: DraftBody["dropped"] = []
  const corrections: DraftBody["corrections"] = []
  const correcting = context.kind === "claim" || context.kind === "correct"
  const removing = context.kind === "remove" || context.kind === "object"

  if (correcting) {
    const seen = new Set<string>()
    for (const proposal of reply.corrections.slice(0, 30)) {
      const field = proposal.field.trim()
      if (!isOwnerField(field)) {
        dropped.push({ field, reason: "not a field that can be corrected here" })
        continue
      }
      if (seen.has(field)) continue
      seen.add(field)
      const text = unmask(proposal.value, context.addresses).trim()
      if (HAS_TOKEN.test(text)) {
        dropped.push({ field, reason: "names an address the request does not give" })
        continue
      }
      const invented = unsupportedContacts(text, context.requestText)
      if (invented.length > 0) {
        dropped.push({ field, reason: `not in the request: ${invented.join(", ")}` })
        continue
      }
      const parsed = parseCorrection(field, text)
      if (!parsed.ok) {
        dropped.push({ field, reason: parsed.error })
        continue
      }
      const now = context.current(field)
      if (sameValue(parsed.value, now)) {
        dropped.push({ field, reason: "the listing already shows this" })
        continue
      }
      const current = displayValue(field, now)
      corrections.push({
        field,
        text,
        ...(current !== undefined ? { current: cut(current, 2_000) } : {}),
        ...(proposal.reason?.trim() ? { reason: cut(proposal.reason.trim(), 300) } : {}),
      })
    }
  }

  // The events page (ENG-158): the link the request gives, and its site's home
  // page as the listing's website when the listing shows none on that host.
  let eventsSource: EventsSource | undefined
  if (correcting) {
    const found = eventsSourceFrom(reply.eventsUrl, context.requestText)
    if (found && "refused" in found) dropped.push({ field: "events page", reason: found.refused })
    if (found && "source" in found) {
      eventsSource = found.source
      const now = context.current("website")
      const listed = typeof now === "string" ? hostOf(now) : ""
      const proposed = corrections.some((item) => item.field === "website")
      const parsed = parseCorrection("website", eventsSource.website)
      if (!proposed && parsed.ok && listed !== hostOf(eventsSource.website)) {
        const current = displayValue("website", now)
        corrections.push({
          field: "website",
          text: eventsSource.website,
          ...(current !== undefined ? { current: cut(current, 2_000) } : {}),
          reason: "the home page of the events link in the request",
        })
      }
    }
  }

  let removal: DraftRemoval | undefined
  if (removing && reply.removal) {
    const checked = checkRemoval(reply.removal, context)
    if (typeof checked === "string") dropped.push({ field: "removal", reason: checked })
    else removal = checked
  }

  return {
    summary: cut(reply.summary.trim(), 800),
    concerns: reply.concerns
      .map((concern) => cut(concern.trim(), 300))
      .filter(Boolean)
      .slice(0, 6),
    corrections,
    ...(removal ? { removal } : {}),
    dropped: dropped.slice(0, 30),
    reply: cut(unmask(reply.reply, context.addresses).trim(), 3_000),
    ...(eventsSource ? { eventsSource } : {}),
  }
}

/** The removal the model proposed, or why it is refused. */
function checkRemoval(
  proposal: NonNullable<AgentReply["removal"]>,
  context: DraftContext,
): DraftRemoval | string {
  const scope = proposal.scope as SuppressionScope
  if (!(AGENT_REMOVAL_SCOPES as readonly string[]).includes(scope)) {
    return `scope "${proposal.scope}" is left to the broker`
  }
  switch (scope) {
    case "organisation":
      return { scope }
    case "field": {
      const fields = [...new Set(proposal.fields ?? [])].filter((field) =>
        REMOVABLE_FIELDS.includes(field),
      )
      return fields.length > 0 ? { scope, fields } : "no field that can be removed"
    }
    case "contact": {
      const token = proposal.address?.trim() ?? ""
      const address = context.addresses[token]
      return address ? { scope, address } : "the address is not one the request gives"
    }
    case "name": {
      const name = (proposal.name ?? "").trim().replace(/\s+/g, " ")
      const words = nameWords(name)
      if (words.length < 2 || words.length > MAX_NAME_WORDS) return "not a full name"
      if (!context.message.toLowerCase().replace(/\s+/g, " ").includes(name.toLowerCase())) {
        return "the name is not spelt that way in the request"
      }
      return { scope, name }
    }
    case "event": {
      const keys = [...new Set(proposal.eventKeys ?? [])].filter(
        (key) =>
          EVENT_KEY_RE.test(key) && (key === context.eventKey || context.requestText.includes(key)),
      )
      return keys.length > 0 ? { scope, eventKeys: keys } : "no event key from the request"
    }
    default:
      return `scope "${proposal.scope}" is left to the broker`
  }
}

/** Facts about the sender the broker should see, by rule, not by the model. */
export type SenderChecks = {
  /** The sender's domain. */
  domain: string
  /** A University address (cam.ac.uk or a subdomain). */
  cam: boolean
  /** The address is one the listing publishes (its email or a role email). */
  listed: boolean
  /** The domain is the listing website's. */
  siteDomain: boolean
}

export function senderChecks(
  sender: string,
  listing: { email?: unknown; roleEmails?: unknown; website?: unknown } | null,
): SenderChecks {
  const address = sender.trim().toLowerCase()
  const domain = address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : ""
  const published = JSON.stringify([listing?.email ?? null, listing?.roleEmails ?? null])
  let site = ""
  if (typeof listing?.website === "string") {
    try {
      site = new URL(listing.website).hostname.toLowerCase().replace(/^www\./, "")
    } catch {
      site = ""
    }
  }
  return {
    domain,
    cam: domain === "cam.ac.uk" || domain.endsWith(".cam.ac.uk"),
    listed: address !== "" && published.toLowerCase().includes(`"${address}"`),
    siteDomain: site !== "" && (domain === site || domain.endsWith(`.${site}`)),
  }
}
