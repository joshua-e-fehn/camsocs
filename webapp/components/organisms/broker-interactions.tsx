"use client"

import {
  CalendarClockIcon,
  CheckIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { OrgPicker, type Party, PersonPicker } from "@/components/molecules/party-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  type BrokerInteraction,
  runWithToast,
  useBrokerFollowUps,
  useBrokerInteractionMutations,
  useBrokerInteractions,
  useBrokerPeople,
} from "@/hooks/convex/broker"
import { formatDate, humanize, todayIso } from "@/lib/broker/format"
import { INTERACTION_CHANNELS, type InteractionChannel } from "@/lib/vocab"

/** An ISO date as an instant: noon UTC, so it is that day in London too. */
const dateMs = (iso: string) => Date.parse(`${iso}T12:00:00Z`)

function Who({ row }: { row: BrokerInteraction }) {
  return (
    <span className="flex flex-col">
      {row.org && (
        <Link
          href={`/dashboard/organisations?org=${row.org.key}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.org.name}
        </Link>
      )}
      {row.person && (
        <span className="text-xs text-muted-foreground">
          {row.person.name} · {row.person.role}
        </span>
      )}
    </span>
  )
}

/**
 * The interaction log and the follow-ups it creates. A follow-up is done when
 * its date is cleared ("Done" keeps the interaction).
 */
export function BrokerInteractions() {
  const rows = useBrokerInteractions()
  const due = useBrokerFollowUps(7)
  const { completeFollowUp, remove } = useBrokerInteractionMutations()
  const [editing, setEditing] = useState<BrokerInteraction | "new" | null>(null)
  const today = todayIso()

  return (
    <>
      <BrokerPageHeader
        title="Interactions"
        description="Who you spoke to, how, what was agreed and when to follow up."
      >
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          Log interaction
        </Button>
      </BrokerPageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClockIcon className="size-4" />
            Follow-ups due
          </CardTitle>
          <CardDescription>Overdue, and due within the next 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {due === undefined ? (
            <Skeleton className="h-20" />
          ) : due.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing due. </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {[...due]
                .sort((a, b) => (a.followUpOn ?? "").localeCompare(b.followUpOn ?? ""))
                .map((row) => {
                  const overdue = (row.followUpOn ?? "") < today
                  return (
                    <li
                      key={row.key}
                      className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex items-center gap-2 text-sm">
                          <Badge variant={overdue ? "destructive" : "outline"}>
                            {overdue ? "overdue" : "due"} {formatDate(row.followUpOn)}
                          </Badge>
                          <Who row={row} />
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {row.nextStep ?? row.summary}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            runWithToast(completeFollowUp({ key: row.key }), "Follow-up done")
                          }
                        >
                          <CheckIcon />
                          Done
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Edit"
                          onClick={() => setEditing(row)}
                        >
                          <PencilIcon />
                        </Button>
                      </div>
                    </li>
                  )
                })}
            </ul>
          )}
        </CardContent>
      </Card>

      {rows === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareTextIcon />
            </EmptyMedia>
            <EmptyTitle>No interactions yet</EmptyTitle>
            <EmptyDescription>
              Log a meeting, call or email to keep track of follow-ups.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon />
              Log interaction
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>With</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="hidden lg:table-cell">Next step</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="align-top font-mono text-xs whitespace-nowrap">
                    {formatDate(row.date)}
                    <div className="font-sans text-muted-foreground">{row.channel}</div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Who row={row} />
                  </TableCell>
                  <TableCell className="max-w-md align-top text-sm whitespace-normal">
                    {row.summary}
                  </TableCell>
                  <TableCell className="hidden max-w-xs align-top text-sm whitespace-normal lg:table-cell">
                    {row.nextStep ?? "—"}
                    {row.followUpOn && (
                      <div className="text-xs text-muted-foreground">
                        by {formatDate(row.followUpOn)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top whitespace-nowrap">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit"
                      onClick={() => setEditing(row)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Delete"
                      onClick={() => {
                        if (window.confirm("Delete this interaction?")) {
                          runWithToast(remove({ key: row.key }), "Deleted")
                        }
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <InteractionDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.key}
        row={editing}
        onClose={() => setEditing(null)}
      />
    </>
  )
}

function InteractionDialog({
  row,
  onClose,
}: {
  row: BrokerInteraction | "new" | null
  onClose: () => void
}) {
  const people = useBrokerPeople()
  const { create, update } = useBrokerInteractionMutations()
  const existing = row && row !== "new" ? row : null
  const [date, setDate] = useState(existing ? todayIso(existing.date) : todayIso())
  const [org, setOrg] = useState<Party | null>(
    existing?.org ? { orgKey: existing.org.key, label: existing.org.name } : null,
  )
  const [person, setPerson] = useState<Party | null>(
    existing?.person ? { personKey: existing.person.key, label: existing.person.name } : null,
  )
  const [channel, setChannel] = useState<InteractionChannel>(existing?.channel ?? "email")
  const [summary, setSummary] = useState(existing?.summary ?? "")
  const [nextStep, setNextStep] = useState(existing?.nextStep ?? "")
  const [followUpOn, setFollowUpOn] = useState(existing?.followUpOn ?? "")
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    const fields = {
      date: dateMs(date),
      orgKey: org?.orgKey,
      personKey: person?.personKey,
      channel,
      summary,
      nextStep: nextStep || undefined,
      followUpOn: followUpOn || undefined,
    }
    const done = await runWithToast(
      (existing ? update({ key: existing.key, ...fields }) : create(fields)).then(() => true),
      existing ? "Saved" : "Logged",
    )
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit interaction" : "Log an interaction"}</DialogTitle>
            <DialogDescription>An organisation, a person, or both.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="int-date">Date</FieldLabel>
                <Input
                  id="int-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="int-channel">Channel</FieldLabel>
                <Select
                  value={channel}
                  onValueChange={(value) => setChannel(value as InteractionChannel)}
                >
                  <SelectTrigger id="int-channel" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERACTION_CHANNELS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {humanize(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="int-org">Organisation</FieldLabel>
              <OrgPicker id="int-org" value={org} onChange={setOrg} />
            </Field>
            <Field>
              <FieldLabel htmlFor="int-person">Person (optional)</FieldLabel>
              <PersonPicker id="int-person" value={person} onChange={setPerson} people={people} />
            </Field>
            <Field>
              <FieldLabel htmlFor="int-summary">Summary</FieldLabel>
              <Textarea
                id="int-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={3}
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field>
                <FieldLabel htmlFor="int-next">Next step</FieldLabel>
                <Input
                  id="int-next"
                  value={nextStep}
                  onChange={(e) => setNextStep(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="int-follow">Follow up on</FieldLabel>
                <Input
                  id="int-follow"
                  type="date"
                  value={followUpOn}
                  onChange={(e) => setFollowUpOn(e.target.value)}
                />
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !summary.trim() || (!org?.orgKey && !person?.personKey)}
            >
              {saving && <Spinner />}
              {existing ? "Save" : "Log"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
