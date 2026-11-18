"use client"

import { CheckIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  type FormalProfile,
  formalErrorMessage,
  useSaveFormalProfile,
} from "@/hooks/convex/formals"
import type { CollegeRef } from "@/lib/colleges"

const NO_COLLEGE = "none"

/**
 * The member's leaderboard name, home college and opt-in. Joining needs a
 * verified @cam.ac.uk account (`canJoin`); the server checks the name is not
 * an address, URL or CRSid (convex/lib/formals.ts) and says why when not.
 */
export function FormalProfileForm({
  colleges,
  profile,
  canJoin,
}: {
  colleges: readonly CollegeRef[]
  profile: FormalProfile | null
  canJoin: boolean
}) {
  const save = useSaveFormalProfile()
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "")
  const [homeCollegeKey, setHomeCollegeKey] = useState(profile?.homeCollegeKey ?? NO_COLLEGE)
  const [onLeaderboard, setOnLeaderboard] = useState(profile?.onLeaderboard ?? false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // Every name rule's message names "leaderboard name" (convex/lib/formals.ts);
  // other errors (not verified, bad college) belong to the form, not the field.
  const nameInvalid = error?.includes("leaderboard name") ?? false

  function touched() {
    setSaved(false)
    setError(null)
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await save({
        displayName: displayName.trim() || null,
        onLeaderboard: canJoin && onLeaderboard,
        homeCollegeKey: homeCollegeKey === NO_COLLEGE ? null : homeCollegeKey,
      })
      setSaved(true)
    } catch (failure) {
      setError(formalErrorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={nameInvalid}>
          <FieldLabel htmlFor="formal-display-name">Leaderboard name</FieldLabel>
          <Input
            id="formal-display-name"
            value={displayName}
            maxLength={24}
            autoComplete="nickname"
            disabled={pending}
            aria-invalid={nameInvalid}
            aria-describedby={nameInvalid ? "formal-display-name-error" : undefined}
            placeholder="e.g. Gown Borrower"
            onChange={(e) => {
              setDisplayName(e.target.value)
              touched()
            }}
          />
          <FieldDescription>
            2–24 letters, numbers, spaces and ' - _ . characters. A nickname works best, never your
            email or CRSid.
          </FieldDescription>
          {nameInvalid && <FieldError id="formal-display-name-error">{error}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="formal-home-college">Your college</FieldLabel>
          <Select
            value={homeCollegeKey}
            disabled={pending}
            onValueChange={(value) => {
              setHomeCollegeKey(value)
              touched()
            }}
          >
            <SelectTrigger id="formal-home-college" className="min-h-11 w-full sm:min-h-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_COLLEGE}>Rather not say</SelectItem>
              {colleges.map((college) => (
                <SelectItem key={college.key} value={college.key}>
                  {college.shortName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      <Field orientation="horizontal" className="min-h-11 items-center">
        <Checkbox
          id="formal-on-leaderboard"
          checked={canJoin && onLeaderboard}
          disabled={pending || !canJoin}
          onCheckedChange={(value) => {
            setOnLeaderboard(value === true)
            touched()
          }}
        />
        <FieldLabel htmlFor="formal-on-leaderboard" className="font-normal">
          Show me on the leaderboard
        </FieldLabel>
      </Field>
      <FieldDescription>
        {canJoin
          ? "Signed-in Cambridge members see your leaderboard name, college and counts, never your account or notes."
          : "The leaderboard is for verified @cam.ac.uk accounts. Your tracker still works without it."}
      </FieldDescription>
      {!nameInvalid && <FieldError>{error}</FieldError>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className="min-h-11 sm:min-h-0" disabled={pending}>
          {pending && <Spinner className="size-3.5" />}
          {pending ? "Saving…" : "Save profile"}
        </Button>
        {saved && (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-brand-text">
            <CheckIcon aria-hidden className="size-4" /> Saved
          </span>
        )}
      </div>
    </form>
  )
}
