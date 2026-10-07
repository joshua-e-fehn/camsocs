"use client"

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { FieldStatusBadge } from "@/components/molecules/field-status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  type BrokerOrgDetail,
  runWithToast,
  useBrokerOrgDetail,
  useBrokerOrgMutations,
} from "@/hooks/convex/broker"
import {
  capitalise,
  formatDate,
  humanize,
  RELATIONSHIP_LABELS,
  todayIso,
  urlHost,
} from "@/lib/broker/format"
import { fieldLabel } from "@/lib/broker/outreach"
import { NEED_OFFER_ITEMS, type NeedOfferItem, PECR_SUBSCRIBER_TYPES } from "@/lib/vocab"

type Profile = NonNullable<BrokerOrgDetail["profile"]>
type OptInName = keyof Profile["optIns"]

const OPT_INS: [OptInName, string][] = [
  ["openToSponsors", "Open to sponsors"],
  ["openToCollaborations", "Open to collaborations"],
  ["careersEvents", "Runs careers events"],
]

/**
 * One organisation in full, for the broker: visibility and outreach switches,
 * the broker profile, people, relationships, interactions, every field with
 * its provenance, and the internal feed identifiers. Opened by `?org=<key>`.
 */
export function BrokerOrgDrawer() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const orgKey = searchParams.get("org")
  const detail = useBrokerOrgDetail(orgKey)

  const close = () => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete("org")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <Sheet open={orgKey !== null} onOpenChange={(open) => !open && close()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {detail === undefined ? (
          <div className="flex flex-col gap-3 p-4">
            <SheetTitle className="sr-only">Loading</SheetTitle>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24" />
            <Skeleton className="h-48" />
          </div>
        ) : detail === null ? (
          <SheetHeader>
            <SheetTitle>Not found</SheetTitle>
            <SheetDescription>No organisation has the key {orgKey}.</SheetDescription>
          </SheetHeader>
        ) : (
          <DrawerBody detail={detail} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 px-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function DrawerBody({ detail }: { detail: BrokerOrgDetail }) {
  const { org, profile } = detail
  const { setHidden } = useBrokerOrgMutations()
  const website = org.website && urlHost(org.website)

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SheetHeader className="gap-2 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={org.status === "active" ? "secondary" : "outline"}>{org.status}</Badge>
          {org.level && <Badge variant="outline">{humanize(org.level)}</Badge>}
          {org.orgType && <Badge variant="outline">{humanize(org.orgType)}</Badge>}
          {org.isCounterpart && <Badge variant="outline">counterpart</Badge>}
          {org.hidden && (
            <Badge variant="destructive">
              <EyeOffIcon />
              hidden
            </Badge>
          )}
        </div>
        <SheetTitle className="text-xl tracking-tight">{org.name}</SheetTitle>
        <SheetDescription className="font-mono text-xs">
          {org.key}
          {website && (
            <>
              {" · "}
              <a
                href={org.website}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                {website}
                <ExternalLinkIcon className="size-3" />
              </a>
            </>
          )}
        </SheetDescription>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant={org.hidden ? "default" : "outline"}
            onClick={() =>
              runWithToast(
                setHidden({ orgKey: org.key, hidden: !org.hidden }),
                org.hidden ? "Shown on the public site again" : "Hidden from the public site",
              )
            }
          >
            {org.hidden ? <EyeIcon /> : <EyeOffIcon />}
            {org.hidden ? "Show on public site" : "Hide from public site"}
          </Button>
        </div>
      </SheetHeader>

      <Separator />
      <ProfileEditor key={org.key} orgKey={org.key} profile={profile} />
      <Separator />
      <NeedsOffers orgKey={org.key} profile={profile} />
      <Separator />

      <Section
        title={`People (${detail.people.length})`}
        action={
          <Button asChild variant="ghost" size="xs">
            <Link href="/dashboard/people">Manage</Link>
          </Button>
        }
      >
        {detail.people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No named people.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {detail.people.map((person) => {
              const stale = person.stale || person.staleAfter < todayIso()
              return (
                <li key={person.key} className="flex flex-wrap items-center gap-2">
                  <span className={person.archived ? "text-muted-foreground line-through" : ""}>
                    {person.name}
                  </span>
                  <span className="text-muted-foreground">{person.role}</span>
                  {stale && <Badge variant="outline">stale</Badge>}
                  <Badge variant="ghost" className="text-muted-foreground">
                    {person.method}
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Separator />
      <Section title={`Relationships (${detail.relationships.length})`}>
        {detail.relationships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No known relationships.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {detail.relationships.map((edge) => {
              const other =
                "name" in edge.counterpart ? edge.counterpart.name : edge.counterpart.key
              const evidence = edge.evidence.find((e) => urlHost(e.sourceUrl))
              return (
                <li key={edge.key} className="flex flex-wrap items-center gap-2">
                  {edge.direction === "outgoing" ? (
                    <ArrowRightIcon className="size-3.5" aria-label="outgoing" />
                  ) : (
                    <ArrowLeftIcon className="size-3.5" aria-label="incoming" />
                  )}
                  <span className="text-muted-foreground">
                    {RELATIONSHIP_LABELS[edge.type].toLowerCase()}
                  </span>
                  <Link
                    href={`/dashboard/organisations?org=${edge.counterpart.key}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {other}
                  </Link>
                  <Badge variant={edge.visibility === "public" ? "secondary" : "outline"}>
                    {edge.visibility}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {edge.confidence.toFixed(2)} · {edge.evidence.length} sighting
                    {edge.evidence.length === 1 ? "" : "s"}
                  </span>
                  {evidence && (
                    <a
                      href={evidence.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs underline-offset-4 hover:underline"
                    >
                      {urlHost(evidence.sourceUrl)}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Separator />
      <Section
        title={`Interactions (${detail.interactions.length})`}
        action={
          <Button asChild variant="ghost" size="xs">
            <Link href="/dashboard/interactions">Log one</Link>
          </Button>
        }
      >
        {detail.interactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {detail.interactions.map((row) => (
              <li key={row.key} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {formatDate(row.date)} · {row.channel}
                  {row.followUpOn && ` · follow up ${formatDate(row.followUpOn)}`}
                </span>
                <span>{row.summary}</span>
                {row.nextStep && (
                  <span className="text-muted-foreground">Next: {row.nextStep}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Separator />
      <FieldsWithMeta detail={detail} />

      <Separator />
      <Section title="Internal identifiers">
        {detail.internal ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(detail.internal)
              .filter(
                ([name, value]) =>
                  !["orgKey", "createdAt", "updatedAt"].includes(name) &&
                  value !== undefined &&
                  !(Array.isArray(value) && value.length === 0),
              )
              .map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="min-w-0 font-mono text-xs break-all">{renderValue(value)}</dd>
                </div>
              ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No feeds or identifiers recorded.</p>
        )}
      </Section>
    </div>
  )
}

function ProfileEditor({ orgKey, profile }: { orgKey: string; profile: Profile | null }) {
  const { updateProfile } = useBrokerOrgMutations()
  const [notes, setNotes] = useState(profile?.notes ?? "")
  const [sponsorNotes, setSponsorNotes] = useState(profile?.sponsorNotes ?? "")
  // Drafts start from the stored values; the editor is keyed by organisation,
  // so opening another one starts fresh and a live update never eats a draft.
  const [flags, setFlags] = useState((profile?.ethicsFlags ?? []).join(", "))

  const save = (patch: Omit<Parameters<typeof updateProfile>[0], "orgKey">, message = "Saved") =>
    runWithToast(updateProfile({ orgKey, ...patch }), message)

  const suppressed = profile?.suppressed ?? false
  return (
    <Section title="Outreach and profile">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel>Outreach</FieldLabel>
          <Button
            variant={suppressed ? "destructive" : "outline"}
            size="sm"
            onClick={() =>
              save(
                { suppressed: !suppressed },
                suppressed ? "Back on the outreach list" : "Suppressed: never contacted",
              )
            }
          >
            {suppressed ? <XIcon /> : <CheckIcon />}
            {suppressed ? "Suppressed (do not contact)" : "May be contacted"}
          </Button>
        </Field>
        <Field>
          <FieldLabel htmlFor={`pecr-${orgKey}`}>PECR subscriber</FieldLabel>
          <Select
            value={profile?.pecrSubscriberType ?? "unknown"}
            onValueChange={(value) =>
              save({ pecrSubscriberType: value as Profile["pecrSubscriberType"] })
            }
          >
            <SelectTrigger id={`pecr-${orgKey}`} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PECR_SUBSCRIBER_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {humanize(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {OPT_INS.map(([name, label]) => {
          const value = profile?.optIns[name]
          return (
            <Field key={name}>
              <FieldLabel htmlFor={`${name}-${orgKey}`}>{label}</FieldLabel>
              <Select
                value={value === undefined ? "unknown" : value ? "yes" : "no"}
                onValueChange={(next) =>
                  save({
                    optIns: { [name]: next === "unknown" ? null : next === "yes" },
                  })
                }
              >
                <SelectTrigger id={`${name}-${orgKey}`} size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">Unknown</SelectItem>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )
        })}
      </div>
      <Field>
        <FieldLabel htmlFor={`flags-${orgKey}`}>Ethics flags (comma-separated)</FieldLabel>
        <div className="flex gap-2">
          <Input
            id={`flags-${orgKey}`}
            value={flags}
            onChange={(event) => setFlags(event.target.value)}
            placeholder="e.g. fossil fuels, arms"
          />
          <Button
            variant="outline"
            onClick={() => save({ ethicsFlags: flags.split(",").map((flag) => flag.trim()) })}
          >
            Save
          </Button>
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor={`notes-${orgKey}`}>Notes</FieldLabel>
        <Textarea
          id={`notes-${orgKey}`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`sponsor-${orgKey}`}>Sponsor notes</FieldLabel>
        <Textarea
          id={`sponsor-${orgKey}`}
          value={sponsorNotes}
          onChange={(event) => setSponsorNotes(event.target.value)}
          rows={2}
        />
      </Field>
      <div>
        <Button size="sm" onClick={() => save({ notes, sponsorNotes }, "Notes saved")}>
          Save notes
        </Button>
      </div>
    </Section>
  )
}

function NeedsOffers({ orgKey, profile }: { orgKey: string; profile: Profile | null }) {
  const { setNeedOffer } = useBrokerOrgMutations()
  const [adding, setAdding] = useState<Record<"needs" | "offers", NeedOfferItem | "">>({
    needs: "",
    offers: "",
  })
  const set = (
    kind: "needs" | "offers",
    item: NeedOfferItem,
    status: "confirmed" | "rejected" | null,
  ) => runWithToast(setNeedOffer({ orgKey, kind, item, status }))

  return (
    <Section title="Needs and offers">
      <div className="grid gap-4">
        {(["needs", "offers"] as const).map((kind) => {
          const entries = profile?.[kind] ?? []
          const present = new Set(entries.map((entry) => entry.item))
          return (
            <div key={kind} className="flex flex-col gap-2">
              <span className="text-sm font-medium">{kind === "needs" ? "Needs" : "Offers"}</span>
              {entries.length === 0 && (
                <span className="text-xs text-muted-foreground">None recorded.</span>
              )}
              <ul className="flex flex-col gap-1.5">
                {entries.map((entry) => (
                  <li
                    key={entry.item}
                    className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1 text-sm"
                    title={entry.evidenceQuote ? `“${entry.evidenceQuote}”` : undefined}
                  >
                    <span
                      className={
                        entry.status === "rejected" ? "text-muted-foreground line-through" : ""
                      }
                    >
                      {humanize(entry.item)}
                      <span className="ml-1.5 text-xs text-muted-foreground">{entry.status}</span>
                    </span>
                    <span className="flex gap-0.5">
                      {entry.status !== "confirmed" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Confirm ${entry.item}`}
                          onClick={() => set(kind, entry.item, "confirmed")}
                        >
                          <CheckIcon />
                        </Button>
                      )}
                      {entry.status !== "rejected" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Reject ${entry.item}`}
                          onClick={() => set(kind, entry.item, "rejected")}
                        >
                          <XIcon />
                        </Button>
                      )}
                      {entry.status !== "inferred" && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Forget ${entry.item}`}
                          title="Forget the verdict (the pipeline may infer it again)"
                          onClick={() => set(kind, entry.item, null)}
                        >
                          <RotateCcwIcon />
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Select
                  value={adding[kind]}
                  onValueChange={(value) =>
                    setAdding((prev) => ({ ...prev, [kind]: value as NeedOfferItem }))
                  }
                >
                  <SelectTrigger size="sm" className="flex-1" aria-label={`Add to ${kind}`}>
                    <SelectValue placeholder="Add…" />
                  </SelectTrigger>
                  <SelectContent>
                    {NEED_OFFER_ITEMS.filter((item) => !present.has(item)).map((item) => (
                      <SelectItem key={item} value={item}>
                        {humanize(item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!adding[kind]}
                  onClick={async () => {
                    const item = adding[kind]
                    if (!item) return
                    await set(kind, item, "confirmed")
                    setAdding((prev) => ({ ...prev, [kind]: "" }))
                  }}
                >
                  <PlusIcon />
                  Add
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

/** A stored value, compactly: text as is, structures as short JSON. */
function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  const text = JSON.stringify(value)
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

function readField(org: Record<string, unknown>, field: string): unknown {
  const [head, sub] = field.split(".")
  const value = org[head]
  if (sub === undefined) return value
  return value && typeof value === "object" ? (value as Record<string, unknown>)[sub] : undefined
}

function FieldsWithMeta({ detail }: { detail: BrokerOrgDetail }) {
  const [showAll, setShowAll] = useState(false)
  const entries = Object.entries(detail.org.meta).filter(
    ([, meta]) => showAll || meta.status !== "not_applicable",
  )
  return (
    <Section
      title="Fields and provenance"
      action={
        <Button variant="ghost" size="xs" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Hide n/a" : "Show n/a"}
        </Button>
      }
    >
      <ul className="flex flex-col divide-y rounded-lg border text-sm">
        {entries.map(([field, meta]) => {
          const host = urlHost(meta.sourceUrl)
          const value = readField(detail.org as Record<string, unknown>, field)
          return (
            <li key={field} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{capitalise(fieldLabel(field))}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <FieldStatusBadge status={meta.status} />
                  {meta.confidence !== undefined && (
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {meta.confidence.toFixed(2)}
                    </span>
                  )}
                </span>
              </div>
              {meta.status !== "missing" && meta.status !== "not_applicable" && (
                <span className="line-clamp-3 break-words text-muted-foreground">
                  {renderValue(field === "logo" && detail.logoUrl ? detail.logoUrl : value)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {meta.status === "missing"
                  ? humanize(meta.missingReason ?? "not_attempted")
                  : [
                      meta.method,
                      meta.evidence,
                      meta.sourceType?.replace(/_/g, " "),
                      meta.retrievedAt && formatDate(meta.retrievedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                {host && (
                  <>
                    {" · "}
                    <a
                      href={meta.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-4 hover:underline"
                    >
                      {host}
                    </a>
                  </>
                )}
                {meta.sourceUrl && !host && " · private source"}
              </span>
              {meta.conflicts?.map((conflict) => (
                <span
                  key={`${conflict.sourceUrl}-${conflict.retrievedAt}`}
                  className="rounded-md bg-destructive/10 px-2 py-1 text-xs"
                >
                  Other reading: {renderValue(conflict.value)} —{" "}
                  {urlHost(conflict.sourceUrl) ?? "private source"},{" "}
                  {formatDate(conflict.retrievedAt)}
                </span>
              ))}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
