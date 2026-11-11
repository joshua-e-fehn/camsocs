"use client"

import {
  BotIcon,
  CalendarDaysIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MailIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  type BrokerListingRequest,
  runWithToast,
  useListingRequestMutations,
  useRequestAgent,
  useSetListingRequestStatus,
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

type SiteEvent = { title: string; startsAt: number; venue?: string }

function EventList({ events, total }: { events: SiteEvent[]; total: number }) {
  if (events.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {events.map((event) => (
        <li key={`${event.title}-${event.startsAt}`} className="flex flex-wrap gap-x-2">
          <span className="font-mono text-xs text-muted-foreground">
            {formatDateTime(event.startsAt)}
          </span>
          <span>{event.title}</span>
          {event.venue && <span className="text-muted-foreground">· {event.venue}</span>}
        </li>
      ))}
      {total > events.length && (
        <li className="text-xs text-muted-foreground">and {total - events.length} more</li>
      )}
    </ul>
  )
}

/**
 * The plan behind a draft that names the society's events page (ENG-158):
 * what confirming will do, and what the agent found when it read the site by
 * the scraper's rules (convex/lib/requestDraft.ts, pipeline request_site.py).
 */
function EventsPlan({ draft }: { draft: RequestDraft }) {
  const source = draft.eventsSource
  if (!source) return null
  const check = source.check
  const website = draft.corrections?.find((item) => item.field === "website")
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CalendarDaysIcon className="size-3.5" />
        Plan
      </p>
      <ol className="list-decimal pl-5">
        {website && (
          <li className="break-words">
            Set the listing&apos;s website to <span className="font-mono">{website.text}</span>
          </li>
        )}
        <li className="break-words">
          Read the society&apos;s events from <span className="font-mono">{source.url}</span> every
          day, starting now
        </li>
        <li>Report here what was added, with a reply to send</li>
      </ol>
      {!check ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          The agent is reading the site (about a minute)…
        </p>
      ) : check.state === "failed" ? (
        <p className="text-xs text-destructive">
          The agent could not read the site ({check.error ?? "error"}, try {check.attempts} of 3).
          Confirming would still add the website; its events may not be readable.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Check
              ok={check.ownSite === true}
              label={
                check.ownSite
                  ? `The society's own site: ${check.tiedBy ?? "shown"}`
                  : "Not shown to be this society's site: check it"
              }
            />
            <Check
              ok={(check.eventCount ?? 0) > 0}
              label={`${check.eventCount ?? 0} upcoming event${check.eventCount === 1 ? "" : "s"} found`}
            />
          </div>
          <EventList events={check.events ?? []} total={check.eventCount ?? 0} />
          {(check.eventCount ?? 0) === 0 && (
            <p className="text-xs text-muted-foreground">
              The reader finds no upcoming event on this site today. Confirming still adds the
              website; if the page does list events, the reader needs work.
            </p>
          )}
          {(check.notes?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">{check.notes?.join("; ")}</p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The work a confirmed plan started (ENG-158, `listingRequests.job`): queued,
 * running on the VPS, done with what was added, or failed with a way to run
 * it again. Done, the broker looks at the listing and closes the request.
 */
export function RequestJobPanel({ request }: { request: BrokerListingRequest }) {
  const { retryJob } = useListingRequestMutations()
  const setStatus = useSetListingRequestStatus()
  const job = request.job
  if (!job) return null
  const listing = request.org ? `/societies/${request.org.slug}` : null

  if (job.state === "queued" || job.state === "running") {
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
        <Spinner className="size-4" />
        {job.state === "queued"
          ? "In progress: waiting for the scraper to pick this up (within a minute, or after a running harvest)."
          : `In progress: reading ${job.website} and loading its events (about 15 minutes).`}
        {job.error && (
          <span className="text-xs text-muted-foreground">
            Last try: {job.error} (try {job.attempts} of 3)
          </span>
        )}
      </p>
    )
  }

  if (job.state === "failed") {
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
        <TriangleAlertIcon className="size-4" />
        Not implemented: the scraper run failed ({job.error ?? "error"}) after {job.attempts} tries.
        The website is on the listing; its events are not.
        <Button
          size="sm"
          variant="outline"
          onClick={() => runWithToast(retryJob({ key: request.key }), "Queued again")}
        >
          <RefreshCwIcon />
          Run again
        </Button>
      </p>
    )
  }

  const count = job.eventCount ?? 0
  return (
    <section
      aria-label="Result"
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-sm"
    >
      <p className="flex flex-wrap items-center gap-2 font-medium">
        <CircleCheckIcon className="size-4" />
        Implemented {formatDateTime(job.finishedAt)}: {job.website} is read every day,{" "}
        {count === 0
          ? "no upcoming event found yet"
          : `${count} upcoming event${count === 1 ? "" : "s"} on the listing`}
        .
      </p>
      <EventList events={job.events ?? []} total={count} />
      <div className="flex flex-wrap gap-2">
        {listing && (
          <Button size="sm" variant="outline" asChild>
            <Link href={listing} target="_blank" prefetch={false}>
              <ExternalLinkIcon />
              Look at the listing
            </Link>
          </Button>
        )}
        {request.status === "accepted" && (
          <Button
            size="sm"
            onClick={() =>
              runWithToast(setStatus({ key: request.key, status: "done" }), "Request closed")
            }
          >
            <CheckIcon />
            Confirm and close
          </Button>
        )}
      </div>
    </section>
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
      <EventsPlan draft={draft} />
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
