import { RESEND_ENDPOINT } from "./signInEmail"

/**
 * New listing request → the broker, on every channel that is configured
 * (ENG-104). Each channel is off until its env vars are set on the deployment,
 * and nothing else is needed (docs/deploy.md "Request notifications"):
 *
 *   Slack     SLACK_REQUESTS_WEBHOOK_URL   an incoming webhook (a Slack app of
 *                                          its own, one channel; never Mya's bot)
 *   Email     RESEND_API_KEY + RESEND_FROM (shared with the sign-in email)
 *             REQUEST_NOTIFY_EMAIL         where to (comma-separated)
 *   WhatsApp  either Meta's Cloud API with an approved template:
 *               WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TO,
 *               WHATSAPP_TEMPLATE (default camsocs_listing_request),
 *               WHATSAPP_TEMPLATE_LANG (default en)
 *             or CallMeBot (one personal number, a third-party relay):
 *               CALLMEBOT_PHONE, CALLMEBOT_APIKEY
 *
 * What goes where. The request's text is the public's and unverified, so:
 *
 *  - **email** carries everything the inbox shows (the submitter's address,
 *    role, message, proposed field names), quoted and marked unverified;
 *  - **Slack** a short, flattened, mention-proof preview of the message and
 *    only the submitter's domain: the channel may be read by tools, and a
 *    request must never be able to ping or address anyone there;
 *  - **WhatsApp** no free text at all: the kind, the listing's name (ours,
 *    public on the site) and the link. CallMeBot relays the text through a
 *    third party, which is why nothing personal is in it.
 *
 * Every message links to the request itself on the broker dashboard
 * (`/dashboard/requests?request=<key>`), behind the broker sign-in.
 *
 * ⚠ Never log a webhook URL, token, key or a message body: errors carry the
 * channel and HTTP status only.
 */

export const NOTIFY_CHANNELS = ["slack", "email", "whatsapp"] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]

/** How long one channel's request may take before it is abandoned. */
export const NOTIFY_TIMEOUT_MS = 10_000
export const DEFAULT_WHATSAPP_TEMPLATE = "camsocs_listing_request"
export const DEFAULT_WHATSAPP_LANG = "en"
export const WHATSAPP_GRAPH_VERSION = "v23.0"
export const CALLMEBOT_ENDPOINT = "https://api.callmebot.com/whatsapp.php"
/** Message preview lengths (characters). */
export const SLACK_PREVIEW = 280
export const EMAIL_MESSAGE_MAX = 5_000

type Env = Record<string, string | undefined>

export type WhatsAppConfig =
  | {
      provider: "meta"
      token: string
      phoneNumberId: string
      to: string
      template: string
      lang: string
    }
  | { provider: "callmebot"; phone: string; apiKey: string }

export type NotifyConfig = {
  slack: { webhookUrl: string } | null
  email: { apiKey: string; from: string; to: string[] } | null
  whatsapp: WhatsAppConfig | null
}

const trimmed = (value: string | undefined) => value?.trim() || undefined

/** Each channel's settings, or null where it is off. Read per call, so setting
 * an env var takes effect without a deploy. */
export function notifyConfig(env: Env = process.env): NotifyConfig {
  const webhookUrl = trimmed(env.SLACK_REQUESTS_WEBHOOK_URL)
  const slack = webhookUrl?.startsWith("https://hooks.slack.com/") === true ? { webhookUrl } : null

  const apiKey = trimmed(env.RESEND_API_KEY)
  const from = trimmed(env.RESEND_FROM)
  const to = (env.REQUEST_NOTIFY_EMAIL ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
  const email = apiKey && from && to.length > 0 ? { apiKey, from, to } : null

  let whatsapp: WhatsAppConfig | null = null
  const token = trimmed(env.WHATSAPP_TOKEN)
  const phoneNumberId = trimmed(env.WHATSAPP_PHONE_NUMBER_ID)
  const waTo = trimmed(env.WHATSAPP_TO)?.replace(/[^\d]/g, "")
  if (token && phoneNumberId && waTo) {
    whatsapp = {
      provider: "meta",
      token,
      phoneNumberId,
      to: waTo,
      template: trimmed(env.WHATSAPP_TEMPLATE) ?? DEFAULT_WHATSAPP_TEMPLATE,
      lang: trimmed(env.WHATSAPP_TEMPLATE_LANG) ?? DEFAULT_WHATSAPP_LANG,
    }
  } else {
    const phone = trimmed(env.CALLMEBOT_PHONE)?.replace(/[^\d+]/g, "")
    const cmbKey = trimmed(env.CALLMEBOT_APIKEY)
    if (phone && cmbKey) whatsapp = { provider: "callmebot", phone, apiKey: cmbKey }
  }
  return { slack, email, whatsapp }
}

/** Which channels are on, for the broker page (no secrets). */
export function channelSummary(config: NotifyConfig) {
  return {
    slack: config.slack !== null,
    email: config.email !== null,
    whatsapp: config.whatsapp?.provider ?? null,
  }
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

/** Slack mrkdwn escaping (`&`, `<`, `>`): no link, mention or `<!channel>` can
 * be formed from the text, and `@` becomes the full-width "＠" so a bare
 * "@here" cannot notify anyone either. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "＠")
}

export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@")
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "?"
}

function headline(notice: RequestNotice): string {
  const what = kindLabel(notice.kind)
  const listing =
    notice.orgName ?? (notice.kind === "add" ? "a new listing" : notice.eventKey ? "an event" : "—")
  return `${notice.test ? "[TEST] " : ""}${what}: ${listing}`
}

/** Slack incoming-webhook body. Pure. */
export function buildSlack(notice: RequestNotice, site: string) {
  const link = requestLink(site, notice.key)
  const role = notice.role ? `${slackEscape(flatten(notice.role, 60))}, ` : ""
  const preview = slackEscape(flatten(notice.message, SLACK_PREVIEW))
  const title = slackEscape(flatten(headline(notice), 160))
  const lines = [
    `*New CAMsocs request* · ${title}`,
    `From ${role}someone at ${slackEscape(emailDomain(notice.submitterEmail))} (address unverified)`,
    notice.fieldNames.length > 0
      ? `Proposed fields: ${slackEscape(flatten(notice.fieldNames.join(", "), 200))}`
      : null,
    `> ${preview}`,
    `<${link}|Open the request>`,
  ].filter((line): line is string => line !== null)
  return {
    text: `New CAMsocs request: ${title}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
    unfurl_links: false,
    unfurl_media: false,
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
    `A new request came in through the CAMsocs listing form.`,
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
    `<p>A new request came in through the CAMsocs listing form.</p>`,
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

/** WhatsApp text: kind, listing, link — never the submitter's words. Pure. */
export function whatsAppText(notice: RequestNotice, site: string): string {
  return `${headline(notice)}\n${requestLink(site, notice.key)}`
}

/** Meta Cloud API template message. The template has three body parameters:
 * {{1}} kind, {{2}} listing, {{3}} link (docs/deploy.md). Pure. */
export function buildWhatsAppTemplate(
  notice: RequestNotice,
  site: string,
  config: Extract<WhatsAppConfig, { provider: "meta" }>,
) {
  const listing = notice.orgName ?? (notice.kind === "add" ? "a new listing" : "—")
  const param = (text: string) => ({ type: "text", text: flatten(text, 200) })
  return {
    messaging_product: "whatsapp",
    to: config.to,
    type: "template",
    template: {
      name: config.template,
      language: { code: config.lang },
      components: [
        {
          type: "body",
          parameters: [
            param(`${notice.test ? "[TEST] " : ""}${kindLabel(notice.kind)}`),
            param(listing),
            param(requestLink(site, notice.key)),
          ],
        },
      ],
    },
  }
}

export type DeliveryResult = { channel: NotifyChannel; ok: boolean; error?: string }

async function timed(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) })
}

/** A failure message safe to store and log: status and error type only. */
function failure(channel: NotifyChannel, error: unknown): DeliveryResult {
  const reason =
    error instanceof Response
      ? `HTTP ${error.status}`
      : error instanceof Error
        ? error.name === "TimeoutError" || error.name === "AbortError"
          ? "timeout"
          : error.name
        : "error"
  return { channel, ok: false, error: reason }
}

async function expectOk(response: Response): Promise<void> {
  if (!response.ok) throw response
}

/** Sends `notice` on one channel. Never throws. */
export async function sendOn(
  channel: NotifyChannel,
  config: NotifyConfig,
  notice: RequestNotice,
  site: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult | null> {
  try {
    if (channel === "slack") {
      if (!config.slack) return null
      await expectOk(
        await timed(fetchImpl, config.slack.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildSlack(notice, site)),
        }),
      )
    } else if (channel === "email") {
      if (!config.email) return null
      const { apiKey, from, to } = config.email
      await expectOk(
        await timed(fetchImpl, RESEND_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildEmail(notice, site, from, to)),
        }),
      )
    } else {
      const wa = config.whatsapp
      if (!wa) return null
      if (wa.provider === "meta") {
        await expectOk(
          await timed(
            fetchImpl,
            `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(wa.phoneNumberId)}/messages`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${wa.token}`, "Content-Type": "application/json" },
              body: JSON.stringify(buildWhatsAppTemplate(notice, site, wa)),
            },
          ),
        )
      } else {
        const url = new URL(CALLMEBOT_ENDPOINT)
        url.searchParams.set("phone", wa.phone)
        url.searchParams.set("text", whatsAppText(notice, site))
        url.searchParams.set("apikey", wa.apiKey)
        const response = await timed(fetchImpl, url.toString(), { method: "GET" })
        await expectOk(response)
        // CallMeBot can answer 200 with a page that says it refused.
        const body = (await response.text()).toLowerCase()
        if (body.includes("apikey is invalid") || body.includes("not allowed")) {
          return { channel, ok: false, error: "refused" }
        }
      }
    }
    return { channel, ok: true }
  } catch (error) {
    return failure(channel, error)
  }
}
