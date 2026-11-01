/**
 * What an error report may say (ENG-6; spec "Errors", hard rules 1-2,
 * law report §7): shared by the server sender (lib/posthog-server.ts) and the
 * browser's `before_send` (lib/analytics-client.ts `sanitizeEvent`).
 *
 * An error's message and stack are our code's words, but they can quote what
 * a request carried: a URL with its query string (a search someone typed), or
 * an email address (a sign-in, a request form). Both go, wherever they appear:
 *
 *  - every URL loses its query string and fragment (`https://x/a?q=1#b` →
 *    `https://x/a`, `/talks?q=1` → `/talks`);
 *  - every email address becomes `[email]`;
 *  - text is capped at `MAX_TEXT` characters.
 *
 * In a PostHog exception list (`$exception_list`, posthog's own format,
 * @posthog/core `ErrorProperties`) the type and message are scrubbed, frame
 * file names keep their path only, and frames lose source context lines and
 * variables: a report carries the error's type, message and where in our code
 * it happened, nothing else (the privacy notice; record of processing P11,
 * P12). Pure TypeScript, no SDK imports.
 */

/** Longest message, type or stack line kept, in characters. */
export const MAX_TEXT = 2000

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/** A URL (`scheme://…`) or a path (`/…`) up to its query string or fragment,
 * then the query string / fragment itself, which goes. */
const URL_TAIL = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s?#"'`<>()[\]]*)[?#][^\s"'`<>()[\]]*/gi

/** `text` without query strings, fragments or email addresses, capped. */
export function scrubErrorText(text: string): string {
  return text.replace(URL_TAIL, "$1").replace(EMAIL, "[email]").slice(0, MAX_TEXT)
}

/** A frame's file name or URL with its path only (no query string or fragment). */
export function stripUrlTail(value: string): string {
  return value.split(/[?#]/)[0] ?? ""
}

/** Frame fields dropped: source lines around the frame and local variables. */
const DROPPED_FRAME_FIELDS = ["context_line", "pre_context", "post_context", "vars"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function scrubFrame(frame: Record<string, unknown>): void {
  for (const field of DROPPED_FRAME_FIELDS) delete frame[field]
  for (const field of ["filename", "abs_path"] as const) {
    const value = frame[field]
    if (typeof value === "string") frame[field] = stripUrlTail(value)
  }
  for (const field of ["function", "module"] as const) {
    const value = frame[field]
    if (typeof value === "string") frame[field] = scrubErrorText(value)
  }
}

/**
 * Scrubs a `$exception_list` in place (also returns it): each exception's
 * `type`, `value` and `module`, and each stack frame (see the module comment).
 * Anything that is not a list of objects is returned as an empty list, so a
 * malformed report says nothing rather than something unscrubbed.
 */
export function scrubExceptionList(list: unknown): unknown[] {
  if (!Array.isArray(list)) return []
  const kept = list.filter(isRecord)
  for (const exception of kept) {
    for (const field of ["type", "value", "module"] as const) {
      const value = exception[field]
      if (typeof value === "string") exception[field] = scrubErrorText(value)
    }
    const stacktrace = exception.stacktrace
    if (isRecord(stacktrace) && Array.isArray(stacktrace.frames)) {
      stacktrace.frames = stacktrace.frames.filter(isRecord)
      for (const frame of stacktrace.frames as Record<string, unknown>[]) scrubFrame(frame)
    }
  }
  return kept
}

/**
 * Scrubs every exception property of an event in place: `$exception_list`
 * (above) and any other string `$exception_*` property (older SDKs' flat
 * `$exception_message`, `$exception_type`, …). `$exception_steps`
 * (breadcrumbs, free-form) is removed.
 */
export function scrubExceptionProps(props: Record<string, unknown>): void {
  for (const key of Object.keys(props)) {
    if (!key.startsWith("$exception")) continue
    const value = props[key]
    if (key === "$exception_list") props[key] = scrubExceptionList(value)
    else if (key === "$exception_steps") delete props[key]
    else if (typeof value === "string") props[key] = scrubErrorText(value)
  }
}
