"use client"

import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  MailIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  type BrokerListingRequest,
  runWithToast,
  useListingRequestMutations,
  useRequestAgent,
} from "@/hooks/convex/broker"
import { formatDateTime } from "@/lib/broker/format"

export type RequestDraft = NonNullable<BrokerListingRequest["draft"]>

/** Kinds the request agent drafts (convex/lib/requestDraft.ts `DRAFT_KINDS`). */
const DRAFTED = new Set(["claim", "correct", "remove", "object"])

/** Whether the agent drafts this request at all. */
export function isDrafted(request: BrokerListingRequest): boolean {
  if (!DRAFTED.has(request.kind)) return false
  if ((request.kind === "claim" || request.kind === "correct") && !request.orgKey) return false
  return request.status === "open" || request.draft !== undefined
}

/** The draft, when it is ready to pre-fill the dialog. */
export function readyDraft(request: BrokerListingRequest): RequestDraft | null {
  return request.draft?.state === "ready" ? request.draft : null
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant="outline" className={ok ? undefined : "text-muted-foreground"}>
      {ok ? <CheckIcon /> : <XIcon />}
      {label}
    </Badge>
  )
}

/**
 * The request agent's draft on a request card (ENG-126): what the request
 * asks, the facts about the sender (by rule), the agent's concerns, and a
 * reply to send. The values themselves are in the accept dialog, which the
 * draft pre-fills; nothing is applied until the broker confirms there.
 */
export function RequestDraftPanel({ request }: { request: BrokerListingRequest }) {
  const agent = useRequestAgent()
  const { redraft } = useListingRequestMutations()
  const draft = request.draft
  const open = request.status === "open"
  const redo = open && (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-xs"
      onClick={() => runWithToast(redraft({ key: request.key }), "Drafting again")}
    >
      <RefreshCwIcon />
      Redraft
    </Button>
  )

  if (!draft) {
    if (!open) return null
    const offline = !agent || agent.stale
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {offline ? <BotIcon className="size-3.5" /> : <Spinner className="size-3.5" />}
        {!agent
          ? "The request agent has not run yet: review by hand, or wait for its draft."
          : agent.stale
            ? `The request agent is offline (last seen ${formatDateTime(agent.lastSeenAt)}).`
            : "The agent is drafting this request (about a minute)…"}
      </p>
    )
  }

  if (draft.state === "failed") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        <BotIcon className="size-3.5" />
        The agent could not draft this request ({draft.error ?? "error"}, try {draft.attempts} of 3)
        {draft.attempts < 3 ? "; it tries again in a few minutes." : "."}
        {redo}
      </p>
    )
  }

  const checks = draft.checks
  const mailto = `mailto:${encodeURIComponent(request.submitterEmail)}?subject=${encodeURIComponent(
    "Your CAMsocs request",
  )}&body=${encodeURIComponent(draft.reply ?? "")}`

  return (
    <section
      aria-label="Agent draft"
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <BotIcon className="size-3.5" />
        <span>
          Agent draft · {formatDateTime(draft.at)}
          {draft.model ? ` · ${draft.model}` : ""}
        </span>
        {redo}
      </div>
      {draft.summary && <p>{draft.summary}</p>}
      {checks && (
        <div className="flex flex-wrap gap-1.5">
          <Check ok={checks.cam} label={checks.cam ? "cam.ac.uk address" : checks.domain} />
          <Check
            ok={checks.listed}
            label={checks.listed ? "Address on the listing" : "Address not on the listing"}
          />
          {checks.siteDomain && <Check ok label="Domain of the listing's website" />}
          {request.role && <Check ok label={`Says: ${request.role}`} />}
        </div>
      )}
      {(draft.concerns?.length ?? 0) > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Check before confirming</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {draft.concerns?.map((concern) => (
                <li key={concern}>{concern}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {draft.reply && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Draft reply to the sender
          </summary>
          <p className="mt-2 rounded-md border bg-background p-3 whitespace-pre-wrap">
            {draft.reply}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                runWithToast(navigator.clipboard.writeText(draft.reply ?? ""), "Reply copied")
              }
            >
              <CopyIcon />
              Copy
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={mailto}>
                <MailIcon />
                Open in mail
              </a>
            </Button>
          </div>
        </details>
      )}
    </section>
  )
}
