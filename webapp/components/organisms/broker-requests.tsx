"use client"

import {
  ArrowLeftIcon,
  BanIcon,
  BellIcon,
  BellRingIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  InboxIcon,
  LoaderIcon,
  ShieldXIcon,
  UndoIcon,
} from "lucide-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import {
  AcceptCorrectionsDialog,
  AcceptRemovalDialog,
} from "@/components/organisms/broker-request-dialogs"
import {
  isDrafted,
  progressLabel,
  RequestDetails,
  RequestDraftPanel,
  RequestJobPanel,
  readyDraft,
} from "@/components/organisms/broker-request-draft"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type BrokerListingRequest,
  type BrokerSuppression,
  runWithToast,
  useBrokerListingRequests,
  useBrokerOrgMutations,
  useBrokerSuppressions,
  useListingRequestMutations,
  useNotificationTest,
  useRequestNotifications,
  useSetListingRequestStatus,
} from "@/hooks/convex/broker"
import { formatDateTime, humanize } from "@/lib/broker/format"
import { cn } from "@/lib/utils"
import {
  LISTING_REQUEST_STATUSES,
  ORGANISATION_FIELD_LABELS,
  type OrganisationField,
  SUPPRESSION_SCOPE_LABELS,
} from "@/lib/vocab"

/** `active` is the inbox: open requests and those in progress, which stay
 * until the broker closes them (ENG-158). */
type Filter = BrokerListingRequest["status"] | "active" | "all"

const FILTER_LABEL: Partial<Record<Filter, string>> = { active: "Inbox", open: "Open only" }

const KIND_HINT: Record<BrokerListingRequest["kind"], string> = {
  claim: "Wants to manage the listing",
  correct: "Proposes corrections",
  remove: "Asks for the listing to be removed",
  object: "Objects to the processing",
  add: "Asks for a new listing",
}

/**
 * The inbox of requests from the public claim / correct / remove / object /
 * add form, and where they are accepted. The request agent (ENG-126) drafts
 * each open claim, correction, removal and objection (`RequestDraftPanel`)
 * and its draft pre-fills the dialogs, so accepting is a review and a
 * confirm. A request that points to the society's events page gets a plan
 * with what the agent found on the site; confirmed, the VPS reads the site
 * and the card reports what was added, to be closed (`RequestJobPanel`,
 * ENG-158). A claim or correction's values
 * become owner-confirmed claims (`AcceptCorrectionsDialog`); a removal or
 * objection becomes a suppression of the listing, some fields, an address or
 * named people (`AcceptRemovalDialog`), listed on the card with a way to lift
 * one made in error.
 */
export function BrokerRequests() {
  // `?request=<key>`: the link in a notification (ENG-104) opens that request.
  const focus = useSearchParams().get("request")
  const [filter, setFilter] = useState<Filter>("active")
  const requests = useBrokerListingRequests(focus || filter === "all" ? undefined : filter)

  if (focus) return <FocusedRequest requestKey={focus} requests={requests} />

  return (
    <>
      <BrokerPageHeader
        title="Requests"
        description="Claims, corrections, removals and objections from the listing form."
      >
        <TestNotificationButton />
      </BrokerPageHeader>
      <NotificationChannels />
      <ToggleGroup
        type="single"
        variant="outline"
        value={filter}
        onValueChange={(value) => value && setFilter(value as Filter)}
        aria-label="Status"
      >
        {(["active", ...LISTING_REQUEST_STATUSES] as const).map((status) => (
          <ToggleGroupItem key={status} value={status}>
            {FILTER_LABEL[status] ?? humanize(status)}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="all">All</ToggleGroupItem>
      </ToggleGroup>

      {requests === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : requests.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Inbox clear</EmptyTitle>
            <EmptyDescription>
              {filter === "active"
                ? "Nothing open or in progress."
                : `No ${filter === "all" ? "" : `${humanize(filter).toLowerCase()} `}requests.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {requests.map((request) => (
            <RequestCard key={request.key} request={request} />
          ))}
        </div>
      )}
    </>
  )
}

/** One request, opened from a notification's link. */
function FocusedRequest({
  requestKey,
  requests,
}: {
  requestKey: string
  requests: BrokerListingRequest[] | undefined
}) {
  const request = requests?.find((row) => row.key === requestKey)
  return (
    <>
      <BrokerPageHeader title="Request" description={`Opened from a notification · ${requestKey}`}>
        <Button size="sm" variant="outline" asChild>
          <Link href="/dashboard/requests" prefetch={false}>
            <ArrowLeftIcon />
            All requests
          </Link>
        </Button>
      </BrokerPageHeader>
      {requests === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : request ? (
        <RequestCard request={request} highlighted />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Request not found</EmptyTitle>
            <EmptyDescription>
              It may have been removed by the retention job, or the link is wrong.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  )
}

const CHANNEL_LABEL = { slack: "Slack", email: "Email", whatsapp: "WhatsApp" } as const

/** Where a new request is announced (docs/deploy.md "Request notifications"). */
function NotificationChannels() {
  const { channels } = useRequestNotifications()
  if (!channels) return null
  const relay = channels.relay
  const via =
    relay && relay.channels.length > 0
      ? `${relay.channels.map((c) => CHANNEL_LABEL[c]).join(" and ")} through Mya${
          relay.stale ? ` (relay silent since ${formatDateTime(relay.lastSeenAt)})` : ""
        }`
      : null
  const on = [via, channels.email && "email"].filter(Boolean)
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground",
        relay?.stale && "text-destructive",
      )}
    >
      <BellIcon className="size-4" />
      {on.length > 0
        ? `New requests are announced on ${on.join(", ")}.`
        : "No notification channel is set up yet: new requests show only here and in the hourly Slack summary."}
    </p>
  )
}

function TestNotificationButton() {
  const { channels, sendTest } = useRequestNotifications()
  const [testKey, setTestKey] = useState<string | null>(null)
  const results = useNotificationTest(testKey)
  const expected = [
    ...(channels?.relay && !channels.relay.stale ? channels.relay.channels : []),
    ...(channels?.email ? (["email"] as const) : []),
  ]
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={expected.length === 0}
        title={
          expected.length > 0
            ? "Sends a marked test request on every channel"
            : "No channel is set up"
        }
        onClick={async () => {
          const key = await runWithToast(
            sendTest({}),
            "Test queued: Slack and WhatsApp send within a minute",
          )
          if (key) setTestKey(key)
        }}
      >
        <BellRingIcon />
        Send test notification
      </Button>
      {testKey && (
        <span className="text-xs text-muted-foreground">
          {expected
            .map((channel) => {
              const r = results?.find((d) => d.channel === channel)
              return `${CHANNEL_LABEL[channel]} ${r ? (r.ok ? "✓" : `✗ ${r.error ?? ""}`) : "…"}`
            })
            .join(" · ")}
        </span>
      )}
    </div>
  )
}

/** Where the request's notification went, and a way to send it again. */
function NotificationLine({ request }: { request: BrokerListingRequest }) {
  const { notifyAgain } = useRequestNotifications()
  const deliveries = request.notifications ?? []
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <BellIcon className="size-3.5" />
      {deliveries.length === 0
        ? "No notification sent"
        : deliveries.map((d) => (
            <span key={d.channel} className={d.ok ? undefined : "text-destructive"}>
              {CHANNEL_LABEL[d.channel]} {d.ok ? "✓" : `✗ ${d.error ?? ""}`}
            </span>
          ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => runWithToast(notifyAgain({ key: request.key }), "Notification sent again")}
      >
        Notify again
      </Button>
    </p>
  )
}

function RequestCard({
  request,
  highlighted = false,
}: {
  request: BrokerListingRequest
  highlighted?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "start" })
  }, [highlighted])
  const { setHidden, updateProfile } = useBrokerOrgMutations()
  const [dialog, setDialog] = useState<"corrections" | "removal" | null>(null)
  const removal = request.kind === "remove" || request.kind === "object"
  const correction = request.kind === "claim" || request.kind === "correct"
  const fields = Object.entries(request.fields ?? {})
  const applied = request.outcome?.appliedFields ?? []
  const progress = progressLabel(request)
  const working = request.job?.state === "queued" || request.job?.state === "running"

  return (
    <Card
      ref={ref}
      id={request.key}
      className={cn(highlighted && "ring-2 ring-primary ring-offset-2")}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant={removal ? "destructive" : "secondary"}>{request.kind}</Badge>
          {request.org ? (
            <Link
              href={`/dashboard/organisations?org=${request.org.key}`}
              className="underline-offset-4 hover:underline"
            >
              {request.org.name}
            </Link>
          ) : (
            // A correction about a University event may name no listing
            // (event-correction-no-org).
            <span>{request.orgKey ?? (request.kind === "add" ? "New listing" : "No listing")}</span>
          )}
          {request.org?.hidden && (
            <Badge variant="outline">
              <EyeOffIcon />
              hidden
            </Badge>
          )}
          {progress && (
            <Badge variant={request.job?.state === "failed" ? "destructive" : "default"}>
              {working ? <Spinner /> : <LoaderIcon />}
              {progress}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {KIND_HINT[request.kind]} · {formatDateTime(request.createdAt)} ·{" "}
          <span className="font-mono">{request.submitterEmail}</span>
          {request.role && ` (${request.role})`} ·{" "}
          <span title="The form does not confirm the address: reply to it before acting on a removal or objection">
            address unverified
          </span>
        </CardDescription>
        {/* An in-progress request says where it stands in its title's badge. */}
        {!progress && (
          <CardAction>
            <Badge variant="outline">{humanize(request.status)}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm whitespace-pre-wrap">{request.message}</p>
        <NotificationLine request={request} />
        {request.eventKey && (
          // Sent from the event's page (event-correction-link); /events/<key>
          // forwards a talks.cam-derived one to /talks/events/<key>.
          <p className="text-sm text-muted-foreground">
            About the event{" "}
            <Link
              href={`/events/${request.eventKey}`}
              className="font-mono text-xs text-foreground underline-offset-4 hover:underline"
            >
              {request.eventKey}
            </Link>
          </p>
        )}
        {fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            {fields.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="font-mono text-xs text-muted-foreground">{name}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {request.job ? (
          // One summary of what was done; the plan and the agent's findings
          // are behind "Details".
          <>
            <RequestJobPanel request={request} />
            {isDrafted(request) && <RequestDetails request={request} />}
          </>
        ) : (
          isDrafted(request) && <RequestDraftPanel request={request} />
        )}
        {applied.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <CheckIcon className="size-4" />
            Owner-confirmed:{" "}
            {applied
              .map((field) => ORGANISATION_FIELD_LABELS[field as OrganisationField] ?? field)
              .join(", ")}
          </p>
        )}
        {request.org && correction && (!request.job || request.job.state === "failed") && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDialog("corrections")}>
              <CheckIcon />
              {readyDraft(request) ? "Review and confirm…" : "Accept corrections…"}
            </Button>
          </div>
        )}
        {request.org && removal && <SuppressionList orgKey={request.org.key} />}
        {request.org && removal && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" onClick={() => setDialog("removal")}>
              <ShieldXIcon />
              {readyDraft(request)
                ? "Review and confirm…"
                : `Accept ${request.kind === "remove" ? "removal" : "objection"}…`}
            </Button>
            {request.org.hidden && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  request.org &&
                  runWithToast(
                    setHidden({ orgKey: request.org.key, hidden: false }),
                    "Listing shown again",
                  )
                }
              >
                <EyeIcon />
                Show listing again
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                request.org &&
                runWithToast(
                  updateProfile({ orgKey: request.org.key, suppressed: true }),
                  "Suppressed from outreach",
                )
              }
            >
              <BanIcon />
              Suppress outreach
            </Button>
          </div>
        )}
        <StatusActions request={request} />
      </CardContent>
      {dialog === "corrections" && (
        <AcceptCorrectionsDialog request={request} open onClose={() => setDialog(null)} />
      )}
      {dialog === "removal" && (
        <AcceptRemovalDialog request={request} open onClose={() => setDialog(null)} />
      )}
    </Card>
  )
}

/**
 * Moving a request by hand, where no accept dialog does it: an open one is
 * rejected or marked done (a question answered, a listing added by hand), a
 * closed one reopened, and one whose job failed for good closed without its
 * events. The filters above the list show each status.
 */
function StatusActions({ request }: { request: BrokerListingRequest }) {
  const setStatus = useSetListingRequestStatus()
  const move = (status: BrokerListingRequest["status"], label: string, said: string) => (
    <Button
      key={status}
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => runWithToast(setStatus({ key: request.key, status }), said)}
    >
      {label}
    </Button>
  )
  const actions =
    request.status === "open"
      ? [
          move("rejected", "Reject", "Request rejected"),
          move("done", "Mark done", "Request marked done"),
        ]
      : request.status === "in_progress"
        ? request.job?.state === "failed"
          ? [move("accepted", "Close without its events", "Request closed: now under Accepted")]
          : []
        : [move("open", "Reopen", "Request reopened")]
  if (actions.length === 0) return null
  return <div className="flex flex-wrap justify-end gap-1 border-t pt-2">{actions}</div>
}

function describeSuppression(entry: BrokerSuppression): string {
  if (entry.scope === "field" && entry.field) {
    return ORGANISATION_FIELD_LABELS[entry.field as OrganisationField] ?? entry.field
  }
  if (entry.scope === "person") return entry.personName ?? "A named person"
  if (entry.scope === "contact") return "A contact address (stored as a hash)"
  if (entry.scope === "name") return "A person's name (stored as a hash)"
  if (entry.scope === "event" && entry.eventKey) return `Event ${entry.eventKey}`
  return SUPPRESSION_SCOPE_LABELS[entry.scope]
}

/** What removals and objections took off this listing, each liftable. */
function SuppressionList({ orgKey }: { orgKey: string }) {
  const suppressions = useBrokerSuppressions(orgKey)
  const { liftSuppression } = useListingRequestMutations()
  if (!suppressions?.length) return null
  return (
    <ul className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3 text-sm">
      {suppressions.map((entry) => (
        <li key={entry.key} className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <EyeOffIcon className="size-4 text-muted-foreground" />
            <span>
              Suppressed: {describeSuppression(entry)}{" "}
              <span className="font-mono text-xs text-muted-foreground">
                {formatDateTime(entry.createdAt)}
              </span>
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => runWithToast(liftSuppression({ key: entry.key }), "Suppression lifted")}
          >
            <UndoIcon />
            Lift
          </Button>
        </li>
      ))}
    </ul>
  )
}
