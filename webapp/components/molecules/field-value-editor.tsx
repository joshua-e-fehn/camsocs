"use client"

import { FieldDescription, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { humanize } from "@/lib/broker/format"
import { fieldInput, type OwnerField } from "@/lib/owner-corrections"

/**
 * Edits one organisation field's value as text, the way
 * lib/owner-corrections.ts `parseCorrection` reads it: a line of text, a
 * link, an address, yes/no, one or several options (comma-separated), one
 * item per line, or JSON for the structured fields. Shows the parse error
 * under the editor.
 */
export function FieldValueEditor({
  id,
  field,
  value,
  onChange,
  error,
}: {
  id: string
  field: OwnerField
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const input = fieldInput(field)
  let editor: React.ReactNode
  let hint: string | undefined
  switch (input.kind) {
    case "text":
      editor = input.multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={input.max ? 2 : 5}
          aria-invalid={Boolean(error)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={Boolean(error)}
        />
      )
      if (input.max) hint = `At most ${input.max} characters (${value.trim().length} now)`
      break
    case "url":
    case "email":
      editor = (
        <Input
          id={id}
          type={input.kind}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
          aria-invalid={Boolean(error)}
        />
      )
      break
    case "boolean":
    case "choice": {
      const options = input.kind === "boolean" ? ["yes", "no"] : input.options
      editor = (
        <Select value={value || undefined} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full" aria-invalid={Boolean(error)}>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {humanize(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
      break
    }
    case "choices": {
      const picked = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
      editor = (
        <ToggleGroup
          id={id}
          type="multiple"
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
          value={picked}
          onValueChange={(next) => onChange(next.join(", "))}
        >
          {input.options.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {humanize(option)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )
      break
    }
    case "lines":
    case "json":
      editor = (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="font-mono text-sm"
          aria-invalid={Boolean(error)}
        />
      )
      hint = input.kind === "lines" ? input.hint : `JSON, e.g. ${input.example}`
      break
  }
  return (
    <>
      {editor}
      {hint && <FieldDescription>{hint}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </>
  )
}
