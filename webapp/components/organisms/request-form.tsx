"use client"

import { ConvexError } from "convex/values"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { CircleCheckIcon, PlusIcon, TrashIcon } from "lucide-react"
import Link from "next/link"
import { useEffect, useState } from "react"
import { OrgPicker } from "@/components/molecules/org-picker"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { useSubmitListingRequest } from "@/hooks/convex"
import {
  CORRECTABLE_FIELDS,
  type DraftErrors,
  emptyDraft,
  KIND_DETAILS,
  LIMITS,
  type RequestDraft,
  validateDraft,
} from "@/lib/listing-request"
import type { OrgRef } from "@/lib/public-api"
import {
  LISTING_REQUEST_KINDS,
  type ListingRequestKind,
  ORGANISATION_FIELD_LABELS,
} from "@/lib/vocab"

const NEXT_STEPS: Record<ListingRequestKind, string> = {
  claim:
    "We check that the request comes from the society (usually by replying to an address the society publishes), then mark your confirmed details as owner-confirmed.",
  correct:
    "We check the correction against the society's own pages. Confirmed corrections show as owner-confirmed and take precedence over harvested values.",
  remove:
    "We check that the request comes from the society, then take the listing down and record it so the next harvest does not add it back.",
  object:
    "We stop using the personal data concerned while we look at your objection, unless there is a compelling reason not to, and tell you the outcome.",
  add: "We look the society up in its own public sources and add it with every fact sourced. Nothing you send is published as is.",
}

/**
 * The public claim / correct / remove / object / add form (T12). It validates
 * in the browser with the server's own limits (lib/listing-request.ts), then
 * calls `listingRequests.submit`, which stores the request for review — it
 * never edits a listing directly. A hidden honeypot field catches form-filling
 * bots: if it is filled, the form pretends to succeed and sends nothing.
 */
export function RequestForm({
  initialKind,
  initialOrg,
}: {
  initialKind: ListingRequestKind
  initialOrg: OrgRef | null
}) {
  const submit = useSubmitListingRequest()
  const reduceMotion = useReducedMotion()
  const [draft, setDraft] = useState<RequestDraft>(() => emptyDraft(initialKind, initialOrg))
  const [org, setOrg] = useState<OrgRef | null>(initialOrg)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState<{ reference: string | null; kind: ListingRequestKind } | null>(
    null,
  )
  const [honeypot, setHoneypot] = useState("")
  // Sending is a script (a Convex mutation); before hydration a click would
  // submit the bare HTML form instead — a GET that drops everything typed.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  const update = (patch: Partial<RequestDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const setCorrection = (index: number, patch: Partial<RequestDraft["corrections"][number]>) =>
    update({
      corrections: draft.corrections.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    })

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setServerError(null)
    const result = validateDraft(draft)
    if (!result.ok) {
      setErrors(result.errors)
      const first = Object.keys(result.errors)[0]
      document.getElementById(`request-${first}`)?.focus()
      return
    }
    setErrors({})
    if (honeypot.trim() !== "") {
      setDone({ reference: null, kind: draft.kind })
      return
    }
    setPending(true)
    try {
      const { key } = await submit(result.args)
      setDone({ reference: key, kind: draft.kind })
    } catch (error) {
      setServerError(
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : "Something went wrong sending your request. Please try again in a moment.",
      )
    } finally {
      setPending(false)
    }
  }

  const motionProps = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
        transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] as const },
      }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {done ? (
        <motion.div key="done" {...motionProps} className="flex flex-col gap-6">
          <Alert>
            <CircleCheckIcon />
            <AlertTitle>Request received</AlertTitle>
            <AlertDescription>
              {done.reference && (
                <p>
                  Reference <span className="font-mono text-foreground">{done.reference}</span>.
                </p>
              )}
              <p>
                A person reads every request. We reply to the address you gave within one month,
                usually much sooner.
              </p>
            </AlertDescription>
          </Alert>
          <div className="flex flex-col gap-2 text-sm">
            <h2 className="font-semibold">What happens next</h2>
            <p className="text-muted-foreground">{NEXT_STEPS[done.kind]}</p>
            <p className="text-muted-foreground">
              You can object to our processing of your personal data at any time. See the{" "}
              <Link href="/privacy" className="underline underline-offset-4">
                privacy notice
              </Link>{" "}
              for your rights and how to complain.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {org && (
              <Button variant="outline" asChild>
                <Link href={`/societies/${org.slug}`}>Back to {org.name}</Link>
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(emptyDraft(draft.kind, org))
                setDone(null)
              }}
            >
              Send another request
            </Button>
          </div>
        </motion.div>
      ) : (
        <motion.form key="form" {...motionProps} onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <FieldSet>
              <FieldLegend>What would you like to do?</FieldLegend>
              <RadioGroup
                id="request-kind"
                value={draft.kind}
                onValueChange={(value) => update({ kind: value as ListingRequestKind })}
              >
                {LISTING_REQUEST_KINDS.map((kind) => (
                  <FieldLabel key={kind} htmlFor={`kind-${kind}`}>
                    <Field orientation="horizontal">
                      <RadioGroupItem
                        value={kind}
                        id={`kind-${kind}`}
                        aria-label={KIND_DETAILS[kind].title}
                      />
                      <FieldContent>
                        <FieldTitle>{KIND_DETAILS[kind].title}</FieldTitle>
                        <FieldDescription>{KIND_DETAILS[kind].description}</FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>

            {draft.kind === "add" ? (
              <>
                <Field data-invalid={Boolean(errors.newName)}>
                  <FieldLabel htmlFor="request-newName">Society name</FieldLabel>
                  <Input
                    id="request-newName"
                    value={draft.newName}
                    maxLength={LIMITS.name}
                    aria-invalid={Boolean(errors.newName)}
                    onChange={(event) => update({ newName: event.target.value })}
                  />
                  <FieldError>{errors.newName}</FieldError>
                </Field>
                <Field data-invalid={Boolean(errors.newLink)}>
                  <FieldLabel htmlFor="request-newLink">
                    Website or social page (optional)
                  </FieldLabel>
                  <Input
                    id="request-newLink"
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    value={draft.newLink}
                    aria-invalid={Boolean(errors.newLink)}
                    onChange={(event) => update({ newLink: event.target.value })}
                  />
                  <FieldError>{errors.newLink}</FieldError>
                </Field>
              </>
            ) : (
              <Field data-invalid={Boolean(errors.org)}>
                <FieldLabel htmlFor="request-org">Listing</FieldLabel>
                <OrgPicker
                  id="request-org"
                  value={org}
                  placeholder="Choose a society"
                  aria-invalid={Boolean(errors.org)}
                  onChange={(next) => {
                    setOrg(next)
                    update({ org: next })
                  }}
                />
                <FieldError>{errors.org}</FieldError>
              </Field>
            )}

            {(draft.kind === "correct" || draft.kind === "claim") && (
              <FieldSet>
                <FieldLegend variant="label">Corrections (optional)</FieldLegend>
                <FieldDescription>
                  Name the field and give the right value. Anything else can go in the message.
                </FieldDescription>
                {draft.corrections.map((row, index) => (
                  // Rows have no identity beyond their position in this draft.
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                  <div key={index} className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      value={row.field}
                      onValueChange={(field) => setCorrection(index, { field })}
                    >
                      <SelectTrigger className="sm:w-56" aria-label={`Field ${index + 1}`}>
                        <SelectValue placeholder="Field" />
                      </SelectTrigger>
                      <SelectContent>
                        {CORRECTABLE_FIELDS.map((field) => (
                          <SelectItem key={field} value={field}>
                            {ORGANISATION_FIELD_LABELS[field]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label={`Correct value ${index + 1}`}
                      value={row.value}
                      maxLength={LIMITS.fieldValue}
                      onChange={(event) => setCorrection(index, { value: event.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove correction ${index + 1}`}
                      onClick={() =>
                        update({ corrections: draft.corrections.filter((_, i) => i !== index) })
                      }
                    >
                      <TrashIcon />
                    </Button>
                  </div>
                ))}
                {draft.corrections.length < LIMITS.corrections && (
                  <Button
                    id="request-corrections"
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      update({ corrections: [...draft.corrections, { field: "", value: "" }] })
                    }
                  >
                    <PlusIcon data-icon="inline-start" />
                    Add a correction
                  </Button>
                )}
                <FieldError>{errors.corrections}</FieldError>
              </FieldSet>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <Field data-invalid={Boolean(errors.email)}>
                <FieldLabel htmlFor="request-email">Your email</FieldLabel>
                <Input
                  id="request-email"
                  type="email"
                  autoComplete="email"
                  value={draft.email}
                  maxLength={LIMITS.email}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby="request-email-help"
                  onChange={(event) => update({ email: event.target.value })}
                />
                <FieldDescription id="request-email-help">
                  Used only to reply to this request. A society address helps us confirm a claim.
                </FieldDescription>
                <FieldError>{errors.email}</FieldError>
              </Field>
              <Field data-invalid={Boolean(errors.role)}>
                <FieldLabel htmlFor="request-role">Your role (optional)</FieldLabel>
                <Input
                  id="request-role"
                  placeholder="e.g. President, Secretary"
                  value={draft.role}
                  maxLength={LIMITS.role}
                  aria-invalid={Boolean(errors.role)}
                  onChange={(event) => update({ role: event.target.value })}
                />
                <FieldError>{errors.role}</FieldError>
              </Field>
            </div>

            <Field data-invalid={Boolean(errors.message)}>
              <FieldLabel htmlFor="request-message">Message</FieldLabel>
              <Textarea
                id="request-message"
                rows={6}
                value={draft.message}
                maxLength={LIMITS.message}
                aria-invalid={Boolean(errors.message)}
                aria-describedby="request-message-count"
                onChange={(event) => update({ message: event.target.value })}
              />
              <FieldDescription id="request-message-count" className="font-mono text-xs">
                {draft.message.trim().length} / {LIMITS.message}
              </FieldDescription>
              <FieldError>{errors.message}</FieldError>
            </Field>

            {/* Honeypot: invisible to people and to assistive technology. */}
            <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="request-company">Company (leave empty)</label>
              <input
                id="request-company"
                name="company"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(event) => setHoneypot(event.target.value)}
              />
            </div>

            {serverError && (
              <Alert variant="destructive">
                <AlertTitle>Not sent</AlertTitle>
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                We keep your email and message only to handle this request. See the{" "}
                <Link href="/privacy" className="underline underline-offset-4">
                  privacy notice
                </Link>
                .
              </p>
              <Button
                type="submit"
                size="lg"
                disabled={pending || !hydrated}
                className="sm:min-w-36"
              >
                {pending ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Sending…
                  </>
                ) : (
                  "Send request"
                )}
              </Button>
            </div>
          </FieldGroup>
        </motion.form>
      )}
    </AnimatePresence>
  )
}
