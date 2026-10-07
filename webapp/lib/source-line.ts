import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { formatInstantDate } from "./calendar"
import type { ClaimMethod, FieldStatus, MissingReason } from "./vocab"

/**
 * What the `SourceLine` under every public fact says (PLAN §2.3; data-model §1,
 * §7), as a pure function of the field's public `meta` entry:
 *
 *  - a status chip — found / inferred / owner-confirmed / edited / conflicting;
 *  - where it came from — the source host, linked, or "private source" when the
 *    projection withheld the URL (mailing list, manual entry);
 *  - when it was read, the rule-based confidence, how many independent sources
 *    agree;
 *  - for a conflict, every other reading with its own source;
 *  - for a missing value, an honest reason instead of a blank.
 *
 * `not_applicable` renders nothing: a non-sports society has no Blue status.
 */

export type PublicFieldMeta = NonNullable<
  FunctionReturnType<typeof api.orgs.getBySlug>
>["org"]["meta"][string]

export type SourceTone = "positive" | "neutral" | "caution" | "muted"

export type SourceRef =
  /** A public page: link to it. */
  | { kind: "link"; url: string; host: string }
  /** The projection removed the URL: an inbox or a manual entry. */
  | { kind: "private" }

export type ConflictReading = {
  value: string
  source: SourceRef
  retrievedOn?: string
}

export type SourceLineModel =
  | { kind: "hidden" }
  | { kind: "missing"; label: string; detail: string }
  | {
      kind: "known"
      status: Exclude<FieldStatus, "missing" | "not_applicable">
      label: string
      description: string
      tone: SourceTone
      source: SourceRef
      retrievedOn?: string
      /** 0–100, rounded. */
      confidence?: number
      /** Independent sources (distinct hosts) that agree, when more than one. */
      agreeing?: number
      method?: ClaimMethod
      conflicts: ConflictReading[]
    }

const KNOWN: Record<
  Exclude<FieldStatus, "missing" | "not_applicable">,
  { label: string; description: string; tone: SourceTone }
> = {
  found: {
    label: "Found",
    description: "Read from a published source.",
    tone: "positive",
  },
  inferred: {
    label: "Inferred",
    description: "Worked out from a source that does not state it word for word.",
    tone: "caution",
  },
  owner_confirmed: {
    label: "Owner-confirmed",
    description: "Confirmed by the society itself.",
    tone: "positive",
  },
  manual: {
    label: "Edited",
    description: "Set by the camsocs editor.",
    tone: "neutral",
  },
  conflicting: {
    label: "Conflicting",
    description: "Sources disagree; every reading is shown.",
    tone: "caution",
  },
}

const MISSING: Record<MissingReason, { label: string; detail: string }> = {
  not_found: {
    label: "Not published yet",
    detail: "We looked, and no source we use publishes this.",
  },
  not_published: {
    label: "Not published yet",
    detail: "No public source gives this.",
  },
  access_restricted: {
    label: "Not public",
    detail: "The only source is restricted to members, so we did not read it.",
  },
  unreachable: {
    label: "Source unreachable",
    detail: "The source could not be reached when we last tried.",
  },
  not_attempted: {
    label: "Not checked yet",
    detail: "No source has been read for this yet.",
  },
}

/** The host to show for a URL: lowercase, without `www.`. Null when it is not
 * an http(s) URL — which the public projection never sends, but a link we
 * render must be safe whatever arrives. */
export function displayHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed.hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return null
  }
}

function sourceRef(url: string | undefined): SourceRef {
  const host = url === undefined ? null : displayHost(url)
  return url !== undefined && host !== null ? { kind: "link", url, host } : { kind: "private" }
}

/** A claimed value as one line of text, for a conflicting reading. */
export function formatReading(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(formatReading).join(", ")
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["url", "email", "signupUrl", "label", "name"]) {
      if (typeof record[key] === "string") return record[key] as string
    }
    return JSON.stringify(value)
  }
  return String(value)
}

export function sourceLine(meta: PublicFieldMeta | undefined): SourceLineModel {
  // Every claimable field has a meta entry; a missing one means nobody looked.
  if (meta === undefined) return { kind: "missing", ...MISSING.not_attempted }
  if (meta.status === "not_applicable") return { kind: "hidden" }
  if (meta.status === "missing") {
    return { kind: "missing", ...MISSING[meta.missingReason ?? "not_found"] }
  }
  const known = KNOWN[meta.status]
  return {
    kind: "known",
    status: meta.status,
    ...known,
    source: sourceRef(meta.sourceUrl),
    retrievedOn: meta.retrievedAt === undefined ? undefined : formatInstantDate(meta.retrievedAt),
    confidence: meta.confidence === undefined ? undefined : Math.round(meta.confidence * 100),
    agreeing: meta.claimCount !== undefined && meta.claimCount > 1 ? meta.claimCount : undefined,
    method: meta.method,
    conflicts: (meta.conflicts ?? []).map((reading) => ({
      value: formatReading(reading.value),
      source: sourceRef(reading.sourceUrl),
      retrievedOn: formatInstantDate(reading.retrievedAt),
    })),
  }
}

/** Whether a field has a value worth rendering (its status is not missing or
 * not-applicable). */
export function hasValue(meta: PublicFieldMeta | undefined): boolean {
  return meta !== undefined && meta.status !== "missing" && meta.status !== "not_applicable"
}
