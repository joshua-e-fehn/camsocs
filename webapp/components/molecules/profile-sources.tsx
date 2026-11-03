import { ExternalLink } from "@/components/molecules/external-link"
import { formatInstantDate } from "@/lib/calendar"
import type { ProfileSource } from "@/lib/directory-profile"

/**
 * A listing's sources as a plain list at the foot of its profile: each page
 * a fact came from, linked, with the facts it backs and the date it was read
 * (SEO audit 2026-11-02, provenance-not-crawlable). The per-section
 * "Sourced" chips keep the full SourceLine one tap away; this puts the same
 * links in the server's HTML, where a crawler or an answer engine can check
 * "every fact links to the page it came from". Links keep `noreferrer`
 * (owner decision G7).
 */
export function ProfileSources({ sources }: { sources: ProfileSource[] }) {
  if (sources.length === 0) return null
  return (
    <ol className="flex flex-col divide-y text-sm">
      {sources.map((source) => (
        <li key={source.url} className="flex flex-col gap-0.5 py-2.5">
          <ExternalLink
            href={source.url}
            className="self-start font-medium"
            outbound={{ kind: "source" }}
          >
            {source.host}
          </ExternalLink>
          <p className="text-muted-foreground">
            {source.fields.join(", ")}
            {source.retrievedAt !== undefined && (
              <>
                {" · read "}
                <time
                  dateTime={new Date(source.retrievedAt).toISOString()}
                  className="font-mono text-xs"
                >
                  {formatInstantDate(source.retrievedAt)}
                </time>
              </>
            )}
          </p>
        </li>
      ))}
    </ol>
  )
}
