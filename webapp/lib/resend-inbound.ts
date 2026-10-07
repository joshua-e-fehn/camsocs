import {
  attachmentType,
  INBOUND_LIMITS,
  type InboundAttachment,
  type ResendEmail,
} from "./inbound-email"

/**
 * Resend's Receiving API — the half of an inbound mail its webhook leaves out.
 *
 * Resend's `email.received` webhook carries metadata only; the body, headers
 * and attachments are fetched afterwards (checked 2026-10-07):
 *
 *  - `GET https://api.resend.com/emails/receiving/{email_id}` → `{ html, text,
 *    headers, … }`. `?html_format=cid` keeps inline images as `cid:` references
 *    instead of base64 data URIs, so the HTML stays small.
 *  - `GET https://api.resend.com/emails/receiving/{email_id}/attachments` →
 *    `{ data: [{ id, filename, size, content_type, download_url, expires_at }] }`;
 *    each `download_url` is a signed URL valid for an hour.
 *
 * Both need an API key with full access (a sending-only key is refused). The
 * `fetch` is injected so the Convex HTTP action passes the runtime's and tests
 * pass a fake.
 */

export const RESEND_API = "https://api.resend.com"

const USER_AGENT = "camsocs-inbound/0.1 (+https://camsocs.vercel.app/about)"

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class ResendError extends Error {
  constructor(
    message: string,
    /** Worth a retry: the webhook answers 5xx so Resend delivers it again. */
    readonly transient: boolean,
  ) {
    super(message)
  }
}

async function getJson(fetchImpl: Fetch, url: string, apiKey: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
    })
  } catch (error) {
    throw new ResendError(`Resend unreachable: ${String(error)}`, true)
  }
  if (!response.ok) {
    // 429 and 5xx are worth retrying; 401/403/404 are configuration problems
    // that a retry in a few hours may also fix (a key added late), so they are
    // reported as transient too — Resend gives up after ~28 hours either way.
    throw new ResendError(`Resend answered ${response.status} for ${url}`, true)
  }
  return await response.json()
}

/** `GET /emails/receiving/{id}` — the body and headers of one received mail. */
export async function fetchReceivedEmail(
  fetchImpl: Fetch,
  apiKey: string,
  emailId: string,
): Promise<ResendEmail> {
  const body = await getJson(
    fetchImpl,
    `${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
    apiKey,
  )
  if (body === null || typeof body !== "object") {
    throw new ResendError("Resend returned no email object", true)
  }
  return body as ResendEmail
}

type AttachmentMeta = {
  filename?: unknown
  size?: unknown
  content_type?: unknown
  download_url?: unknown
}

/**
 * Downloads the attachments worth keeping (lib/inbound-email.ts
 * `STORED_ATTACHMENT_TYPES`, ≤ `maxAttachmentBytes`, at most
 * `maxAttachments`), checking the declared size before downloading and the
 * real size after. Returns the kept files and a note per skipped one.
 */
export async function fetchReceivedAttachments(
  fetchImpl: Fetch,
  apiKey: string,
  emailId: string,
): Promise<{ attachments: InboundAttachment[]; skipped: string[] }> {
  const body = (await getJson(
    fetchImpl,
    `${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
    apiKey,
  )) as { data?: AttachmentMeta[] } | null
  const attachments: InboundAttachment[] = []
  const skipped: string[] = []
  for (const meta of body?.data ?? []) {
    const filename =
      typeof meta.filename === "string" && meta.filename.trim()
        ? meta.filename.trim().slice(0, 200)
        : "attachment"
    if (attachments.length >= INBOUND_LIMITS.maxAttachments) {
      skipped.push(`${filename}: more than ${INBOUND_LIMITS.maxAttachments} attachments`)
      continue
    }
    const declared = typeof meta.size === "number" ? meta.size : 1
    const type = attachmentType(meta.content_type, declared)
    if (typeof type !== "string") {
      skipped.push(`${filename}: ${type.skip}`)
      continue
    }
    const url = typeof meta.download_url === "string" ? meta.download_url : ""
    if (!url.startsWith("https://")) {
      skipped.push(`${filename}: no download URL`)
      continue
    }
    let response: Response
    try {
      response = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } })
    } catch (error) {
      throw new ResendError(`Attachment download failed: ${String(error)}`, true)
    }
    if (!response.ok) {
      throw new ResendError(`Attachment download answered ${response.status}`, true)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > INBOUND_LIMITS.maxAttachmentBytes) {
      skipped.push(`${filename}: ${bytes.byteLength} bytes`)
      continue
    }
    attachments.push({ filename, contentType: type, bytes })
  }
  return { attachments, skipped }
}
