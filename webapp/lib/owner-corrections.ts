import { isEmail, isHttpUrl } from "./syntax"
import {
  ACTIVITY_TYPES,
  AUDIENCES,
  BLUE_STATUSES,
  CATEGORIES,
  GENDER_CATEGORIES,
  ORG_LEVELS,
  type OrganisationField,
  ROLES,
  SOCIAL_PLATFORMS,
} from "./vocab"

/**
 * Accepting a correction: the broker turns a listing request's proposed
 * values (free text from the public form) into typed field values, which the
 * server records as `owner_submitted` claims
 * (`broker.listingRequests.acceptCorrections`; data-model §0 rule 2: never a
 * direct edit). Pure, so the dialog and `bun test` share it; the server
 * checks every value again against the field's validator.
 *
 * Imports only `./vocab` and `./syntax`, so Convex code may import it too.
 */

/** Fields an owner may correct: the public form's list (lib/listing-request.ts
 * `CORRECTABLE_FIELDS`) without the logo, which needs a stored file, not text
 * (a test keeps the two lists in step). */
export const OWNER_FIELDS = [
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
] as const satisfies readonly OrganisationField[]
export type OwnerField = (typeof OWNER_FIELDS)[number]

export function isOwnerField(field: string): field is OwnerField {
  return (OWNER_FIELDS as readonly string[]).includes(field)
}

/** How the dialog edits a field. Every editor yields text; `parseCorrection`
 * turns it into the value. */
export type FieldInput =
  | { kind: "text"; multiline: boolean; max?: number }
  | { kind: "url" }
  | { kind: "email" }
  | { kind: "boolean" }
  | { kind: "choice"; options: readonly string[] }
  /** Several of `options`, comma-separated. */
  | { kind: "choices"; options: readonly string[] }
  /** One item per line. */
  | { kind: "lines"; hint: string }
  /** A JSON object or array, for the structured fields. */
  | { kind: "json"; example: string }

const JSON_EXAMPLES: Partial<Record<OwnerField, string>> = {
  membership:
    '{"tiers": [{"label": "Life membership", "pricePence": 1500, "period": "life"}], "bursaryNote": "Ask the treasurer"}',
  trials: '{"required": true, "dates": ["2026-10-10"], "note": "Trials in Week 1"}',
  mailingList:
    '{"platform": "sympa", "signupUrl": "https://lists.cam.ac.uk/sympa/subscribe/soc-example"}',
  chatChannels: '[{"platform": "whatsapp", "howToJoin": "Ask at the freshers\' fair"}]',
}

export function fieldInput(field: OwnerField): FieldInput {
  switch (field) {
    case "description":
    case "howToJoin":
      return { kind: "text", multiline: true }
    case "shortDescription":
      return { kind: "text", multiline: true, max: 200 }
    case "name":
    case "shortName":
    case "timeCommitment":
    case "accessibilityNote":
    case "sport.sport":
    case "sport.kitCostNote":
      return { kind: "text", multiline: false }
    case "joinUrl":
    case "website":
    case "contactFormUrl":
    case "termcardUrl":
      return { kind: "url" }
    case "email":
      return { kind: "email" }
    case "beginnerFriendly":
      return { kind: "boolean" }
    case "level":
      return { kind: "choice", options: ORG_LEVELS }
    case "sport.blueStatus":
      return { kind: "choice", options: BLUE_STATUSES }
    case "categories":
      return { kind: "choices", options: CATEGORIES }
    case "activityTypes":
      return { kind: "choices", options: ACTIVITY_TYPES }
    case "audiences":
      return { kind: "choices", options: AUDIENCES }
    case "sport.genderCategories":
      return { kind: "choices", options: GENDER_CATEGORIES }
    case "aliases":
      return { kind: "lines", hint: "One name per line" }
    case "languages":
      return { kind: "lines", hint: "One ISO 639-1 code per line (en, de, zh)" }
    case "collegeKeys":
      return { kind: "lines", hint: "One college key per line (org-trinity-college)" }
    case "sport.venues":
      return { kind: "lines", hint: "One venue per line" }
    case "roleEmails":
      return { kind: "lines", hint: `One "role: address" per line (roles: ${ROLES.join(", ")})` }
    case "socials":
      return {
        kind: "lines",
        hint: 'One link per line; "platform link" when the platform is not obvious',
      }
    case "membership":
    case "trials":
    case "mailingList":
    case "chatChannels":
      return { kind: "json", example: JSON_EXAMPLES[field] ?? "{}" }
  }
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

const fail = (error: string): Parsed => ({ ok: false, error })

function lines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

const SOCIAL_HOSTS: [RegExp, (typeof SOCIAL_PLATFORMS)[number]][] = [
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "youtube"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)linktr\.ee$/, "linktree"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)bsky\.app$/, "bluesky"],
]

function socialPlatformOf(url: string): (typeof SOCIAL_PLATFORMS)[number] | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (/(^|\.)facebook\.com$/.test(host)) {
    return /\/groups\//.test(url) ? "facebook_group" : "facebook_page"
  }
  return SOCIAL_HOSTS.find(([pattern]) => pattern.test(host))?.[1]
}

/** Turns the editor's text into the field's value, or says what is wrong. */
export function parseCorrection(field: OwnerField, raw: string): Parsed {
  const input = fieldInput(field)
  const text = raw.trim()
  if (text === "") return fail("Give a value")
  switch (input.kind) {
    case "text":
      if (input.max !== undefined && text.length > input.max) {
        return fail(`At most ${input.max} characters`)
      }
      return { ok: true, value: text }
    case "url":
      return isHttpUrl(text) ? { ok: true, value: text } : fail("Not an http(s) link")
    case "email":
      return isEmail(text) ? { ok: true, value: text.toLowerCase() } : fail("Not an email address")
    case "boolean": {
      const answer = text.toLowerCase()
      if (["yes", "true"].includes(answer)) return { ok: true, value: true }
      if (["no", "false"].includes(answer)) return { ok: true, value: false }
      return fail('Say "yes" or "no"')
    }
    case "choice":
      return input.options.includes(text)
        ? { ok: true, value: text }
        : fail(`One of: ${input.options.join(", ")}`)
    case "choices": {
      const picked = [
        ...new Set(
          text
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
      const unknown = picked.filter((item) => !input.options.includes(item))
      if (unknown.length) return fail(`Not an option: ${unknown.join(", ")}`)
      return picked.length ? { ok: true, value: picked } : fail("Pick at least one")
    }
    case "lines":
      return parseLines(field, lines(text))
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown }
      } catch {
        return fail(`Not valid JSON — e.g. ${input.example}`)
      }
  }
}

function parseLines(field: OwnerField, items: string[]): Parsed {
  if (field === "roleEmails") {
    const out = []
    for (const item of items) {
      const match = /^([a-z]+)\s*:\s*(\S+)$/i.exec(item)
      const role = match?.[1].toLowerCase()
      if (!match || !role || !(ROLES as readonly string[]).includes(role)) {
        return fail(`"${item}" is not "role: address" with a known role`)
      }
      if (!isEmail(match[2])) return fail(`${match[2]} is not an email address`)
      out.push({ role, email: match[2].toLowerCase() })
    }
    return { ok: true, value: out }
  }
  if (field === "socials") {
    const out = []
    for (const item of items) {
      const [first, second] = item.split(/\s+/)
      const named = second !== undefined
      const url = named ? second : first
      const platform = named ? first.toLowerCase() : socialPlatformOf(url)
      if (!isHttpUrl(url)) return fail(`${url} is not an http(s) link`)
      if (!platform || !(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) {
        return fail(
          `Which platform is ${url}? Write "platform link" (${SOCIAL_PLATFORMS.join(", ")})`,
        )
      }
      out.push({ platform, url })
    }
    return { ok: true, value: out }
  }
  if (field === "languages") {
    const codes = items.map((item) => item.toLowerCase())
    const bad = codes.filter((code) => !/^[a-z]{2}$/.test(code))
    return bad.length
      ? fail(`Not a two-letter code: ${bad.join(", ")}`)
      : { ok: true, value: codes }
  }
  return { ok: true, value: items }
}

/** The editor's starting text for a proposed value (the form sends text). */
export function initialText(field: OwnerField, proposed: string | undefined): string {
  if (proposed === undefined) return ""
  const input = fieldInput(field)
  if (input.kind === "boolean") {
    const answer = proposed.trim().toLowerCase()
    if (["yes", "true", "y"].includes(answer)) return "yes"
    if (["no", "false", "n"].includes(answer)) return "no"
  }
  return proposed
}
