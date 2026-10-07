/**
 * Who may read and write brokering data — the pure half of the decision.
 *
 * The allowlist is the Convex env var `BROKER_EMAILS`, a comma-separated list
 * of addresses, read by `requireBrokerUser` in convex/lib/auth.ts. An env var
 * rather than a compile-time constant (salo-ba's choice) because who brokers is
 * an operational decision that should not need a deploy, while still being
 * invisible to the browser: Convex env vars never reach the client bundle.
 *
 *   bunx convex env set BROKER_EMAILS "you@example.com,colleague@example.com"
 *
 * ⚠ Unset or empty means **nobody**. Env vars are per deployment, so forgetting
 * this on production is a live possibility, and the failure has to be a locked
 * door rather than an open one — the same rule as `PIPELINE_API_KEY`.
 *
 * Comparison is trim + lowercase on both sides, and nothing cleverer (salo-ba
 * lib/allowlist.ts): no Gmail dot-stripping, no `+tag` removal. Every such
 * transformation makes the list accept strings that are not literally on it.
 *
 * No server imports, so it is unit-testable with `bun test` and importable from
 * both Convex and (if ever needed for a courtesy message) the client.
 */

/** The canonical form of an address for comparison. Non-strings become "",
 * which matches nothing. */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") return ""
  return email.trim().toLowerCase()
}

/** The allowlist parsed from the raw env value. Empty entries are dropped, so
 * `"a@x.com,,"` and `" , "` cannot smuggle in an empty-string match. */
export function parseBrokerEmails(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter((entry) => entry !== ""),
  )
}

/** Whether `email` is on the allowlist `raw`. False for every input when the
 * list is unset or empty. */
export function isBrokerEmail(email: unknown, raw: string | undefined): boolean {
  const normalized = normalizeEmail(email)
  if (normalized === "") return false
  return parseBrokerEmails(raw).has(normalized)
}
