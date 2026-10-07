"use client"

import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react"
import Link from "next/link"
import { useDeferredValue, useMemo, useState } from "react"
import { BrokerPageHeader } from "@/components/molecules/broker-page-header"
import { OrgPicker, type Party } from "@/components/molecules/party-picker"
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type BrokerPerson,
  runWithToast,
  useBrokerPeople,
  useBrokerPeopleMutations,
} from "@/hooks/convex/broker"
import { formatDate, humanize, urlHost } from "@/lib/broker/format"
import { CONSENT_BASES, type ConsentBasis } from "@/lib/vocab"

type Scope = "current" | "stale" | "archived" | "all"

/**
 * Named committee members — private to /dashboard, from public sources or the
 * broker's own dealings, and stale after each handover. Editing a row the
 * pipeline wrote makes it the broker's (`manual`).
 */
export function BrokerPeople() {
  const people = useBrokerPeople()
  const { setArchived } = useBrokerPeopleMutations()
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const [scope, setScope] = useState<Scope>("current")
  const [editing, setEditing] = useState<BrokerPerson | "new" | null>(null)

  const shown = useMemo(() => {
    if (!people) return undefined
    const needle = deferred.trim().toLowerCase()
    return people.filter(
      (p) =>
        (scope === "all" ||
          (scope === "archived" && p.archived) ||
          (scope === "stale" && p.staleNow && !p.archived) ||
          (scope === "current" && !p.staleNow && !p.archived)) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          p.role.toLowerCase().includes(needle) ||
          p.org?.name.toLowerCase().includes(needle)),
    )
  }, [people, deferred, scope])

  return (
    <>
      <BrokerPageHeader
        title="People"
        description="Named committee members. Private: never shown outside this area, and stale after each handover."
      >
        <Button onClick={() => setEditing("new")}>
          <PlusIcon />
          Add person
        </Button>
      </BrokerPageHeader>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <InputGroup className="sm:w-72">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, role or organisation"
            aria-label="Search people"
          />
        </InputGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          value={scope}
          onValueChange={(value) => value && setScope(value as Scope)}
          aria-label="Which people"
        >
          <ToggleGroupItem value="current">Current</ToggleGroupItem>
          <ToggleGroupItem value="stale">Stale</ToggleGroupItem>
          <ToggleGroupItem value="archived">Archived</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {shown === undefined ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : shown.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No people here</EmptyTitle>
            <EmptyDescription>
              The pipeline adds committee members as societies publish them; you can add the ones
              you meet.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon />
              Add person
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Organisation</TableHead>
                <TableHead className="hidden md:table-cell">Stale after</TableHead>
                <TableHead className="hidden lg:table-cell">Basis · source</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((person) => {
                const host = urlHost(person.sourceUrl)
                return (
                  <TableRow key={person.key}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1.5 font-medium">
                          {person.name}
                          {person.staleNow && !person.archived && (
                            <Badge variant="outline">stale</Badge>
                          )}
                          {person.archived && <Badge variant="ghost">archived</Badge>}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {person.role} · {person.academicYear}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {person.org ? (
                        <Link
                          href={`/dashboard/organisations?org=${person.org.key}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {person.org.name}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs">{person.orgKey}</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">
                      {formatDate(person.staleAfter)}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {humanize(person.consentBasis)} · {person.method}
                      {host ? (
                        <>
                          {" · "}
                          <a
                            href={person.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-4 hover:underline"
                          >
                            {host}
                          </a>
                        </>
                      ) : (
                        " · your entry"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${person.name}`}
                        onClick={() => setEditing(person)}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={
                          person.archived ? `Restore ${person.name}` : `Archive ${person.name}`
                        }
                        onClick={() =>
                          runWithToast(
                            setArchived({ key: person.key, archived: !person.archived }),
                            person.archived ? "Restored" : "Archived",
                          )
                        }
                      >
                        {person.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <PersonDialog
        key={editing === null ? "closed" : editing === "new" ? "new" : editing.key}
        person={editing}
        onClose={() => setEditing(null)}
      />
    </>
  )
}

function PersonDialog({
  person,
  onClose,
}: {
  person: BrokerPerson | "new" | null
  onClose: () => void
}) {
  const { create, update } = useBrokerPeopleMutations()
  const existing = person && person !== "new" ? person : null
  const [org, setOrg] = useState<Party | null>(
    existing?.org ? { orgKey: existing.org.key, label: existing.org.name } : null,
  )
  const [name, setName] = useState(existing?.name ?? "")
  const [role, setRole] = useState(existing?.role ?? "")
  const [staleAfter, setStaleAfter] = useState(existing?.staleAfter ?? "")
  const [consentBasis, setConsentBasis] = useState<ConsentBasis>(
    existing?.consentBasis ?? "legitimate_interest",
  )
  const [sourceUrl, setSourceUrl] = useState("")
  const [notes, setNotes] = useState(existing?.notes ?? "")
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!org?.orgKey) return
    setSaving(true)
    const done = existing
      ? await runWithToast(
          update({
            key: existing.key,
            orgKey: org.orgKey,
            name,
            role,
            staleAfter: staleAfter || undefined,
            consentBasis,
            notes,
          }).then(() => true),
          "Saved",
        )
      : await runWithToast(
          create({
            orgKey: org.orgKey,
            name,
            role,
            staleAfter: staleAfter || undefined,
            consentBasis,
            sourceUrl: sourceUrl.trim() || undefined,
            notes,
          }).then(() => true),
          "Added",
        )
    setSaving(false)
    if (done) onClose()
  }

  return (
    <Dialog open={person !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "Add a person"}</DialogTitle>
            <DialogDescription>
              Only as published by the organisation, or as you met them. Stays private.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="person-org">Organisation</FieldLabel>
              <OrgPicker id="person-org" value={org} onChange={setOrg} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="person-name">Name</FieldLabel>
                <Input
                  id="person-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-role">Role</FieldLabel>
                <Input
                  id="person-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="President"
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-stale">Stale after</FieldLabel>
                <Input
                  id="person-stale"
                  type="date"
                  value={staleAfter}
                  onChange={(e) => setStaleAfter(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-basis">Basis</FieldLabel>
                <Select
                  value={consentBasis}
                  onValueChange={(value) => setConsentBasis(value as ConsentBasis)}
                >
                  <SelectTrigger id="person-basis" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONSENT_BASES.map((basis) => (
                      <SelectItem key={basis} value={basis}>
                        {humanize(basis)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {!existing && (
              <Field>
                <FieldLabel htmlFor="person-source">Public source (optional)</FieldLabel>
                <Input
                  id="person-source"
                  type="url"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://… where the organisation names them"
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="person-notes">Notes</FieldLabel>
              <Textarea
                id="person-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !org?.orgKey || !name.trim() || !role.trim()}>
              {saving && <Spinner />}
              {existing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
