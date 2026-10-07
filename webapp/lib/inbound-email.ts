/**
 * Forwarded society list mail (source-research §16): the pure half of
 * `POST /api/inbound/email` (convex/http.ts).
 *
 * Two payload shapes reach that route:
 *
 *  - **provider-agnostic JSON**, authenticated with `Authorization: Bearer
 *    $INBOUND_EMAIL_SECRET` — `{ messageId, from, to, subject, text, html?,
 *    headers?, date?, attachments?: [{ filename, contentType, contentBase64 }] }`
 *    (`parseGenericPayload`);
 *  - **Resend's `email.received` webhook**, authenticated by its Svix signature
 *    (`verifySvixSignature` with `$RESEND_WEBHOOK_SECRET`). That webhook carries
 *    metadata only; the body, headers and attachments are fetched from Resend's
 *    Receiving API (lib/resend-inbound.ts) and merged here (`resendMessage`).
 *
 * Everything here is pure (Web Crypto, `atob`), so `bun test` covers it and the
 * HTTP action stays transport only. Raw mail is personal data: it is stored in
 * the internal `inboundEmails` table and never returned by a public function.
 */

/** Hard ceilings. A society's weekly email is ~5–50 KB; these leave room for
 * an attached termcard while keeping one row well under Convex's 1 MiB. */
export const INBOUND_LIMITS = {
  /** A whole request (generic payloads carry base64 attachments). Convex's
   * HTTP action request limit is 20 MiB. */
  maxRequestBytes: 15 * 1024 * 1024,
  /** Characters of body text kept on the row (≤ 400 KB of UTF-8). */
  maxTextChars: 100_000,
  /** HTML bodies larger than this are not stored (the text is kept). */
  maxHtmlBytes: 2 * 1024 * 1024,
  maxAttachmentBytes: 5 * 1024 * 1024,
  maxAttachments: 10,
  maxSubjectChars: 1_000,
  maxFromChars: 500,
  maxMessageIdChars: 998,
  /** Svix's own default tolerance for `svix-timestamp`. */
  signatureToleranceSeconds: 5 * 60,
} as const

/** Attachment types worth keeping: posters and termcards (images, PDF) and
 * calendar invites. Anything else (documents, archives, executables, SVG,
 * which can carry script) is skipped and named in the row's note. */
export const STORED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/calendar",
] as const

export type InboundAttachment = { filename: string; contentType: string; bytes: Uint8Array }

/** One received mail, normalised, before its files are stored. */
export type InboundMessage = {
  messageId: string
  /** The message's own `Date` when plausible, else when it was received. The
   * pipeline resolves "this Wednesday" against it. */
  receivedAt: number
  /** The `From` header as sent (display name and address). */
  from: string
  to: string[]
  subject: string
  text: string
  html?: string
  listId?: string
  listName?: string
  attachments: InboundAttachment[]
  /** Attachments that were not kept, and why (stored as `extractionNote`). */
  skipped: string[]
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

type HeaderMap = Record<string, unknown>

// --- headers ------------------------------------------------------------------------------

/** A header's first value, case-insensitively. Providers send header maps with
 * any capitalisation and sometimes an array per repeated header. */
export function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as HeaderMap)) {
    if (key.toLowerCase() !== wanted) continue
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === "string" && first.trim()) return first.trim()
  }
  return undefined
}

/**
 * `List-Id` (RFC 2919) → `{ listId, listName? }`. `"CU German Society"
 * <soc-cugs.lists.cam.ac.uk>` gives `soc-cugs.lists.cam.ac.uk` and the phrase.
 * Lower-cased: list identifiers are case-insensitive host-like strings.
 */
export function parseListId(raw: string | undefined): { listId?: string; listName?: string } {
  if (!raw) return {}
  const value = raw.replace(/\s+/g, " ").trim()
  const bracketed = /<([^<>\s]+)>\s*$/.exec(value)
  const id = (bracketed ? bracketed[1] : value).toLowerCase()
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(id) || id.length > 255) return {}
  let phrase = bracketed ? value.slice(0, bracketed.index).trim() : ""
  if (phrase.startsWith('"') && phrase.endsWith('"') && phrase.length >= 2) {
    phrase = phrase.slice(1, -1).trim()
  }
  return phrase ? { listId: id, listName: phrase.slice(0, 300) } : { listId: id }
}

/** `<id@host>` with surrounding whitespace removed; angle brackets added when a
 * provider strips them, so one message dedupes the same way on every route. */
export function normaliseMessageId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.replace(/\s+/g, "")
  if (!trimmed || trimmed.length > INBOUND_LIMITS.maxMessageIdChars) return undefined
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed}>`
}

/** Bare addresses from header-ish values (`"Name" <a@b>`, `a@b`, arrays). */
export function addressesIn(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  const found: string[] = []
  for (const item of values) {
    if (typeof item !== "string") continue
    for (const match of item.matchAll(/[^\s<>(),;:"]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      found.push(match[0].toLowerCase())
    }
  }
  return [...new Set(found)]
}

/**
 * Whether a mail was addressed to one of the inbound addresses we accept
 * (`INBOUND_EMAIL_RECIPIENTS`, comma-separated). Unset accepts every recipient
 * — the webhook signature already proves the mail came through our inbox —
 * but setting it to an unguessable local part keeps strangers who learn the
 * receiving domain from posting events.
 */
export function recipientAllowed(allowedRaw: string | undefined, recipients: string[]): boolean {
  const allowed = (allowedRaw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length === 0) return true
  return recipients.some((address) => allowed.includes(address.toLowerCase()))
}

/** A `Date` header as epoch ms, accepted only within a week of `now` (a
 * misconfigured sender clock must not move "this Wednesday" by a year). */
export function plausibleDate(raw: string | undefined, now: number): number | undefined {
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return undefined
  return Math.abs(parsed - now) <= 7 * 24 * 3600 * 1000 ? parsed : undefined
}

// --- bodies -------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  pound: "£",
  euro: "€",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/**
 * Readable text from an HTML mail. Links keep their target in brackets —
 * `Book here (https://…)` — because the booking link of an event usually lives
 * only in an `href`, and the pipeline accepts a URL only if it appears
 * verbatim in the text it extracted from.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_whole, double: string | undefined, single: string | undefined, inner: string) => {
        const href = decodeEntities((double ?? single ?? "").trim())
        const label = inner.replace(/<[^>]+>/g, "").trim()
        if (!/^https?:\/\//i.test(href)) return label
        const shown = decodeEntities(label)
        return shown && shown !== href ? `${label} (${href})` : href
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
  text = decodeEntities(text)
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * The body text to keep. The plain-text part wins unless it is a stub ("View
 * this email in your browser"): marketing tools often send a text part that is
 * a fraction of the HTML. Capped at `maxTextChars`.
 */
export function chooseText(text: string | undefined, html: string | undefined): string {
  const plain = (text ?? "").replace(/\r\n?/g, "\n").trim()
  const fromHtml = html ? htmlToText(html) : ""
  const chosen = plain.length >= 0.2 * fromHtml.length && plain ? plain : fromHtml || plain
  return chosen.slice(0, INBOUND_LIMITS.maxTextChars)
}

// --- base64 -------------------------------------------------------------------------------

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ""))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** The stored MIME type of an attachment, or why it is not stored. */
export function attachmentType(contentType: unknown, size: number): string | { skip: string } {
  const type = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : ""
  if (!(STORED_ATTACHMENT_TYPES as readonly string[]).includes(type)) {
    return { skip: `type ${type || "unknown"} not kept` }
  }
  if (size <= 0) return { skip: "empty" }
  if (size > INBOUND_LIMITS.maxAttachmentBytes)
    return { skip: `larger than ${INBOUND_LIMITS.maxAttachmentBytes} bytes` }
  return type
}

function cleanFilename(raw: unknown): string {
  // Path separators and control characters become "_" (a filename is only a label here).
  const name =
    typeof raw === "string"
      ? Array.from(raw, (char) => (char < " " || char === "/" || char === "\\" ? "_" : char))
          .join("")
          .trim()
      : ""
  return (name || "attachment").slice(0, 200)
}

// --- the provider-agnostic payload ------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * The provider-agnostic JSON body. Required: `messageId`, `from`, `subject`
 * and a body (`text` or `html`). `headers` is a plain object (`List-Id` is read
 * from it); `date` (or a `Date` header) dates the mail.
 */
export function parseGenericPayload(body: unknown, now: number): Parsed<InboundMessage> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" }
  }
  const input = body as Record<string, unknown>
  const messageId = normaliseMessageId(input.messageId)
  if (!messageId) return { ok: false, error: "messageId is required" }
  const from = str(input.from)?.trim()
  if (!from) return { ok: false, error: "from is required" }
  const subject = str(input.subject) ?? ""
  const text = str(input.text)
  const html = str(input.html)
  if (!text?.trim() && !html?.trim()) return { ok: false, error: "text or html is required" }
  const headers = (input.headers ?? {}) as unknown
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    return { ok: false, error: "headers must be an object" }
  }

  const attachments: InboundAttachment[] = []
  const skipped: string[] = []
  const rawAttachments = input.attachments ?? []
  if (!Array.isArray(rawAttachments)) return { ok: false, error: "attachments must be an array" }
  for (const raw of rawAttachments) {
    if (raw === null || typeof raw !== "object") return { ok: false, error: "bad attachment" }
    const item = raw as Record<string, unknown>
    const filename = cleanFilename(item.filename)
    const data = str(item.contentBase64)
    if (data === undefined) return { ok: false, error: `${filename}: contentBase64 is required` }
    if (attachments.length >= INBOUND_LIMITS.maxAttachments) {
      skipped.push(`${filename}: more than ${INBOUND_LIMITS.maxAttachments} attachments`)
      continue
    }
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(data)
    } catch {
      return { ok: false, error: `${filename}: contentBase64 is not base64` }
    }
    const type = attachmentType(item.contentType, bytes.byteLength)
    if (typeof type !== "string") {
      skipped.push(`${filename}: ${type.skip}`)
      continue
    }
    attachments.push({ filename, contentType: type, bytes })
  }

  const toValue = input.to
  return {
    ok: true,
    value: {
      messageId,
      receivedAt: plausibleDate(str(input.date) ?? headerValue(headers, "date"), now) ?? now,
      from: from.slice(0, INBOUND_LIMITS.maxFromChars),
      to: addressesIn(toValue),
      subject: subject.slice(0, INBOUND_LIMITS.maxSubjectChars),
      text: chooseText(text, html),
      html: html || undefined,
      ...parseListId(headerValue(headers, "list-id")),
      attachments,
      skipped,
    },
  }
}

// --- Resend -------------------------------------------------------------------------------

/** What the `email.received` webhook tells us (metadata only). */
export type ResendReceived = {
  emailId: string
  messageId?: string
  from: string
  to: string[]
  subject: string
  createdAt?: number
  attachmentCount: number
}

/**
 * Resend's webhook envelope: `{ type, created_at, data }`. Returns `null` for a
 * well-formed event of another type (the route acknowledges and ignores it).
 */
export function parseResendWebhook(body: unknown): Parsed<ResendReceived | null> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" }
  }
  const event = body as Record<string, unknown>
  if (event.type !== "email.received") return { ok: true, value: null }
  const data = event.data as Record<string, unknown> | undefined
  const emailId = str(data?.email_id)
  if (!data || !emailId || !/^[A-Za-z0-9-]{1,100}$/.test(emailId)) {
    return { ok: false, error: "email.received without a usable data.email_id" }
  }
  const createdAt = Date.parse(str(data.created_at) ?? "")
  return {
    ok: true,
    value: {
      emailId,
      messageId: normaliseMessageId(data.message_id),
      from: str(data.from) ?? "",
      to: [
        ...addressesIn(data.to),
        ...addressesIn(data.cc),
        ...addressesIn(data.bcc),
        ...addressesIn(data.received_for),
      ],
      subject: str(data.subject) ?? "",
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      attachmentCount: Array.isArray(data.attachments) ? data.attachments.length : 0,
    },
  }
}

/** The Receiving API's `GET /emails/receiving/{id}` body, as far as we use it. */
export type ResendEmail = {
  html?: string | null
  text?: string | null
  headers?: Record<string, unknown> | null
  subject?: string | null
  from?: string | null
  message_id?: string | null
  created_at?: string | null
}

/** Webhook metadata + the retrieved email → one message (attachments are
 * added by the caller as it downloads them). */
export function resendMessage(
  received: ResendReceived,
  email: ResendEmail,
  now: number,
): InboundMessage {
  const headers = email.headers ?? {}
  const html = typeof email.html === "string" && email.html ? email.html : undefined
  const messageId =
    received.messageId ??
    normaliseMessageId(email.message_id) ??
    `<resend-${received.emailId}@inbound.invalid>`
  const from = headerValue(headers, "from") ?? email.from ?? received.from
  return {
    messageId,
    receivedAt: plausibleDate(headerValue(headers, "date"), now) ?? received.createdAt ?? now,
    from: (from || "unknown").slice(0, INBOUND_LIMITS.maxFromChars),
    to: received.to,
    subject: (email.subject ?? received.subject ?? "").slice(0, INBOUND_LIMITS.maxSubjectChars),
    text: chooseText(email.text ?? undefined, html),
    html,
    ...parseListId(headerValue(headers, "list-id")),
    attachments: [],
    skipped: [],
  }
}

// --- Svix signature (Resend webhooks) ---------------------------------------------------------

export type SvixHeaders = { id: string; timestamp: string; signature: string }

/** The three `svix-*` headers, or null when any is missing. */
export function svixHeaders(get: (name: string) => string | null): SvixHeaders | null {
  const id = get("svix-id")
  const timestamp = get("svix-timestamp")
  const signature = get("svix-signature")
  return id && timestamp && signature ? { id, timestamp, signature } : null
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Verifies a Svix-signed webhook (https://docs.svix.com/receiving/verifying-payloads/how-manual):
 * HMAC-SHA256, keyed with the base64 part of `whsec_…`, over
 * `${svix-id}.${svix-timestamp}.${raw body}`; `svix-signature` holds one or
 * more space-separated `v1,<base64>` entries, any of which may match; the
 * timestamp must be within `toleranceSeconds` of `nowSeconds` (replays).
 * Compared in constant time. An unset or malformed secret verifies nothing.
 */
export async function verifySvixSignature(
  headers: SvixHeaders,
  body: string,
  secret: string | undefined,
  nowSeconds: number,
  toleranceSeconds: number = INBOUND_LIMITS.signatureToleranceSeconds,
): Promise<boolean> {
  if (!secret) return false
  const timestamp = Number(headers.timestamp)
  if (!/^\d{1,12}$/.test(headers.timestamp) || !Number.isFinite(timestamp)) return false
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  let key: Uint8Array
  try {
    key = base64ToBytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret)
  } catch {
    return false
  }
  if (key.byteLength === 0) return false
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`)
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, signed))
  let matched = false
  for (const entry of headers.signature.split(" ")) {
    const [version, value] = entry.split(",", 2)
    if (version !== "v1" || !value) continue
    let candidate: Uint8Array
    try {
      candidate = base64ToBytes(value)
    } catch {
      continue
    }
    // No early exit: every entry is compared.
    if (constantTimeEqual(candidate, expected)) matched = true
  }
  return matched
}
