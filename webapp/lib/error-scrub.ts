/**
 * What an error report may say (ENG-6; spec "Errors", hard rules 1-2,
 * law report §7): shared by the server sender (lib/posthog-server.ts) and the
 * browser's `before_send` (lib/analytics-client.ts `sanitizeEvent`).
 *
 * An error's message and stack are our code's words, but they can quote what
 * a request carried: a URL with its query string (a search someone typed), or
 * an email address (a sign-in, a request form). Both go, wherever they appear:
 *
 *  - every query string and fragment goes, up to the next whitespace
 *    (`https://x/a?q=1#b` → `https://x/a`, `/talks?q=1` → `/talks`,
 *    `talks?q=a(b)` → `talks`). This fails closed: whatever follows a `?` in
 *    the same word goes with it, quotes and brackets included, because a
 *    browser leaves `(`, `)`, `[`, `]` and `'` unencoded in a query. A `#`
 *    stays at the start of a word or after a `.` (`#x`, `Foo.#bar`: private
 *    fields in stack lines), where it is not a fragment;
 *  - every email address, `@` or URL-encoded `%40`, becomes `[email]`;
 *  - text is capped at `MAX_TEXT` characters. Only the first `MAX_TEXT` plus
 *    a small margin is scanned at all, so a long message or path costs
 *    linear time at worst (no regex backtracking over megabytes).
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

const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi

/** A query string: `?` and the rest of its word. */
const QUERY = /\?\S+/g

/** A fragment: `#` and the rest of its word, unless the `#` starts the word
 * or follows a `.` (a private field such as `Foo.#bar`). */
const FRAGMENT = /([^\s.])#\S+/g

/** Characters scanned beyond `MAX_TEXT`, so an email address or query string
 * that straddles the cap is still recognised whole before the cut. */
const SCAN_MARGIN = 256

/** `text` without query strings, fragments or email addresses, capped. */
export function scrubErrorText(text: string): string {
  return text
    .slice(0, MAX_TEXT + SCAN_MARGIN)
    .replace(QUERY, "")
    .replace(FRAGMENT, "$1")
    .replace(EMAIL, "[email]")
    .slice(0, MAX_TEXT)
}

/** A frame's file name or URL with its path only (no query string or fragment). */
export function stripUrlTail(value: string): string {
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : value.slice(0, cut)
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
