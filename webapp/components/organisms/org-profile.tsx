import {
  ArrowRightIcon,
  AtSignIcon,
  CalendarDaysIcon,
  GlobeIcon,
  InfoIcon,
  LandmarkIcon,
  LockIcon,
  MailIcon,
  TagIcon,
  TrophyIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react"
import Link from "next/link"
import { ClampedText } from "@/components/molecules/clamped-text"
import { EventFlags } from "@/components/molecules/event-item"
import { ExternalLink } from "@/components/molecules/external-link"
import { Fact } from "@/components/molecules/fact"
import { OrgStatusLabel } from "@/components/molecules/org-card"
import { OrgMonogram } from "@/components/molecules/org-monogram"
import { QuickAction } from "@/components/molecules/quick-actions"
import { RelatedOrgs } from "@/components/molecules/related-orgs"
import { RichText } from "@/components/molecules/rich-text"
import { SectionTabs } from "@/components/molecules/section-tabs"
import { ShareAction } from "@/components/molecules/share-action"
import { SourcedChip, type SourcedFact } from "@/components/molecules/sourced-chip"
import { TermDateBlock } from "@/components/molecules/term-date-block"
import { UnknownFacts } from "@/components/molecules/unknown-facts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { analyticsContext } from "@/lib/analytics-events"
import {
  dayName,
  formatDateOrText,
  formatEventTime,
  formatInstantDate,
  londonIsoDate,
  weekdayShort,
} from "@/lib/calendar"
import { type EventRun, groupRuns, runSummary } from "@/lib/event-runs"
import { formatPence, languageName } from "@/lib/format"
import type {
  EventListItem,
  OrgPage,
  OrgPublic,
  OrgRelated,
  RelationshipPublic,
  SessionPublic,
} from "@/lib/public-api"
import { plainLine } from "@/lib/rich-text"
import { camSignInHref } from "@/lib/site"
import { hasValue, type PublicFieldMeta } from "@/lib/source-line"
import { cn } from "@/lib/utils"
import {
  ACTIVITY_TYPE_LABELS,
  AUDIENCE_LABELS,
  BLUE_STATUS_LABELS,
  CATEGORY_LABELS,
  CHAT_PLATFORM_LABELS,
  GENDER_CATEGORY_LABELS,
  MAILING_LIST_PLATFORM_LABELS,
  MEMBERSHIP_PERIOD_LABELS,
  ORG_LEVEL_LABELS,
  ORG_TYPE_LABELS,
  ORGANISATION_FIELD_LABELS,
  type OrganisationField,
  REGISTRATION_BODIES,
  REGISTRATION_BODY_LABELS,
  ROLE_LABELS,
  ROLES,
  SOCIAL_PLATFORM_LABELS,
  TERM_SCOPE_LABELS,
} from "@/lib/vocab"

/**
 * An organisation's public page (PLAN §2.3), student first: who they are, the
 * facts that matter at a glance, and the ways to get in touch or turn up —
 * website, Instagram, email, their events, share. Every fact keeps its
 * source, one "Sourced" chip per section away (SourcedChip); unknowns are
 * shown as unknown; the owner's claim / correct / remove route sits quietly
 * at the foot. A server component with small client islands (the chips, the
 * Read more, the phone's section tabs, Share).
 *
 * Layout: a header band, then on desktop a main column (Overview, Events,
 * related societies) beside a sticky "At a glance" column (Details); on a
 * phone one column with sticky Overview / Events / Details tabs.
 */

function Section({
  id,
  anchor,
  title,
  children,
  action,
  className,
}: {
  /** The heading's id. */
  id: string
  /** The section's own id, for in-page links. */
  anchor?: string
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <section id={anchor} aria-labelledby={id} className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-between gap-4">
        <h2 id={id} className="font-serif text-2xl font-medium tracking-tight">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A side-column card: a small heading, its Sourced chip and its rows. */
function SideCard({
  id,
  title,
  action,
  children,
}: {
  id: string
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-2xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="font-serif text-lg font-medium">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Badges({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="secondary" className="font-normal">
          {item}
        </Badge>
      ))}
    </div>
  )
}

function yesNo(value: boolean | undefined) {
  return value === undefined ? null : value ? "Yes" : "No"
}

function requestHref(org: OrgPublic, kind: "claim" | "correct" | "remove" | "object") {
  return `/request?kind=${kind}&org=${org.slug}`
}

type FactSpec = {
  label: string
  meta: PublicFieldMeta | undefined
  /** The rendered value; null / false / "" when there is none. */
  value: React.ReactNode
}

function hasContent(value: React.ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== ""
}

/**
 * A section's facts: those with a value as rows with their SourceLine, the
 * rest folded into one "Not yet known" line (UnknownFacts). Facts that do not
 * apply (`not_applicable`) are left out.
 */
function FactList({
  facts,
  correctHref,
  stacked = false,
}: {
  facts: FactSpec[]
  correctHref: string
  /** Label above value (the narrow side column), not beside it. */
  stacked?: boolean
}) {
  const applicable = facts.filter((fact) => fact.meta?.status !== "not_applicable")
  const known = applicable.filter((fact) => hasValue(fact.meta) && hasContent(fact.value))
  const unknown = applicable.filter((fact) => !known.includes(fact))
  return (
    <div className="flex flex-col gap-3">
      {known.length > 0 && (
        <dl className="divide-y">
          {known.map((fact) => (
            <Fact
              key={fact.label}
              label={fact.label}
              meta={fact.meta}
              showSource={false}
              className={stacked ? "py-2.5 sm:grid-cols-1 sm:gap-1" : undefined}
            >
              {fact.value}
            </Fact>
          ))}
        </dl>
      )}
      <UnknownFacts
        facts={unknown.map(({ label, meta }) => ({ label, meta }))}
        correctHref={correctHref}
      />
    </div>
  )
}

/** Addresses shown before the rest fold away. */
const ROLE_EMAILS_SHOWN = 6

/** Role addresses, named roles first (president, secretary, …) and the
 * organisation's other addresses after them without a label; a long list
 * folds after six. */
function RoleEmails({ entries }: { entries: OrgPublic["roleEmails"] }) {
  const sorted = [...entries].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
  const item = (entry: OrgPublic["roleEmails"][number]) => (
    <li key={`${entry.role}-${entry.email}`} className="min-w-0">
      {entry.role !== "other" && (
        <span className="text-muted-foreground">{ROLE_LABELS[entry.role]}: </span>
      )}
      <a
        href={`mailto:${entry.email}`}
        className={cn("wrap-anywhere underline-offset-4 hover:underline", PHONE_TARGET)}
      >
        {entry.email}
      </a>
    </li>
  )
  const shown = sorted.slice(0, ROLE_EMAILS_SHOWN)
  const rest = sorted.slice(ROLE_EMAILS_SHOWN)
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1">{shown.map(item)}</ul>
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">{rest.length} more addresses</span>
            <span className="hidden group-open:inline">Fewer addresses</span>
          </summary>
          <ul className="mt-1 flex flex-col gap-1">{rest.map(item)}</ul>
        </details>
      )}
    </div>
  )
}

/** Social links, one per account: the same platform and handle twice (an
 * x.com and a twitter.com link) is shown once. */
function Socials({ socials }: { socials: OrgPublic["socials"] }) {
  const seen = new Set<string>()
  const unique = socials.filter((social) => {
    const id = `${social.platform}:${(social.handle ?? social.url).replace(/^@/, "").toLowerCase()}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return (
    <ul className="flex flex-col gap-1">
      {unique.map((social) => (
        <li key={social.url} className="min-w-0">
          <ExternalLink
            href={social.url}
            className={cn("max-w-full", PHONE_TARGET)}
            outbound={{ kind: "social" }}
          >
            <span className="shrink-0">{SOCIAL_PLATFORM_LABELS[social.platform]}</span>
            {social.handle && (
              <span className="ml-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
                {social.handle.startsWith("@") ? social.handle : `@${social.handle}`}
              </span>
            )}
          </ExternalLink>
        </li>
      ))}
    </ul>
  )
}

function Membership({ membership }: { membership: NonNullable<OrgPublic["membership"]> }) {
  return (
    <div className="flex flex-col gap-1.5">
      {membership.tiers.length > 0 && (
        <ul className="flex flex-col gap-1">
          {membership.tiers.map((tier) => (
            <li key={`${tier.label}-${tier.period ?? ""}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{tier.label}</span>
              <span className="font-mono tabular-nums">
                {tier.period === "free"
                  ? "Free"
                  : [
                      tier.pricePence !== undefined ? formatPence(tier.pricePence) : undefined,
                      tier.period ? MEMBERSHIP_PERIOD_LABELS[tier.period] : undefined,
                    ]
                      .filter(Boolean)
                      .join(" ")}
              </span>
              {tier.note && <span className="text-muted-foreground">{plainLine(tier.note)}</span>}
            </li>
          ))}
        </ul>
      )}
      {membership.bursaryNote && <p>{plainLine(membership.bursaryNote)}</p>}
      {membership.collegeReimbursable && (
        <p className="text-muted-foreground">Some colleges reimburse membership.</p>
      )}
    </div>
  )
}

function Session({ session }: { session: SessionPublic }) {
  const when = [
    session.dayOfWeek !== undefined ? dayName(session.dayOfWeek) : undefined,
    session.startTime
      ? session.endTime
        ? `${session.startTime}–${session.endTime}`
        : session.startTime
      : undefined,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{session.title}</span>
        {when && <span className="font-mono text-sm text-muted-foreground">{when}</span>}
        {session.termScope && (
          <Badge variant="outline" className="font-normal">
            {TERM_SCOPE_LABELS[session.termScope]}
          </Badge>
        )}
      </div>
      {(session.venueText || session.note) && (
        <p className="text-sm text-muted-foreground">
          {[session.venueText, session.note && plainLine(session.note)].filter(Boolean).join(" · ")}
        </p>
      )}
    </li>
  )
}

/** Upcoming events listed on a profile before "all in the calendar". */
const UPCOMING_RUNS_SHOWN = 8

function relationshipText(edge: RelationshipPublic): string {
  if (edge.type === "sponsors") return edge.direction === "outgoing" ? "Sponsors" : "Sponsored by"
  if (edge.type === "co_hosted") return "Co-hosted events with"
  return edge.type.replaceAll("_", " ")
}

/** An edge's evidence pages, each once (a page can back several events). */
function evidenceUrls(edge: RelationshipPublic): string[] {
  return [...new Set(edge.evidence.map((entry) => entry.sourceUrl))].slice(0, 3)
}

const SPORT_FIELDS = [
  "sport.sport",
  "sport.blueStatus",
  "sport.varsity",
  "sport.bucs",
  "sport.collegeCompetition",
  "sport.genderCategories",
  "sport.kitCostNote",
  "sport.venues",
] as const

/** A fact value that is also a way back into the directory, filtered. */
/** A link that is a control, not prose (header meta, contact rows, the
 * request links): 44 px tall on phones (DESIGN.md), its text size elsewhere. */
const PHONE_TARGET = "max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"

function DirectoryLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      href={href}
      className={cn(
        "underline decoration-foreground/20 underline-offset-4 hover:decoration-primary",
        className,
      )}
    >
      {children}
    </Link>
  )
}

/** One key–value row of the "At a glance" card. */
function Glance({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function joinNodes(nodes: React.ReactNode[]): React.ReactNode[] {
  return nodes.flatMap((node, index) => (index === 0 ? [node] : [", ", node]))
}

/** One upcoming event (or a run of a show) as a row with its term-week date block. */
function EventRow({ run, href }: { run: EventRun<EventListItem>; href: string }) {
  const event = run.events[0]
  const day = londonIsoDate(event.startsAt)
  const when = run.events.length > 1 ? runSummary(run) : formatEventTime(event)
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-start gap-4 rounded-xl border bg-card p-3 transition-colors duration-150 hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        event.hosting === "takes_part" && "border-dashed",
      )}
    >
      <TermDateBlock
        startsAt={event.startsAt}
        termWeekLabel={event.termWeekLabel}
        label={`${weekdayShort(day)} ${formatInstantDate(event.startsAt)}${event.termWeekLabel ? `, ${event.termWeekLabel}` : ""}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
        <h3
          className={cn(
            "leading-snug font-semibold text-pretty group-hover:underline group-hover:underline-offset-4",
            event.cancelled && "line-through decoration-muted-foreground",
          )}
        >
          {event.title}
        </h3>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-xs tabular-nums">{when}</span>
          {event.venueText && <span> · {event.venueText}</span>}
        </p>
        <div className="flex flex-wrap gap-1 empty:hidden">
          <EventFlags event={event} />
        </div>
      </div>
    </Link>
  )
}

export function OrgProfile({
  page,
  collegeNames,
  hiddenEvents,
  related,
}: {
  page: OrgPage
  collegeNames: Record<string, string>
  /** Cambridge-only upcoming events this viewer cannot see (null: unknown). */
  hiddenEvents: number | null
  /** Related listings (`orgs.related`); empty when there are none. */
  related: OrgRelated
}) {
  const { org, teams, sessions, events, relationships } = page
  const meta = org.meta
  const hasSport = SPORT_FIELDS.some(
    (field) => meta[field] && meta[field].status !== "not_applicable",
  )
  const registrations = REGISTRATION_BODIES.filter((body) => org.registrations[body] !== undefined)
  const missing = org.missingFields.filter(
    (field): field is OrganisationField => field in ORGANISATION_FIELD_LABELS,
  )
  const correctHref = requestHref(org, "correct")
  const calendarHref = `/events?weeks=4&org=${org.slug}`
  const runs = groupRuns(events)
  const firstCategory = org.categories[0]

  const instagram = org.socials.find((social) => social.platform === "instagram")
  const email =
    org.email ??
    [...org.roleEmails].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))[0]?.email
  const joinHref = org.joinUrl ?? org.mailingList?.signupUrl
  const blue =
    org.sport?.blueStatus && org.sport.blueStatus !== "none"
      ? BLUE_STATUS_LABELS[org.sport.blueStatus]
      : undefined

  const gettingInvolved: FactSpec[] = [
    {
      label: "How to join",
      meta: meta.howToJoin,
      value: org.howToJoin && <RichText text={org.howToJoin} />,
    },
    {
      label: "Join link",
      meta: meta.joinUrl,
      value: org.joinUrl && <ExternalLink href={org.joinUrl} outbound={{ kind: "other" }} />,
    },
    {
      label: "Membership",
      meta: meta.membership,
      value: org.membership && <Membership membership={org.membership} />,
    },
    { label: "Beginner-friendly", meta: meta.beginnerFriendly, value: yesNo(org.beginnerFriendly) },
    {
      label: "Trials or auditions",
      meta: meta.trials,
      value: org.trials && (
        <div className="flex flex-col gap-1">
          <span>{org.trials.required ? "Required" : "Not required"}</span>
          {org.trials.dates && org.trials.dates.length > 0 && (
            <span className="font-mono text-xs">
              {org.trials.dates.map(formatDateOrText).join(", ")}
            </span>
          )}
          {org.trials.note && (
            <span className="text-muted-foreground">{plainLine(org.trials.note)}</span>
          )}
        </div>
      ),
    },
    {
      label: "Time commitment",
      meta: meta.timeCommitment,
      value: org.timeCommitment && <RichText text={org.timeCommitment} />,
    },
    {
      label: "Accessibility",
      meta: meta.accessibilityNote,
      value: org.accessibilityNote && <RichText text={org.accessibilityNote} />,
    },
    {
      label: "Termcard",
      meta: meta.termcardUrl,
      value: org.termcardUrl && (
        <ExternalLink href={org.termcardUrl} outbound={{ kind: "other" }}>
          Termcard
        </ExternalLink>
      ),
    },
  ]

  const sportFacts: FactSpec[] = [
    { label: "Sport", meta: meta["sport.sport"], value: org.sport?.sport },
    {
      label: "Blue status",
      meta: meta["sport.blueStatus"],
      value: blue ?? (org.sport?.blueStatus && BLUE_STATUS_LABELS[org.sport.blueStatus]),
    },
    { label: "Varsity match", meta: meta["sport.varsity"], value: yesNo(org.sport?.varsity) },
    { label: "BUCS competition", meta: meta["sport.bucs"], value: yesNo(org.sport?.bucs) },
    {
      label: "College competition",
      meta: meta["sport.collegeCompetition"],
      value: yesNo(org.sport?.collegeCompetition),
    },
    {
      label: "Teams for",
      meta: meta["sport.genderCategories"],
      value: org.sport && org.sport.genderCategories.length > 0 && (
        <Badges items={org.sport.genderCategories.map((item) => GENDER_CATEGORY_LABELS[item])} />
      ),
    },
    { label: "Kit costs", meta: meta["sport.kitCostNote"], value: org.sport?.kitCostNote },
    { label: "Training venues", meta: meta["sport.venues"], value: org.sport?.venues?.join(", ") },
  ]

  const contactFacts: FactSpec[] = [
    {
      label: "Website",
      meta: meta.website,
      value: org.website && (
        <ExternalLink href={org.website} className={PHONE_TARGET} outbound={{ kind: "website" }} />
      ),
    },
    {
      label: "General email",
      meta: meta.email,
      value: org.email && (
        <a
          href={`mailto:${org.email}`}
          className={cn("wrap-anywhere underline-offset-4 hover:underline", PHONE_TARGET)}
        >
          {org.email}
        </a>
      ),
    },
    {
      label: "Role addresses",
      meta: meta.roleEmails,
      value: org.roleEmails.length > 0 && <RoleEmails entries={org.roleEmails} />,
    },
    {
      label: "Social media",
      meta: meta.socials,
      value: org.socials.length > 0 && <Socials socials={org.socials} />,
    },
    {
      label: "Mailing list",
      meta: meta.mailingList,
      value: org.mailingList && (org.mailingList.signupUrl || org.mailingList.platform) && (
        <span className="flex flex-wrap items-baseline gap-x-2">
          {org.mailingList.signupUrl && (
            <ExternalLink href={org.mailingList.signupUrl} outbound={{ kind: "other" }}>
              Sign up
            </ExternalLink>
          )}
          {org.mailingList.platform && (
            <span className="text-muted-foreground">
              {MAILING_LIST_PLATFORM_LABELS[org.mailingList.platform]}
            </span>
          )}
        </span>
      ),
    },
    // Shown only when there is one: most societies have none, and an
    // address or a form is enough.
    ...(org.contactFormUrl
      ? [
          {
            label: "Contact form",
            meta: meta.contactFormUrl,
            value: <ExternalLink href={org.contactFormUrl} outbound={{ kind: "other" }} />,
          },
        ]
      : []),
    ...(org.chatChannels.length > 0
      ? [
          {
            label: "Group chats",
            meta: meta.chatChannels,
            value: (
              <ul className="flex flex-col gap-1">
                {org.chatChannels.map((channel) => (
                  <li key={channel.platform}>
                    <span className="font-medium">{CHAT_PLATFORM_LABELS[channel.platform]}</span>
                    {channel.howToJoin && (
                      <span className="text-muted-foreground">
                        {" "}
                        — {plainLine(channel.howToJoin)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ),
          },
        ]
      : []),
  ]

  const sourced = (facts: FactSpec[]): SourcedFact[] =>
    facts.map(({ label, meta: factMeta }) => ({ label, meta: factMeta }))
  const glanceSources: SourcedFact[] = [
    { label: "Type", meta: meta.orgType },
    { label: "Level", meta: meta.level },
    { label: "College", meta: meta.collegeKeys },
    { label: "Categories", meta: meta.categories },
    { label: "Who it is for", meta: meta.audiences },
    { label: "Activities", meta: meta.activityTypes },
    { label: "Languages", meta: meta.languages },
  ]
  const sessionSources: SourcedFact[] = sessions.map((session) => ({
    label: session.title,
    meta: session.meta.title,
  }))
  const glanceKnown = (field: string) => hasValue(meta[field] as PublicFieldMeta | undefined)

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "events", label: "Events", count: runs.length > 0 ? runs.length : undefined },
    { id: "details", label: "Details" },
  ]

  return (
    // Every tracked link inside carries the listing's key (ENG-5).
    <article {...analyticsContext({ orgKey: org.key })}>
      <header className="border-b bg-card/40">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 pt-6 pb-7 sm:px-6 sm:pt-8">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-x-2">
              <li>
                <Link href="/societies" className={cn("hover:text-foreground", PHONE_TARGET)}>
                  Societies
                </Link>
              </li>
              {firstCategory && (
                <li className="flex items-center gap-2">
                  <span aria-hidden>/</span>
                  <Link
                    href={`/societies?cat=${firstCategory}`}
                    className={cn("hover:text-foreground", PHONE_TARGET)}
                  >
                    {CATEGORY_LABELS[firstCategory]}
                  </Link>
                </li>
              )}
            </ol>
          </nav>

          <div className="flex items-start gap-4 sm:gap-6">
            <OrgMonogram
              name={org.name}
              shortName={org.shortName}
              url={org.logo?.url}
              categories={org.categories}
              college={org.collegeKeys.length > 0}
              size={88}
              className="max-sm:size-16!"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <h1 className="font-serif text-3xl leading-[1.1] font-medium tracking-tight text-balance sm:text-5xl">
                {org.name}
              </h1>
              {(org.shortName || org.aliases.length > 0) && (
                <p className="text-sm text-muted-foreground">
                  Also known as{" "}
                  {[org.shortName, ...org.aliases]
                    .filter((name, index, all) => name && all.indexOf(name) === index)
                    .join(", ")}
                </p>
              )}
            </div>
          </div>

          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {firstCategory && (
              <li className="flex items-center gap-1.5">
                <TagIcon aria-hidden className="size-4 text-muted-foreground" />
                <DirectoryLink href={`/societies?cat=${firstCategory}`} className={PHONE_TARGET}>
                  {CATEGORY_LABELS[firstCategory]}
                </DirectoryLink>
              </li>
            )}
            {org.collegeKeys.length > 0 ? (
              <li className="flex items-center gap-1.5">
                <LandmarkIcon aria-hidden className="size-4 text-muted-foreground" />
                <span>
                  {joinNodes(
                    org.collegeKeys.map((key) => (
                      <DirectoryLink
                        key={key}
                        href={`/societies?college=${key}`}
                        className={PHONE_TARGET}
                      >
                        {collegeNames[key] ?? key}
                      </DirectoryLink>
                    )),
                  )}
                </span>
              </li>
            ) : org.level ? (
              <li className="flex items-center gap-1.5">
                <UsersIcon aria-hidden className="size-4 text-muted-foreground" />
                <DirectoryLink href={`/societies?level=${org.level}`} className={PHONE_TARGET}>
                  {ORG_LEVEL_LABELS[org.level]}
                </DirectoryLink>
              </li>
            ) : null}
            {blue && (
              <li className="flex items-center gap-1.5">
                <TrophyIcon aria-hidden className="size-4 text-muted-foreground" />
                {blue}
              </li>
            )}
            <li className="flex items-center gap-2">
              <OrgStatusLabel status={org.status} className="text-sm" />
              {org.lastActiveAt && (
                <span className="text-xs text-muted-foreground">
                  last seen {formatInstantDate(org.lastActiveAt)}
                </span>
              )}
            </li>
          </ul>

          {org.shortDescription && (
            <p className="max-w-3xl text-lg leading-relaxed text-pretty">
              {plainLine(org.shortDescription)}
            </p>
          )}

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="grid w-full auto-cols-fr grid-flow-col gap-1 sm:flex sm:w-auto sm:flex-wrap sm:gap-2">
              {joinHref && (
                <QuickAction
                  href={joinHref}
                  icon={UserPlusIcon}
                  label="Join"
                  external
                  primary
                  outbound={{ kind: "other" }}
                />
              )}
              {org.website && (
                <QuickAction
                  href={org.website}
                  icon={GlobeIcon}
                  label="Website"
                  external
                  primary={!joinHref}
                  outbound={{ kind: "website" }}
                />
              )}
              {instagram && (
                <QuickAction
                  href={instagram.url}
                  icon={AtSignIcon}
                  label="Instagram"
                  external
                  outbound={{ kind: "social" }}
                />
              )}
              {email && <QuickAction href={`mailto:${email}`} icon={MailIcon} label="Email" />}
              <QuickAction href={calendarHref} icon={CalendarDaysIcon} label="Calendar" />
              <ShareAction title={org.name} path={`/societies/${org.slug}`} />
            </div>
            <SourcedChip
              section="this header"
              facts={[
                { label: "Name", meta: meta.name },
                { label: "Categories", meta: meta.categories },
                { label: "Short description", meta: meta.shortDescription },
                { label: "Website", meta: meta.website },
                { label: "Social media", meta: meta.socials },
              ]}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <SectionTabs tabs={tabs} />
        <div className="grid gap-12 py-8 lg:grid-cols-[1fr_21rem] lg:gap-14 lg:py-10">
          <div className="flex min-w-0 flex-col gap-14">
            <div
              id="overview"
              className="flex scroll-mt-[calc(var(--site-header-height,4rem)+4rem)] flex-col gap-12"
            >
              {org.status === "archived" && (
                <Alert>
                  <InfoIcon />
                  <AlertTitle>Marked as no longer active</AlertTitle>
                  <AlertDescription>
                    A source lists this group as defunct. If it is running again,{" "}
                    <Link href={correctHref}>tell us</Link>.
                  </AlertDescription>
                </Alert>
              )}
              {org.isCounterpart && (
                <Alert>
                  <InfoIcon />
                  <AlertTitle>A partner organisation</AlertTitle>
                  <AlertDescription>
                    Listed because societies in the directory name it as a sponsor, host or partner.
                  </AlertDescription>
                </Alert>
              )}

              <Section
                id="about"
                title="About"
                action={
                  <SourcedChip
                    section="About"
                    facts={[{ label: "Description", meta: meta.description }]}
                  />
                }
              >
                {org.description ? (
                  <ClampedText lines={6}>
                    <RichText text={org.description} className="text-base" />
                  </ClampedText>
                ) : (
                  <UnknownFacts
                    facts={[{ label: "Description", meta: meta.description }]}
                    correctHref={correctHref}
                  />
                )}
              </Section>

              <Section
                id="involved"
                title="Getting involved"
                action={<SourcedChip section="Getting involved" facts={sourced(gettingInvolved)} />}
              >
                <FactList correctHref={correctHref} facts={gettingInvolved} />
              </Section>

              {sessions.length > 0 && (
                <Section
                  id="sessions"
                  title="Regular sessions"
                  action={<SourcedChip section="Regular sessions" facts={sessionSources} />}
                >
                  <ul className="divide-y">
                    {sessions.map((session) => (
                      <Session key={session.key} session={session} />
                    ))}
                  </ul>
                </Section>
              )}

              {hasSport && (
                <Section
                  id="sport"
                  title="Sport"
                  action={
                    <SourcedChip
                      section="Sport"
                      facts={[
                        ...sourced(sportFacts),
                        ...teams.map((team) => ({ label: team.name, meta: team.meta.name })),
                      ]}
                    />
                  }
                >
                  <FactList correctHref={correctHref} facts={sportFacts} />
                  {teams.length > 0 && (
                    <div className="flex flex-col gap-2 pt-2">
                      <h3 className="text-sm font-medium">Teams</h3>
                      <ul className="divide-y rounded-xl border bg-card">
                        {teams.map((team) => (
                          <li
                            key={team.key}
                            className="flex flex-wrap items-baseline gap-x-3 px-4 py-3"
                          >
                            <span className="font-medium">{team.name}</span>
                            {team.gender && (
                              <span className="text-sm text-muted-foreground">
                                {GENDER_CATEGORY_LABELS[team.gender]}
                              </span>
                            )}
                            {team.league && (
                              <span className="font-mono text-xs text-muted-foreground">
                                {team.league}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Section>
              )}
            </div>

            <Section
              id="events-heading"
              anchor="events"
              title="Coming up"
              className="scroll-mt-[calc(var(--site-header-height,4rem)+4rem)]"
              action={
                <Link
                  href={calendarHref}
                  className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-8"
                >
                  In the calendar
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              }
            >
              {runs.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {runs.slice(0, UPCOMING_RUNS_SHOWN).map((run) => (
                    <li key={run.key} className="min-w-0">
                      <EventRow run={run} href={`${calendarHref}&event=${run.key}`} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                  <CalendarDaysIcon aria-hidden className="size-4" />
                  Nothing coming up in the sources we read.
                </p>
              )}
              {runs.length > UPCOMING_RUNS_SHOWN && (
                <Link
                  href={calendarHref}
                  className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium underline-offset-4 hover:underline"
                >
                  All {events.length} upcoming events in the calendar
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              )}
              {hiddenEvents !== null && hiddenEvents > 0 && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LockIcon aria-hidden className="size-4" />
                  <span>
                    {hiddenEvents} more Cambridge-only {hiddenEvents === 1 ? "event" : "events"} —{" "}
                    <Link
                      href={camSignInHref(`/societies/${org.slug}`)}
                      className="underline underline-offset-4"
                    >
                      sign in with your @cam.ac.uk email
                    </Link>
                  </span>
                </p>
              )}
            </Section>

            {related.length > 0 && (
              <Section
                id="related"
                title="Related societies"
                action={
                  firstCategory && (
                    <Link
                      href={`/societies?cat=${firstCategory}`}
                      className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-8"
                    >
                      More in {CATEGORY_LABELS[firstCategory]}
                      <ArrowRightIcon aria-hidden className="size-3.5" />
                    </Link>
                  )
                }
              >
                <RelatedOrgs orgs={related} collegeNames={collegeNames} />
              </Section>
            )}

            {relationships.length > 0 && (
              <Section id="connections" title="Connections">
                <ul className="divide-y">
                  {relationships.map((edge) => (
                    <li key={edge.key} className="flex flex-col gap-1 py-3">
                      <p className="text-sm">
                        <span className="text-muted-foreground">{relationshipText(edge)} </span>
                        <Link
                          href={`/societies/${edge.counterpart.slug}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {edge.counterpart.name}
                        </Link>
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                        {evidenceUrls(edge).map((url) => (
                          <ExternalLink key={url} href={url} outbound={{ kind: "source" }} />
                        ))}
                        <span>last seen {formatInstantDate(edge.lastSeenAt)}</span>
                        <span>{Math.round(edge.confidence * 100)}%</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>

          <aside
            id="details"
            aria-label="Details"
            className="min-w-0 scroll-mt-[calc(var(--site-header-height,4rem)+4rem)]"
          >
            {/* Sticky, but never taller than the window: a long Contact card
                scrolls inside the column instead of hiding its foot (and the
                "Is this your society?" card) until the page ends. */}
            <div className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--site-header-height,4rem)+1.5rem)] lg:-mx-1 lg:max-h-[calc(100svh-var(--site-header-height,4rem)-3rem)] lg:overflow-y-auto lg:overscroll-contain lg:px-1 lg:pb-1 lg:[scrollbar-width:thin]">
              <SideCard
                id="glance"
                title="At a glance"
                action={<SourcedChip section="At a glance" facts={glanceSources} />}
              >
                <dl className="divide-y">
                  {org.orgType && glanceKnown("orgType") && (
                    <Glance label="Type">{ORG_TYPE_LABELS[org.orgType]}</Glance>
                  )}
                  {org.level && (
                    <Glance label="Level">
                      <DirectoryLink href={`/societies?level=${org.level}`}>
                        {ORG_LEVEL_LABELS[org.level]}
                      </DirectoryLink>
                    </Glance>
                  )}
                  {org.collegeKeys.length > 0 && (
                    <Glance label={org.collegeKeys.length === 1 ? "College" : "Colleges"}>
                      {joinNodes(
                        org.collegeKeys.map((key) => (
                          <DirectoryLink key={key} href={`/societies?college=${key}`}>
                            {collegeNames[key] ?? key}
                          </DirectoryLink>
                        )),
                      )}
                    </Glance>
                  )}
                  {org.categories.length > 0 && (
                    <Glance label="Categories">
                      {joinNodes(
                        org.categories.map((category) => (
                          <DirectoryLink key={category} href={`/societies?cat=${category}`}>
                            {CATEGORY_LABELS[category]}
                          </DirectoryLink>
                        )),
                      )}
                    </Glance>
                  )}
                  {org.audiences.length > 0 && (
                    <Glance label="Who it is for">
                      {joinNodes(
                        org.audiences.map((audience) => (
                          <DirectoryLink key={audience} href={`/societies?audience=${audience}`}>
                            {AUDIENCE_LABELS[audience]}
                          </DirectoryLink>
                        )),
                      )}
                    </Glance>
                  )}
                  {org.activityTypes.length > 0 && (
                    <Glance label="Activities">
                      {joinNodes(
                        org.activityTypes.map((activity) => (
                          <DirectoryLink key={activity} href={`/societies?activity=${activity}`}>
                            {ACTIVITY_TYPE_LABELS[activity]}
                          </DirectoryLink>
                        )),
                      )}
                    </Glance>
                  )}
                  {org.languages.length > 0 && (
                    <Glance label="Languages">{org.languages.map(languageName).join(", ")}</Glance>
                  )}
                  <Glance label="Status">
                    <OrgStatusLabel status={org.status} className="text-sm text-foreground" />
                  </Glance>
                  {registrations.length > 0 && (
                    <Glance label="Registers">
                      <ul className="flex flex-col gap-0.5">
                        {registrations.map((body) => {
                          const entry = org.registrations[body]
                          return (
                            <li key={body}>
                              {REGISTRATION_BODY_LABELS[body]}:{" "}
                              <span className="text-muted-foreground">
                                {entry?.registered ? "listed" : "not listed"}
                                {entry?.year ? ` (${entry.year})` : ""}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </Glance>
                  )}
                </dl>
              </SideCard>

              <SideCard
                id="contact"
                title="Contact"
                action={
                  <SourcedChip
                    section="Contact"
                    facts={[
                      ...sourced(contactFacts),
                      ...registrations.map((body) => ({
                        label: REGISTRATION_BODY_LABELS[body],
                        meta: meta[`registrations.${body}`],
                      })),
                    ]}
                  />
                }
              >
                <FactList stacked correctHref={correctHref} facts={contactFacts} />
              </SideCard>

              <section
                aria-labelledby="owner"
                className="flex flex-col gap-1.5 rounded-2xl border border-dashed p-5 text-sm"
              >
                <h2 id="owner" className="font-medium">
                  Is this your society?
                </h2>
                <p className="text-muted-foreground">
                  Claim the listing to confirm details or fix anything wrong. A person reads every
                  request.
                  {missing.length > 0 &&
                    ` ${missing.length} ${missing.length === 1 ? "detail is" : "details are"} not published anywhere we read yet.`}
                </p>
                <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1 max-sm:gap-y-0">
                  <Link
                    href={requestHref(org, "claim")}
                    className={cn("font-medium underline underline-offset-4", PHONE_TARGET)}
                  >
                    Claim it
                  </Link>
                  <Link
                    href={correctHref}
                    className={cn("underline underline-offset-4", PHONE_TARGET)}
                  >
                    {missing.length > 0 ? "Correct or complete" : "Correct something"}
                  </Link>
                  <Link
                    href={requestHref(org, "remove")}
                    className={cn(
                      "text-muted-foreground underline underline-offset-4",
                      PHONE_TARGET,
                    )}
                  >
                    Ask for removal
                  </Link>
                </p>
              </section>

              <p className="px-1 text-xs text-muted-foreground">
                Listing updated{" "}
                <span className="font-mono">{formatInstantDate(org.updatedAt)}</span>, from public
                sources.{" "}
                <Link href="/about#data" className="underline underline-offset-4">
                  How we collect data
                </Link>
              </p>
            </div>
          </aside>
        </div>
      </div>
    </article>
  )
}
