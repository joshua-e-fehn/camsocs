"use client"

import { Building2Icon, UserIcon, XIcon } from "lucide-react"
import { useDeferredValue, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { type BrokerPerson, useBrokerOrgSearch } from "@/hooks/convex/broker"

/** One side of an introduction or interaction: an organisation or a person. */
export type Party = { orgKey?: string; personKey?: string; label: string }

const MAX_RESULTS = 8

function Chosen({ party, onClear }: { party: Party; onClear: () => void }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 rounded-lg border bg-muted/40 px-2.5 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        {party.personKey ? <UserIcon className="size-4" /> : <Building2Icon className="size-4" />}
        <span className="truncate">{party.label}</span>
      </span>
      <Button type="button" variant="ghost" size="icon-xs" onClick={onClear} aria-label="Clear">
        <XIcon />
      </Button>
    </div>
  )
}

function Results({
  items,
  onPick,
  empty,
}: {
  items: { key: string; label: string; detail?: string }[] | undefined
  onPick: (key: string, label: string) => void
  empty: string
}) {
  if (items === undefined) return null
  if (items.length === 0) return <p className="px-1 text-xs text-muted-foreground">{empty}</p>
  return (
    <ul className="max-h-48 overflow-auto rounded-lg border">
      {items.slice(0, MAX_RESULTS).map((item) => (
        <li key={item.key}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            onClick={() => onPick(item.key, item.label)}
          >
            <span className="truncate">{item.label}</span>
            {item.detail && (
              <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Search organisations by name (any kind, hidden ones included). */
export function OrgPicker({
  value,
  onChange,
  id,
}: {
  value: Party | null
  onChange: (party: Party | null) => void
  id?: string
}) {
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const results = useBrokerOrgSearch(deferred)
  if (value) return <Chosen party={value} onClear={() => onChange(null)} />
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        id={id}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search organisations…"
        autoComplete="off"
      />
      {deferred.trim() && (
        <Results
          items={results?.map((org) => ({
            key: org.key,
            label: org.name,
            detail: org.hidden ? "hidden" : org.isCounterpart ? "counterpart" : undefined,
          }))}
          onPick={(key, label) => {
            onChange({ orgKey: key, label })
            setQuery("")
          }}
          empty="No organisation matches."
        />
      )}
    </div>
  )
}

/** Search the people list (passed in; it is already loaded by the page). */
export function PersonPicker({
  value,
  onChange,
  people,
  id,
}: {
  value: Party | null
  onChange: (party: Party | null) => void
  people: BrokerPerson[] | undefined
  id?: string
}) {
  const [query, setQuery] = useState("")
  if (value) return <Chosen party={value} onClear={() => onChange(null)} />
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? people
        ?.filter((p) => !p.archived)
        .filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.org?.name.toLowerCase().includes(needle) ||
            p.role.toLowerCase().includes(needle),
        )
    : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        id={id}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search people by name, role or organisation…"
        autoComplete="off"
      />
      <Results
        items={matches?.map((p) => ({
          key: p.key,
          label: p.name,
          detail: [p.role, p.org?.name].filter(Boolean).join(" · "),
        }))}
        onPick={(key, label) => {
          onChange({ personKey: key, label })
          setQuery("")
        }}
        empty="No person matches."
      />
    </div>
  )
}

/** An organisation or a person, switchable. */
export function PartyPicker({
  value,
  onChange,
  people,
  id,
}: {
  value: Party | null
  onChange: (party: Party | null) => void
  people: BrokerPerson[] | undefined
  id?: string
}) {
  const [kind, setKind] = useState<"org" | "person">(value?.personKey ? "person" : "org")
  return (
    <div className="flex flex-col gap-1.5">
      {!value && (
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={kind}
          onValueChange={(next) => next && setKind(next as "org" | "person")}
          aria-label="Party type"
        >
          <ToggleGroupItem value="org">
            <Building2Icon />
            Organisation
          </ToggleGroupItem>
          <ToggleGroupItem value="person">
            <UserIcon />
            Person
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      {kind === "org" || value?.orgKey ? (
        <OrgPicker id={id} value={value} onChange={onChange} />
      ) : (
        <PersonPicker id={id} value={value} onChange={onChange} people={people} />
      )}
    </div>
  )
}
