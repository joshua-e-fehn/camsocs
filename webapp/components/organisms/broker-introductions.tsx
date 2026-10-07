"use client"

import { motion, useReducedMotion } from "framer-motion"
import { ArrowLeftRightIcon, HandshakeIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { type Party, PartyPicker } from "@/components/molecules/party-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  type BrokerIntroduction,
  runWithToast,
  useBrokerIntroductionMutations,
  useBrokerIntroductions,
  useBrokerPeople,
} from "@/hooks/convex/broker"
import { formatDate, humanize } from "@/lib/broker/format"
import { INTRODUCTION_STATUSES, type IntroductionStatus } from "@/lib/vocab"

const COLUMN_HINT: Record<IntroductionStatus, string> = {
  idea: "Worth suggesting",
  proposed: "Asked one side",
  sent: "Introduction sent",
  accepted: "Both agreed",
  met: "They met",
  declined: "Not taken up",
  stale: "Went quiet",
}

type Side = BrokerIntroduction["a"]

function partyOf(side: Side, raw: { orgKey?: string; personKey?: string }): Party | null {
  if (side.org) return { orgKey: side.org.key, label: side.org.name }
  if (side.person) return { personKey: side.person.key, label: side.person.name }
  const key = raw.orgKey ?? raw.personKey
  return key ? { ...raw, label: key } : null
}

function SideLabel({ side, raw }: { side: Side; raw: { orgKey?: string; personKey?: string } }) {
  if (side.org) {
    return (
      <Link
        href={`/dashboard/organisations?org=${side.org.key}`}
        className="font-medium underline-offset-4 hover:underline"
      >
        {side.org.name}
      </Link>
    )
  }
  if (side.person) {
    return (
      <span className="font-medium">
        {side.person.name}
        <span className="font-normal text-muted-foreground"> · {side.person.role}</span>
      </span>
    )
  }
  return <span className="font-mono text-xs">{raw.orgKey ?? raw.personKey}</span>
}

/** Introductions as a board by status: idea → proposed → sent → accepted → met, or declined / stale. */
export function BrokerIntroductions() {
  const intros = useBrokerIntroductions()
  const { update, remove } = useBrokerIntroductionMutations()
  const [editing, setEditing] = useState<BrokerIntroduction | "new" | null>(null)
  const reduceMotion = useReducedMotion()

  return (
    <>
      <BrokerPageHeader
        title="Introductions"
        description="Who should meet whom, and how far each introduction has got."
      >
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          New introduction
        </Button>
      </BrokerPageHeader>

      {intros === undefined ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-6 md:px-6">
          <div className="grid min-w-[1100px] grid-cols-7 gap-3">
            {INTRODUCTION_STATUSES.map((status) => {
              const cards = intros.filter((intro) => intro.status === status)
              return (
                <section
                  key={status}
                  className="flex min-h-48 flex-col gap-2 rounded-xl border bg-muted/30 p-2"
                  aria-label={`${humanize(status)} introductions`}
                >
                  <header className="flex items-baseline justify-between px-1">
                    <span className="text-sm font-medium">{humanize(status)}</span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {cards.length}
                    </span>
                  </header>
                  <p className="px-1 text-xs text-muted-foreground">{COLUMN_HINT[status]}</p>
                  <ul className="flex flex-col gap-2">
                    {cards.map((intro) => (
                      <motion.li
                        key={intro.key}
                        layout={!reduceMotion}
                        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                        className="flex flex-col gap-2 rounded-lg border bg-card p-2.5 text-sm shadow-sm"
                      >
                        <div className="flex flex-col gap-0.5">
                          <SideLabel side={intro.a} raw={intro.partyA} />
                          <ArrowLeftRightIcon
                            className="size-3.5 text-muted-foreground"
                            aria-label="and"
                          />
                          <SideLabel side={intro.b} raw={intro.partyB} />
                        </div>
                        <p className="line-clamp-3 text-xs text-muted-foreground">{intro.reason}</p>
                        {intro.outcome && (
                          <p className="line-clamp-2 text-xs">
                            <span className="text-muted-foreground">Outcome: </span>
                            {intro.outcome}
                          </p>
                        )}
                        <div className="flex items-center justify-between gap-1">
                          <Badge variant="ghost" className="px-0 text-muted-foreground">
                            {formatDate(intro.date)}
                          </Badge>
                          <span className="flex">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Edit"
                              onClick={() => setEditing(intro)}
                            >
                              <PencilIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Delete"
                              onClick={() => {
                                if (window.confirm("Delete this introduction?")) {
                                  runWithToast(remove({ key: intro.key }), "Deleted")
                                }
                              }}
                            >
                              <Trash2Icon />
                            </Button>
                          </span>
                        </div>
                        <Select
                          value={intro.status}
                          onValueChange={(next) =>
                            runWithToast(
                              update({ key: intro.key, status: next as IntroductionStatus }),
                            )
                          }
                        >
                          <SelectTrigger size="sm" className="w-full" aria-label="Move to">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {INTRODUCTION_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {humanize(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </motion.li>
                    ))}
                  </ul>
                  {status === "idea" && cards.length === 0 && (
                    <div className="flex flex-col items-center gap-2 px-1 py-4 text-center text-xs text-muted-foreground">
                      <HandshakeIcon className="size-6" />
                      Ideas from the graph's "who could meet whom" land here.
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}

      <IntroductionDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.key}
        intro={editing}
        onClose={() => setEditing(null)}
      />
    </>
  )
}

function IntroductionDialog({
  intro,
  onClose,
}: {
  intro: BrokerIntroduction | "new" | null
  onClose: () => void
}) {
  const people = useBrokerPeople()
  const { create, update } = useBrokerIntroductionMutations()
  const existing = intro && intro !== "new" ? intro : null
  const [a, setA] = useState<Party | null>(existing ? partyOf(existing.a, existing.partyA) : null)
  const [b, setB] = useState<Party | null>(existing ? partyOf(existing.b, existing.partyB) : null)
  const [reason, setReason] = useState(existing?.reason ?? "")
  const [status, setStatus] = useState<IntroductionStatus>(existing?.status ?? "idea")
  const [outcome, setOutcome] = useState(existing?.outcome ?? "")
  const [saving, setSaving] = useState(false)

  const side = (party: Party) => ({ orgKey: party.orgKey, personKey: party.personKey })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!a || !b) return
    setSaving(true)
    const done = await runWithToast(
      (existing
        ? update({
            key: existing.key,
            partyA: side(a),
            partyB: side(b),
            reason,
            status,
            outcome,
          })
        : create({ partyA: side(a), partyB: side(b), reason, status })
      ).then(() => true),
      existing ? "Saved" : "Added to the board",
    )
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Dialog open={intro !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit introduction" : "New introduction"}</DialogTitle>
            <DialogDescription>Each side is one organisation or one person.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="intro-a">Party A</FieldLabel>
              <PartyPicker id="intro-a" value={a} onChange={setA} people={people} />
            </Field>
            <Field>
              <FieldLabel htmlFor="intro-b">Party B</FieldLabel>
              <PartyPicker id="intro-b" value={b} onChange={setB} people={people} />
            </Field>
            <Field>
              <FieldLabel htmlFor="intro-reason">Why they should meet</FieldLabel>
              <Textarea
                id="intro-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="intro-status">Status</FieldLabel>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as IntroductionStatus)}
              >
                <SelectTrigger id="intro-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTRODUCTION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {humanize(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {existing && (
              <Field>
                <FieldLabel htmlFor="intro-outcome">Outcome</FieldLabel>
                <Textarea
                  id="intro-outcome"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  rows={2}
                />
              </Field>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !a || !b || !reason.trim()}>
              {saving && <Spinner />}
              {existing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
