import { RESEND_ENDPOINT } from "./signInEmail"

/**
 * New listing request → the broker (ENG-104). Two senders:
 *
 *  - **Slack and WhatsApp go through Mya**, the Hermes agent on the VPS: the
 *    root-owned `camsocs-notify` timer (ops/vps/camsocs-notify.py) asks
 *    `POST /api/pipeline/notify/pending` every minute, sends each item with
 *    Mya's Slack bot and her WhatsApp bridge, and reports back on
 *    `/api/pipeline/notify/ack`. Convex cannot reach the VPS, so the VPS
 *    pulls. The relay names the channels it serves on every call; the
 *    dashboard shows them with the time it last called.
 *  - **Email is sent from here**, through Resend (shared with the sign-in
 *    email): `RESEND_API_KEY` + `RESEND_FROM`, and `REQUEST_NOTIFY_EMAIL`
 *    (comma-separated) for where to.
 *
 * What goes where. The request's text is the public's and unverified, so the
 * relay gets **facts, not formatting**: the kind, the listing's name (ours),
 * the role, the submitter's *domain*, the proposed field names and a
 * flattened preview of at most `RELAY_PREVIEW` characters; the relay checks
 * each one's shape and escapes it for Slack. Email carries everything the
 * inbox shows, escaped and marked unverified.
 *
 * Every message links to the request itself on the broker dashboard
 * (`/dashboard/requests?request=<key>`), behind the broker sign-in.
 *
 * ⚠ Never log a key or a message body: errors carry the channel and an HTTP
 * status or error type only.
 */

export const NOTIFY_CHANNELS = ["slack", "email", "whatsapp"] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]
/** The channels the VPS relay can serve. */
export const RELAY_CHANNELS = ["slack", "whatsapp"] as const
export type RelayChannel = (typeof RELAY_CHANNELS)[number]

/** How long the email request may take before it is abandoned. */
export const NOTIFY_TIMEOUT_MS = 10_000
/** Relay preview length (characters, after flattening). */
export const RELAY_PREVIEW = 280
export const EMAIL_MESSAGE_MAX = 5_000
/** Tries per channel before a request stops being offered to the relay. */
export const MAX_ATTEMPTS = 3
/** Wait between two tries of the same channel. */
export const RETRY_AFTER_MS = 2 * 60 * 1000
/** Requests older than this are no longer offered (a relay switched on later
 * announces the open requests of the last two weeks, then only new ones). */
export const RELAY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
/** A relay that has not called for this long is shown as down. */
export const RELAY_STALE_MS = 5 * 60 * 1000

type Env = Record<string, string | undefined>

export type EmailConfig = { apiKey: string; from: string; to: string[] }

/** The email sender, or null where it is off. Read per call, so setting an env
 * var takes effect without a deploy. */
export function emailConfig(env: Env = process.env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim()
  const from = env.RESEND_FROM?.trim()
  const to = (env.REQUEST_NOTIFY_EMAIL ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
  return apiKey && from && to.length > 0 ? { apiKey, from, to } : null
}

/** What a notification says about one request. */
export type RequestNotice = {
  key: string
  kind: string
  createdAt: number
  /** The listing's name (ours), when the request names one. */
  orgName?: string
  orgKey?: string
  eventKey?: string
  role?: string
  submitterEmail: string
  message: string
  fieldNames: string[]
  /** A broker's test: says so in every message. */
  test?: boolean
}

const KIND_LABEL: Record<string, string> = {
  claim: "Claim",
  correct: "Correction",
  remove: "Removal",
  object: "Objection",
  add: "New listing",
}

export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind

/** The request on the broker dashboard. */
export function requestLink(site: string, key: string): string {
  return `${site.replace(/\/+$/, "")}/dashboard/requests?request=${encodeURIComponent(key)}`
}

/** One line of untrusted text: control characters and line breaks gone,
 * whitespace collapsed, cut to `max` with an ellipsis. */
export function flatten(text: string, max: number): string {
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@")
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "?"
}

/** The listing as a message names it. */
export function listingLabel(notice: Pick<RequestNotice, "orgName" | "kind" | "eventKey">) {
  return (
    notice.orgName ?? (notice.kind === "add" ? "a new listing" : notice.eventKey ? "an event" : "—")
  )
}

function headline(notice: RequestNotice): string {
  return `${notice.test ? "[TEST] " : ""}${kindLabel(notice.kind)}: ${listingLabel(notice)}`
}

/** What the VPS relay is given for one request: facts, each flattened and
 * capped, never the submitter's address. Pure. */
export function relayFacts(notice: RequestNotice) {
  return {
    id: notice.key,
    test: notice.test === true,
    kind: notice.kind,
    listing: flatten(listingLabel(notice), 120),
    role: notice.role ? flatten(notice.role, 60) : null,
    fromDomain: flatten(emailDomain(notice.submitterEmail), 100),
    fields: notice.fieldNames.slice(0, 10).map((name) => flatten(name, 40)),
    preview: flatten(notice.message, RELAY_PREVIEW),
    createdAt: notice.createdAt,
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Resend `POST /emails` body. Pure. */
export function buildEmail(
  notice: RequestNotice,
  site: string,
  from: string,
  to: string[],
): { from: string; to: string[]; subject: string; text: string; html: string } {
  const link = requestLink(site, notice.key)
  const subject = `CAMsocs: ${flatten(headline(notice), 120)}`
  const message =
    notice.message.length > EMAIL_MESSAGE_MAX
      ? `${notice.message.slice(0, EMAIL_MESSAGE_MAX)}…`
      : notice.message
  const facts: [string, string][] = [
    ["Kind", kindLabel(notice.kind)],
    ["Listing", notice.orgName ? `${notice.orgName} (${notice.orgKey})` : (notice.orgKey ?? "—")],
    ...(notice.eventKey ? ([["Event", notice.eventKey]] as [string, string][]) : []),
    ["From", `${notice.submitterEmail} (unverified)`],
    ...(notice.role ? ([["Role", flatten(notice.role, 100)]] as [string, string][]) : []),
    ...(notice.fieldNames.length > 0
      ? ([["Proposed fields", notice.fieldNames.join(", ")]] as [string, string][])
      : []),
    ["Received", `${new Date(notice.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC`],
    ["Request", notice.key],
  ]
  const text = [
    notice.test ? "This is a test notification from the broker dashboard.\n" : "",
    "A new request came in through the CAMsocs listing form.",
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    "Message (as submitted, not verified):",
    ...message.split("\n").map((line) => `> ${line}`),
    "",
    `Open it: ${link}`,
    "",
    "The address is not verified: reply to it before acting on a removal or objection.",
  ].join("\n")
  const html = [
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#1f1d24;max-width:560px">',
    notice.test
      ? '<p style="color:#a14a00"><strong>Test notification</strong> from the broker dashboard.</p>'
      : "",
    "<p>A new request came in through the CAMsocs listing form.</p>",
    '<table style="border-collapse:collapse;font-size:14px">',
    ...facts.map(
      ([label, value]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#5f5a66;vertical-align:top">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`,
    ),
    "</table>",
    '<p style="margin-top:16px;color:#5f5a66;font-size:13px">Message (as submitted, not verified):</p>',
    `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #1D7A7A;background:#f4f8f9;white-space:pre-wrap">${escapeHtml(message)}</blockquote>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;margin-top:12px;padding:10px 16px;border-radius:8px;background:#1f1d24;color:#ffffff;text-decoration:none">Open the request</a></p>`,
    '<p style="font-size:12px;color:#8a8590">The address is not verified: reply to it before acting on a removal or objection.</p>',
    "</div>",
  ].join("")
  return { from, to, subject, text, html }
}

export type DeliveryResult = { channel: NotifyChannel; ok: boolean; error?: string }

/** Sends `notice` by email. Never throws; null when email is off. */
export async function sendEmail(
  config: EmailConfig | null,
  notice: RequestNotice,
  site: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult | null> {
  if (!config) return null
  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildEmail(notice, site, config.from, config.to)),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    })
    if (!response.ok) return { channel: "email", ok: false, error: `HTTP ${response.status}` }
    return { channel: "email", ok: true }
  } catch (error) {
    const name = error instanceof Error ? error.name : "error"
    return {
      channel: "email",
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "timeout" : name,
    }
  }
}

/** One channel's stored outcome on a request or test. */
export type Delivery = {
  channel: NotifyChannel
  ok: boolean
  error?: string
  at: number
  attempts?: number
}

/** Whether the relay should be given `channel` for something with these
 * deliveries now: never delivered, tries left, and the last try old enough. */
export function relayDue(deliveries: readonly Delivery[], channel: RelayChannel, now: number) {
  const entry = deliveries.find((d) => d.channel === channel)
  if (!entry) return true
  if (entry.ok) return false
  return (entry.attempts ?? 1) < MAX_ATTEMPTS && now - entry.at >= RETRY_AFTER_MS
}

/** `deliveries` with `results` merged in: the latest outcome per channel,
 * counting tries. */
export function mergeDeliveries(
  deliveries: readonly Delivery[],
  results: readonly { channel: NotifyChannel; ok: boolean; error?: string }[],
  at: number,
): Delivery[] {
  const byChannel = new Map(deliveries.map((d) => [d.channel, d]))
  for (const result of results) {
    const previous = byChannel.get(result.channel)
    byChannel.set(result.channel, {
      channel: result.channel,
      ok: result.ok,
      ...(result.error ? { error: result.error.slice(0, 80) } : {}),
      at,
      attempts: (previous?.attempts ?? (previous ? 1 : 0)) + 1,
    })
  }
  return NOTIFY_CHANNELS.flatMap((channel) => {
    const entry = byChannel.get(channel)
    return entry ? [entry] : []
  })
}
