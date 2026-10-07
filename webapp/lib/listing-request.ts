import type { FunctionArgs } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { isEmail, isHttpUrl } from "./syntax"
import {
  LISTING_REQUEST_KINDS,
  type ListingRequestKind,
  ORGANISATION_FIELD_LABELS,
  type OrganisationField,
} from "./vocab"

/**
 * The public claim / correct / remove / object / add form (PLAN §2.3, T12),
 * as pure logic: the draft the form edits, its validation (the same limits
 * `listingRequests.submit` enforces, so the visitor hears about a mistake
 * before sending), and the mutation arguments it becomes.
 */

export const LIMITS = {
  email: 254,
  role: 100,
  messageMin: 10,
  message: 5_000,
  name: 200,
  fieldValue: 2_000,
  corrections: 10,
} as const

/** Fields a society would correct. Registers, derived and internal fields are
 * left out: those come from their sources, not from a form. */
export const CORRECTABLE_FIELDS = [
  "name",
  "shortName",
  "aliases",
  "shortDescription",
  "description",
  "categories",
  "activityTypes",
  "audiences",
  "howToJoin",
  "joinUrl",
  "membership",
  "beginnerFriendly",
  "trials",
  "timeCommitment",
  "website",
  "email",
  "roleEmails",
  "socials",
  "mailingList",
  "contactFormUrl",
  "chatChannels",
  "termcardUrl",
  "accessibilityNote",
  "languages",
  "level",
  "collegeKeys",
  "sport.sport",
  "sport.blueStatus",
  "sport.genderCategories",
  "sport.kitCostNote",
  "sport.venues",
  "logo",
] as const satisfies readonly OrganisationField[]

export const KIND_DETAILS: Record<ListingRequestKind, { title: string; description: string }> = {
  claim: {
    title: "Claim this listing",
    description: "You run or represent this society and want to confirm or update its details.",
  },
  correct: {
    title: "Correct something",
    description: "A fact on the listing is wrong, out of date or missing.",
  },
  remove: {
    title: "Remove this listing",
    description: "You speak for this society and want it taken off camsocs.",
  },
  object: {
    title: "Object to processing",
    description:
      "Your personal data appears here (for example an address that identifies you) and you object to its use (UK GDPR Article 21), or you want to complain.",
  },
  add: {
    title: "Add a missing society",
    description: "A society or club you know is not in the directory yet.",
  },
}

export type Correction = { field: string; value: string }

export type RequestDraft = {
  kind: ListingRequestKind
  org: { key: string; name: string } | null
  /** For `add`: the society's name and a link to it. */
  newName: string
  newLink: string
  email: string
  role: string
  message: string
  corrections: Correction[]
}

export type DraftErrors = Partial<
  Record<
    "kind" | "org" | "newName" | "newLink" | "email" | "role" | "message" | "corrections",
    string
  >
>

export type SubmitArgs = FunctionArgs<typeof api.listingRequests.submit>

export function emptyDraft(
  kind: ListingRequestKind = "claim",
  org: RequestDraft["org"] = null,
): RequestDraft {
  return {
    kind,
    org,
    newName: "",
    newLink: "",
    email: "",
    role: "",
    message: "",
    corrections: [],
  }
}

export function isRequestKind(value: string | undefined): value is ListingRequestKind {
  return (LISTING_REQUEST_KINDS as readonly string[]).includes(value ?? "")
}

/** Validates a draft; on success returns the `listingRequests.submit` args. */
export function validateDraft(
  draft: RequestDraft,
): { ok: true; args: SubmitArgs } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {}
  const email = draft.email.trim()
  const role = draft.role.trim()
  const message = draft.message.trim()

  if (!isRequestKind(draft.kind)) errors.kind = "Choose what you would like to do."
  if (draft.kind === "add") {
    const name = draft.newName.trim()
    if (name === "") errors.newName = "Give the society's name."
    else if (name.length > LIMITS.name) errors.newName = "That name is too long."
    const link = draft.newLink.trim()
    if (link !== "" && !isHttpUrl(link)) {
      errors.newLink = "Give a full web address starting with https://, or leave this empty."
    }
  } else if (draft.org === null) {
    errors.org = "Choose the listing this is about."
  }

  if (!isEmail(email) || email.length > LIMITS.email) {
    errors.email = "Give an email address we can reply to."
  }
  if (role.length > LIMITS.role) errors.role = `Keep the role under ${LIMITS.role} characters.`
  if (message.length < LIMITS.messageMin) {
    errors.message = `Tell us a little more (at least ${LIMITS.messageMin} characters).`
  } else if (message.length > LIMITS.message) {
    errors.message = `Keep the message under ${LIMITS.message} characters.`
  }

  const fields: Record<string, string> = {}
  if (draft.kind === "add") {
    fields.name = draft.newName.trim()
    if (draft.newLink.trim()) fields.website = draft.newLink.trim()
  } else if (draft.kind === "correct" || draft.kind === "claim") {
    const filled = draft.corrections.filter((row) => row.field && row.value.trim())
    if (filled.length > LIMITS.corrections) {
      errors.corrections = `At most ${LIMITS.corrections} corrections per request.`
    }
    for (const row of filled) {
      if (!(row.field in ORGANISATION_FIELD_LABELS)) {
        errors.corrections = "Choose which field each correction is for."
      } else if (row.value.trim().length > LIMITS.fieldValue) {
        errors.corrections = `Keep each correction under ${LIMITS.fieldValue} characters.`
      } else {
        fields[row.field] = row.value.trim()
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    args: {
      kind: draft.kind,
      ...(draft.kind !== "add" && draft.org ? { orgKey: draft.org.key } : {}),
      submitterEmail: email,
      ...(role ? { role } : {}),
      message,
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    },
  }
}
