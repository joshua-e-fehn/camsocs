"use client"

import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { CollegeCrest } from "@/components/molecules/college-crest"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { type FormalEntry, formalErrorMessage, useSaveFormalDetails } from "@/hooks/convex/formals"
import { londonIsoDate } from "@/lib/calendar"
import { FORMAL_ANCHOR } from "@/lib/college-anchors"
import type { CollegeRef } from "@/lib/colleges"
import { collegeHubPath } from "@/lib/directory-hubs"

const NOTES_MAX = 2000
const VISITS_MAX = 200

/**
 * One college's tracker details (ported from the Cambridge Tracker's
 * `formal-college-detail`, without hosts): the date of the formal, how many
 * formals there, and the member's own notes. Saving with 0 formals unticks
 * the college. Mounted per opening, so the form starts from the saved row.
 */
export function FormalCollegeDetail({
  college,
  entry,
  onClose,
}: {
  college: CollegeRef
  entry?: FormalEntry
  onClose: () => void
}) {
  const save = useSaveFormalDetails()
  const [visitedOn, setVisitedOn] = useState(entry?.visitedOn ?? "")
  const [visits, setVisits] = useState(String(entry?.attended ? entry.visits : 0))
  const [notes, setNotes] = useState(entry?.notes ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = londonIsoDate(Date.now())

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const count = Number(visits)
    if (visits.trim() === "" || !Number.isInteger(count) || count < 0 || count > VISITS_MAX) {
      setError(`Formals here must be a whole number from 0 to ${VISITS_MAX}.`)
      return
    }
    setPending(true)
    setError(null)
    try {
      await save({ collegeKey: college.key, visitedOn: visitedOn || null, visits: count, notes })
      onClose()
    } catch (failure) {
      setError(formalErrorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogHeader>
            <div className="flex items-center gap-3 pr-8">
              <CollegeCrest crest={college.crest} size={52} decorative />
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="font-serif text-xl font-medium">{college.name}</DialogTitle>
                <DialogDescription>Only you can see these details.</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="formal-date">Date</FieldLabel>
                <Input
                  id="formal-date"
                  type="date"
                  max={today}
                  min="1950-01-01"
                  value={visitedOn}
                  disabled={pending}
                  onChange={(e) => setVisitedOn(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="formal-visits">Formals here</FieldLabel>
                <Input
                  id="formal-visits"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={VISITS_MAX}
                  step={1}
                  value={visits}
                  disabled={pending}
                  onChange={(e) => setVisits(e.target.value)}
                  className="font-mono tabular-nums"
                />
              </Field>
            </div>
            <FieldDescription>
              The date is optional. 0 formals unticks {college.shortName}.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="formal-notes">Your notes</FieldLabel>
              <Textarea
                id="formal-notes"
                rows={3}
                maxLength={NOTES_MAX}
                value={notes}
                disabled={pending}
                placeholder="The menu, the speeches, who took you…"
                onChange={(e) => setNotes(e.target.value)}
              />
              <FieldDescription className="font-mono text-xs tabular-nums">
                {notes.length.toLocaleString("en-GB")} / {NOTES_MAX.toLocaleString("en-GB")}
              </FieldDescription>
            </Field>
          </FieldGroup>
          <FieldError>{error}</FieldError>
          <Link
            href={`${collegeHubPath(college)}#${FORMAL_ANCHOR}`}
            className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-brand-text underline underline-offset-4 sm:min-h-0"
          >
            How a visitor gets into {college.shortName}’s formal
            <ArrowRightIcon aria-hidden className="size-3.5" />
          </Link>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-0"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-11 sm:min-h-0" disabled={pending}>
              {pending && <Spinner className="size-3.5" />}
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
