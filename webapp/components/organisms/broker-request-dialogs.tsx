"use client"

import { PlusIcon, XIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { FieldValueEditor } from "@/components/molecules/field-value-editor"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  type BrokerListingRequest,
  runWithToast,
  useBrokerOrgDetail,
  useListingRequestMutations,
} from "@/hooks/convex/broker"
import {
  initialText,
  isOwnerField,
  OWNER_FIELDS,
  type OwnerField,
  parseCorrection,
} from "@/lib/owner-corrections"
import {
  ORGANISATION_FIELD_LABELS,
  ORGANISATION_FIELDS,
  type OrganisationField,
  SUPPRESSION_SCOPE_LABELS,
  type SuppressionScope,
} from "@/lib/vocab"

const label = (field: string) => ORGANISATION_FIELD_LABELS[field as OrganisationField] ?? field

type Row = { field: OwnerField; text: string }

/**
 * Accepting a claim or correction: the proposed values, editable and typed
 * per field (lib/owner-corrections.ts), become `owner_submitted` claims on the
 * listing (`broker.listingRequests.acceptCorrections`). Fields can be added or
 * dropped; nothing is sent while a value does not parse.
 */
export function AcceptCorrectionsDialog({
  request,
  open,
  onClose,
}: {
  request: BrokerListingRequest
  open: boolean
  onClose: () => void
}) {
  const { acceptCorrections } = useListingRequestMutations()
  const proposed = Object.entries(request.fields ?? {})
  const [rows, setRows] = useState<Row[]>(() =>
    proposed.flatMap(([field, value]) =>
      isOwnerField(field) ? [{ field, text: initialText(field, value) }] : [],
    ),
  )
  const ignored = proposed.filter(([field]) => !isOwnerField(field)).map(([field]) => field)
  const [adding, setAdding] = useState<string>("")
  const [saving, setSaving] = useState(false)

  const parsed = useMemo(() => rows.map((row) => parseCorrection(row.field, row.text)), [rows])
  const ready = rows.length > 0 && parsed.every((result) => result.ok)
  const remaining = OWNER_FIELDS.filter((field) => !rows.some((row) => row.field === field))

  const setText = (index: number, text: string) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, text } : row)))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setSaving(true)
    const corrections = rows.map((row, index) => {
      const result = parsed[index]
      return { field: row.field, value: result.ok ? result.value : null }
    })
    const done = await runWithToast(
      acceptCorrections({ key: request.key, corrections }),
      `${rows.length} field${rows.length === 1 ? "" : "s"} recorded as owner-confirmed`,
    )
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Accept corrections</DialogTitle>
            <DialogDescription>
              Each value becomes an owner-confirmed claim on {request.org?.name ?? "the listing"}{" "}
              and outranks every harvested source. The sender&apos;s address is unverified — check
              the values first.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                The request proposes no value that can be applied. Add the fields it asks to change.
              </p>
            )}
            {rows.map((row, index) => {
              const result = parsed[index]
              const id = `correction-${row.field}`
              return (
                <Field key={row.field}>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor={id}>{label(row.field)}</FieldLabel>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Drop ${label(row.field)}`}
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  {request.fields?.[row.field] !== undefined && (
                    <FieldDescription className="break-words">
                      Proposed: {request.fields[row.field]}
                    </FieldDescription>
                  )}
                  <FieldValueEditor
                    id={id}
                    field={row.field}
                    value={row.text}
                    onChange={(text) => setText(index, text)}
                    error={row.text.trim() && !result.ok ? result.error : undefined}
                  />
                </Field>
              )
            })}
            {ignored.length > 0 && (
              <FieldDescription>
                Not applied here: {ignored.map(label).join(", ")} (registers, derived fields and
                logos come from their sources).
              </FieldDescription>
            )}
            <Field orientation="horizontal">
              <Select value={adding} onValueChange={setAdding}>
                <SelectTrigger className="w-full sm:w-72" aria-label="Field to add">
                  <SelectValue placeholder="Add a field" />
                </SelectTrigger>
                <SelectContent>
                  {remaining.map((field) => (
                    <SelectItem key={field} value={field}>
                      {label(field)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                disabled={!isOwnerField(adding)}
                onClick={() => {
                  if (!isOwnerField(adding)) return
                  setRows((current) => [...current, { field: adding, text: "" }])
                  setAdding("")
                }}
              >
                <PlusIcon />
                Add
              </Button>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !ready}>
              {saving && <Spinner />}
              Apply {rows.length} field{rows.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Fields a removal may take off a listing (the server's rule: not the name,
 * not what places it). */
const REMOVABLE_FIELDS = ORGANISATION_FIELDS.filter(
  (field) => field !== "name" && field !== "isCounterpart",
)

/**
 * Accepting a removal or objection as a suppression
 * (`broker.listingRequests.acceptRemoval`): the whole listing, some of its
 * fields, one contact address (kept only as a hash) or named people in the
 * broker tables. It takes effect at once and keeps every later harvest from
 * bringing the data back.
 */
export function AcceptRemovalDialog({
  request,
  open,
  onClose,
}: {
  request: BrokerListingRequest
  open: boolean
  onClose: () => void
}) {
  const { acceptRemoval } = useListingRequestMutations()
  const [scope, setScope] = useState<SuppressionScope>(
    request.kind === "remove" ? "organisation" : "contact",
  )
  const [fields, setFields] = useState<string[]>(() =>
    Object.keys(request.fields ?? {}).filter((field) =>
      (REMOVABLE_FIELDS as readonly string[]).includes(field),
    ),
  )
  const [address, setAddress] = useState("")
  const [personKeys, setPersonKeys] = useState<string[]>([])
  const [eventKeysText, setEventKeysText] = useState("")
  const [name, setName] = useState("")
  const eventKeys = eventKeysText
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean)
  const [saving, setSaving] = useState(false)
  const detail = useBrokerOrgDetail(open && scope === "person" ? (request.orgKey ?? null) : null)
  const people = detail?.people ?? []

  const ready =
    scope === "organisation" ||
    (scope === "field" && fields.length > 0) ||
    (scope === "contact" && address.trim().includes("@")) ||
    (scope === "person" && personKeys.length > 0) ||
    (scope === "event" && eventKeys.length > 0) ||
    (scope === "name" && name.trim().split(/\s+/).length >= 2)

  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((item) => item !== value)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setSaving(true)
    const done = await runWithToast(
      acceptRemoval({
        key: request.key,
        scope,
        ...(scope === "field" ? { fields } : {}),
        ...(scope === "contact" ? { address: address.trim() } : {}),
        ...(scope === "person" ? { personKeys } : {}),
        ...(scope === "event" ? { eventKeys } : {}),
        ...(scope === "name" ? { name: name.trim() } : {}),
      }),
      scope === "organisation" ? "Listing removed and suppressed" : "Suppressed",
    )
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Accept {request.kind === "remove" ? "removal" : "objection"}</DialogTitle>
            <DialogDescription>
              Takes effect at once on {request.org?.name ?? "the listing"} and stays: no later
              harvest brings it back. Reply to the (unverified) sender first.
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend variant="label">What to remove</FieldLegend>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as SuppressionScope)}
            >
              {(Object.keys(SUPPRESSION_SCOPE_LABELS) as SuppressionScope[]).map((option) => (
                <Field key={option} orientation="horizontal">
                  <RadioGroupItem value={option} id={`scope-${option}`} />
                  <FieldLabel htmlFor={`scope-${option}`} className="font-normal">
                    {SUPPRESSION_SCOPE_LABELS[option]}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>

          {scope === "organisation" && (
            <FieldDescription>
              Hidden from every public page and from outreach. Showing it again needs the
              suppression lifted first.
            </FieldDescription>
          )}
          {scope === "field" && (
            <FieldSet>
              <FieldLegend variant="label">Fields</FieldLegend>
              <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
                {REMOVABLE_FIELDS.map((field) => (
                  <div key={field} className="flex items-center gap-2">
                    <Checkbox
                      id={`field-${field}`}
                      checked={fields.includes(field)}
                      onCheckedChange={(on) =>
                        setFields((list) => toggle(list, field, on === true))
                      }
                    />
                    <Label htmlFor={`field-${field}`} className="font-normal">
                      {label(field)}
                    </Label>
                  </div>
                ))}
              </div>
              <FieldDescription>Each reads “not published” from now on.</FieldDescription>
            </FieldSet>
          )}
          {scope === "contact" && (
            <Field>
              <FieldLabel htmlFor="suppress-address">Address</FieldLabel>
              <Input
                id="suppress-address"
                type="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="font-mono text-sm"
                autoComplete="off"
              />
              <FieldDescription>
                Removed wherever it appears on this listing and refused on every listing. Stored
                only as a hash.
              </FieldDescription>
            </Field>
          )}
          {scope === "person" && (
            <FieldSet>
              <FieldLegend variant="label">People</FieldLegend>
              {detail === undefined ? (
                <Spinner />
              ) : people.length === 0 ? (
                <FieldDescription>No named people are recorded for this listing.</FieldDescription>
              ) : (
                people.map((person) => (
                  <div key={person.key} className="flex items-center gap-2">
                    <Checkbox
                      id={`person-${person.key}`}
                      checked={personKeys.includes(person.key)}
                      onCheckedChange={(on) =>
                        setPersonKeys((list) => toggle(list, person.key, on === true))
                      }
                    />
                    <Label htmlFor={`person-${person.key}`} className="font-normal">
                      {person.name} · {person.role}
                    </Label>
                  </div>
                ))
              )}
            </FieldSet>
          )}

          {scope === "event" && (
            <Field>
              <FieldLabel htmlFor="suppress-events">Event keys</FieldLabel>
              <Textarea
                id="suppress-events"
                value={eventKeysText}
                onChange={(e) => setEventKeysText(e.target.value)}
                className="font-mono text-sm"
                placeholder="evt-…"
                rows={3}
              />
              <FieldDescription>
                One or more, from the event&apos;s link (<code>?event=evt-…</code>). Each is deleted
                now and never recorded again.
              </FieldDescription>
            </Field>
          )}
          {scope === "name" && (
            <Field>
              <FieldLabel htmlFor="suppress-name">Name, as published</FieldLabel>
              <Input
                id="suppress-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
              <FieldDescription>
                First and last name. Cut out of every public text — descriptions, event titles,
                speakers — on every listing and event, and refused from now on. Stored only as a
                hash.
              </FieldDescription>
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={saving || !ready}>
              {saving && <Spinner />}
              Remove and suppress
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
