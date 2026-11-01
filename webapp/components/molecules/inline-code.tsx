/**
 * A short literal inside running text (a user-agent string, a storage name),
 * set in mono on a muted ground. Used by the About and Privacy pages.
 */
export function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">{children}</code>
}
