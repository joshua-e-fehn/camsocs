import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CalendarDaysIcon,
  FlagIcon,
  InfoIcon,
  LockIcon,
  PencilLineIcon,
} from "lucide-react"
import Link from "next/link"
import { EventItem } from "@/components/molecules/event-item"
import { ExternalLink } from "@/components/molecules/external-link"
import { Fact } from "@/components/molecules/fact"
import { OrgLogo, OrgStatusLabel } from "@/components/molecules/org-card"
import { SourceLine } from "@/components/molecules/source-line"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { dayName, formatDate, formatInstantDate } from "@/lib/calendar"
import { formatPence, languageName, paragraphs } from "@/lib/format"
import type { OrgPage, OrgPublic, RelationshipPublic, SessionPublic } from "@/lib/public-api"
import { camSignInHref } from "@/lib/site"
import { hasValue } from "@/lib/source-line"
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
  SOCIAL_PLATFORM_LABELS,
  TERM_SCOPE_LABELS,
} from "@/lib/vocab"

/**
 * An organisation's public page (PLAN §2.3): every fact with its SourceLine,
 * unknowns shown as unknown, and the claim / correct / remove route in plain
 * sight. A server component: it has nothing interactive, so it ships no
 * JavaScript of its own.
 */

function Section({
  id,
  title,
  children,
  action,
}: {
  id: string
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4 border-b pb-2">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
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

function Membership({ membership }: { membership: NonNullable<OrgPublic["membership"]> }) {
  return (
    <div className="flex flex-col gap-1.5">
      {membership.tiers.length > 0 && (
        <ul className="flex flex-col gap-1">
          {membership.tiers.map((tier) => (
            <li key={`${tier.label}-${tier.period}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{tier.label}</span>
              <span className="font-mono tabular-nums">
                {tier.period === "free"
                  ? "Free"
                  : tier.pricePence !== undefined
                    ? `${formatPence(tier.pricePence)} ${MEMBERSHIP_PERIOD_LABELS[tier.period]}`
                    : MEMBERSHIP_PERIOD_LABELS[tier.period]}
              </span>
              {tier.note && <span className="text-muted-foreground">{tier.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {membership.bursaryNote && <p>{membership.bursaryNote}</p>}
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
          {[session.venueText, session.note].filter(Boolean).join(" · ")}
        </p>
      )}
      <SourceLine meta={session.meta.title} />
    </li>
  )
}

function relationshipText(edge: RelationshipPublic): string {
  if (edge.type === "sponsors") return edge.direction === "outgoing" ? "Sponsors" : "Sponsored by"
  if (edge.type === "co_hosted") return "Co-hosted events with"
  return edge.type.replaceAll("_", " ")
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

export function OrgProfile({
  page,
  collegeNames,
  hiddenEvents,
}: {
  page: OrgPage
  collegeNames: Record<string, string>
  /** Cambridge-only upcoming events this viewer cannot see (null: unknown). */
  hiddenEvents: number | null
}) {
  const { org, teams, sessions, events, relationships } = page
  const meta = org.meta
  const colleges = org.collegeKeys.map((key) => collegeNames[key] ?? key)
  const placement = [
    org.orgType ? ORG_TYPE_LABELS[org.orgType] : undefined,
    org.level ? ORG_LEVEL_LABELS[org.level] : undefined,
    ...colleges,
  ].filter((item): item is string => Boolean(item))
  const hasSport = SPORT_FIELDS.some(
    (field) => meta[field] && meta[field].status !== "not_applicable",
  )
  const registrations = REGISTRATION_BODIES.filter((body) => org.registrations[body] !== undefined)
  const missing = org.missingFields.filter(
    (field): field is OrganisationField => field in ORGANISATION_FIELD_LABELS,
  )

  return (
    <article>
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <Link href="/societies" className="hover:text-foreground">
              Societies
            </Link>
            <span aria-hidden className="px-2">
              /
            </span>
            <span aria-current="page" className="text-foreground">
              {org.name}
            </span>
          </nav>

          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="flex items-start gap-4">
              <OrgLogo
                name={org.name}
                shortName={org.shortName}
                url={org.logo?.url}
                size={72}
                className="rounded-xl"
              />
              <div className="flex min-w-0 flex-col gap-2">
                <h1 className="text-3xl font-bold tracking-tight text-balance">{org.name}</h1>
                {(org.shortName || org.aliases.length > 0) && (
                  <p className="text-sm text-muted-foreground">
                    Also known as{" "}
                    {[org.shortName, ...org.aliases]
                      .filter((name, index, all) => name && all.indexOf(name) === index)
                      .join(", ")}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  {placement.length > 0 && <span>{placement.join(" · ")}</span>}
                  <OrgStatusLabel status={org.status} />
                  {org.lastActiveAt && (
                    <span className="font-mono text-xs">
                      last activity {formatInstantDate(org.lastActiveAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              {org.website && (
                <Button variant="outline" asChild>
                  <a href={org.website} target="_blank" rel="noopener noreferrer nofollow">
                    Website
                    <ArrowUpRightIcon data-icon="inline-end" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </Button>
              )}
              <Button asChild>
                <Link href={requestHref(org, "claim")}>
                  <FlagIcon data-icon="inline-start" />
                  Is this your society?
                </Link>
              </Button>
            </div>
          </div>

          {org.categories.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Badges items={org.categories.map((category) => CATEGORY_LABELS[category])} />
              <SourceLine meta={meta.categories} />
            </div>
          )}

          {org.shortDescription ? (
            <div className="flex max-w-3xl flex-col gap-1.5">
              <p className="text-lg text-pretty">{org.shortDescription}</p>
              <SourceLine meta={meta.shortDescription} />
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-7xl gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex min-w-0 flex-col gap-10">
          {org.status === "archived" && (
            <Alert>
              <InfoIcon />
              <AlertTitle>Marked as no longer active</AlertTitle>
              <AlertDescription>
                A source lists this group as defunct. If it is running again,{" "}
                <Link href={requestHref(org, "correct")}>tell us</Link>.
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

          <Section id="about" title="About">
            {org.description ? (
              <div className="flex flex-col gap-3">
                <div className="flex max-w-prose flex-col gap-3 text-sm leading-relaxed">
                  {paragraphs(org.description).map((paragraph) => (
                    <p key={paragraph} className="whitespace-pre-line">
                      {paragraph}
                    </p>
                  ))}
                </div>
                <SourceLine meta={meta.description} />
              </div>
            ) : (
              <SourceLine meta={meta.description} />
            )}
          </Section>

          <Section id="practical" title="Practical information">
            <dl className="divide-y">
              <Fact label="How to join" meta={meta.howToJoin}>
                {org.howToJoin && <p className="whitespace-pre-line">{org.howToJoin}</p>}
              </Fact>
              <Fact label="Join link" meta={meta.joinUrl}>
                {org.joinUrl && <ExternalLink href={org.joinUrl} />}
              </Fact>
              <Fact label="Membership" meta={meta.membership}>
                {org.membership && <Membership membership={org.membership} />}
              </Fact>
              <Fact label="Beginner-friendly" meta={meta.beginnerFriendly}>
                {yesNo(org.beginnerFriendly)}
              </Fact>
              <Fact label="Trials or auditions" meta={meta.trials}>
                {org.trials && (
                  <div className="flex flex-col gap-1">
                    <span>{org.trials.required ? "Required" : "Not required"}</span>
                    {org.trials.dates && org.trials.dates.length > 0 && (
                      <span className="font-mono text-xs">
                        {org.trials.dates.map(formatDate).join(", ")}
                      </span>
                    )}
                    {org.trials.note && (
                      <span className="text-muted-foreground">{org.trials.note}</span>
                    )}
                  </div>
                )}
              </Fact>
              <Fact label="Time commitment" meta={meta.timeCommitment}>
                {org.timeCommitment}
              </Fact>
              <Fact label="Activities" meta={meta.activityTypes}>
                {org.activityTypes.length > 0 && (
                  <Badges items={org.activityTypes.map((item) => ACTIVITY_TYPE_LABELS[item])} />
                )}
              </Fact>
              <Fact label="Who it is for" meta={meta.audiences}>
                {org.audiences.length > 0 && (
                  <Badges items={org.audiences.map((item) => AUDIENCE_LABELS[item])} />
                )}
              </Fact>
              <Fact label="Languages" meta={meta.languages}>
                {org.languages.length > 0 && org.languages.map(languageName).join(", ")}
              </Fact>
              <Fact label="Accessibility" meta={meta.accessibilityNote}>
                {org.accessibilityNote}
              </Fact>
              <Fact label="Termcard" meta={meta.termcardUrl}>
                {org.termcardUrl && <ExternalLink href={org.termcardUrl}>Termcard</ExternalLink>}
              </Fact>
            </dl>
          </Section>

          {sessions.length > 0 && (
            <Section id="sessions" title="Regular sessions">
              <ul className="divide-y">
                {sessions.map((session) => (
                  <Session key={session.key} session={session} />
                ))}
              </ul>
            </Section>
          )}

          {hasSport && (
            <Section id="sport" title="Sport">
              <dl className="divide-y">
                <Fact label="Sport" meta={meta["sport.sport"]}>
                  {org.sport?.sport}
                </Fact>
                <Fact label="Blue status" meta={meta["sport.blueStatus"]}>
                  {org.sport?.blueStatus && BLUE_STATUS_LABELS[org.sport.blueStatus]}
                </Fact>
                <Fact label="Varsity match" meta={meta["sport.varsity"]}>
                  {yesNo(org.sport?.varsity)}
                </Fact>
                <Fact label="BUCS competition" meta={meta["sport.bucs"]}>
                  {yesNo(org.sport?.bucs)}
                </Fact>
                <Fact label="College competition" meta={meta["sport.collegeCompetition"]}>
                  {yesNo(org.sport?.collegeCompetition)}
                </Fact>
                <Fact label="Gender categories" meta={meta["sport.genderCategories"]}>
                  {org.sport && org.sport.genderCategories.length > 0 && (
                    <Badges
                      items={org.sport.genderCategories.map((item) => GENDER_CATEGORY_LABELS[item])}
                    />
                  )}
                </Fact>
                <Fact label="Kit costs" meta={meta["sport.kitCostNote"]}>
                  {org.sport?.kitCostNote}
                </Fact>
                <Fact label="Training venues" meta={meta["sport.venues"]}>
                  {org.sport?.venues?.join(", ")}
                </Fact>
              </dl>
              {teams.length > 0 && (
                <div className="flex flex-col gap-2 pt-2">
                  <h3 className="text-sm font-medium">Teams</h3>
                  <ul className="divide-y rounded-xl border">
                    {teams.map((team) => (
                      <li key={team.key} className="flex flex-col gap-1 px-4 py-3">
                        <div className="flex flex-wrap items-baseline gap-x-3">
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
                        </div>
                        <SourceLine meta={team.meta.name} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          <Section
            id="events"
            title="Upcoming events"
            action={
              <Link
                href={`/events?org=${org.slug}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                In the calendar
              </Link>
            }
          >
            {events.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {events.map((event) => (
                  <li key={event.key} className="min-w-0">
                    <EventItem event={event} href={`/events?org=${org.slug}&event=${event.key}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarDaysIcon aria-hidden className="size-4" />
                No upcoming events found in the sources we read.
              </p>
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
                      {edge.evidence.slice(0, 3).map((entry) => (
                        <ExternalLink key={entry.sourceUrl} href={entry.sourceUrl} />
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

        <aside className="flex flex-col gap-8">
          <Section id="contact" title="Contact">
            <dl className="divide-y">
              <Fact label="Website" meta={meta.website} className="sm:grid-cols-1 sm:gap-1">
                {org.website && <ExternalLink href={org.website} />}
              </Fact>
              <Fact label="General email" meta={meta.email} className="sm:grid-cols-1 sm:gap-1">
                {org.email && (
                  <a
                    href={`mailto:${org.email}`}
                    className="break-all underline-offset-4 hover:underline"
                  >
                    {org.email}
                  </a>
                )}
              </Fact>
              <Fact
                label="Role addresses"
                meta={meta.roleEmails}
                className="sm:grid-cols-1 sm:gap-1"
              >
                {org.roleEmails.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {org.roleEmails.map((entry) => (
                      <li key={`${entry.role}-${entry.email}`}>
                        <span className="text-muted-foreground">{ROLE_LABELS[entry.role]}: </span>
                        <a
                          href={`mailto:${entry.email}`}
                          className="break-all underline-offset-4 hover:underline"
                        >
                          {entry.email}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
              <Fact label="Social media" meta={meta.socials} className="sm:grid-cols-1 sm:gap-1">
                {org.socials.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {org.socials.map((social) => (
                      <li key={social.url}>
                        <ExternalLink href={social.url}>
                          {SOCIAL_PLATFORM_LABELS[social.platform]}
                          {social.handle && (
                            <span className="ml-1 font-mono text-xs text-muted-foreground">
                              {social.handle.startsWith("@") ? social.handle : `@${social.handle}`}
                            </span>
                          )}
                        </ExternalLink>
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
              <Fact
                label="Mailing list"
                meta={meta.mailingList}
                className="sm:grid-cols-1 sm:gap-1"
              >
                {org.mailingList && (
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    {org.mailingList.signupUrl && (
                      <ExternalLink href={org.mailingList.signupUrl}>Sign up</ExternalLink>
                    )}
                    {org.mailingList.platform && (
                      <span className="text-muted-foreground">
                        {MAILING_LIST_PLATFORM_LABELS[org.mailingList.platform]}
                      </span>
                    )}
                  </span>
                )}
              </Fact>
              {(hasValue(meta.contactFormUrl) || org.contactFormUrl) && (
                <Fact
                  label="Contact form"
                  meta={meta.contactFormUrl}
                  className="sm:grid-cols-1 sm:gap-1"
                >
                  {org.contactFormUrl && <ExternalLink href={org.contactFormUrl} />}
                </Fact>
              )}
              {org.chatChannels.length > 0 && (
                <Fact
                  label="Group chats"
                  meta={meta.chatChannels}
                  className="sm:grid-cols-1 sm:gap-1"
                >
                  <ul className="flex flex-col gap-1">
                    {org.chatChannels.map((channel) => (
                      <li key={channel.platform}>
                        <span className="font-medium">
                          {CHAT_PLATFORM_LABELS[channel.platform]}
                        </span>
                        {channel.howToJoin && (
                          <span className="text-muted-foreground"> — {channel.howToJoin}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Fact>
              )}
            </dl>
          </Section>

          <Section id="registers" title="Registers">
            {registrations.length > 0 ? (
              <dl className="divide-y">
                {registrations.map((body) => {
                  const entry = org.registrations[body]
                  return (
                    <Fact
                      key={body}
                      label={REGISTRATION_BODY_LABELS[body]}
                      meta={meta[`registrations.${body}`]}
                      className="sm:grid-cols-1 sm:gap-1"
                    >
                      {entry &&
                        `${entry.registered ? "Listed" : "Not listed"}${entry.year ? ` (${entry.year})` : ""}`}
                    </Fact>
                  )
                })}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not found on the registers we read yet.
              </p>
            )}
          </Section>

          <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-5">
            <h2 className="font-semibold">Is this your society?</h2>
            <p className="text-sm text-muted-foreground">
              Claim the listing to confirm details, correct anything wrong, or ask us to remove it.
              Requests are read by a person.
            </p>
            <div className="flex flex-col gap-2">
              <Button asChild>
                <Link href={requestHref(org, "claim")}>Claim this listing</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={requestHref(org, "correct")}>
                  <PencilLineIcon data-icon="inline-start" />
                  Correct something
                </Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link href={requestHref(org, "remove")}>Ask for removal</Link>
              </Button>
            </div>
          </div>

          {missing.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Not published yet</h2>
              <p className="text-sm text-muted-foreground">
                {missing.map((field) => ORGANISATION_FIELD_LABELS[field]).join(", ")}.
              </p>
              <Link
                href={requestHref(org, "correct")}
                className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
              >
                Help complete this listing
                <ArrowRightIcon aria-hidden className="size-3.5" />
              </Link>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Listing updated <span className="font-mono">{formatInstantDate(org.updatedAt)}</span>,
            from public sources.{" "}
            <Link href="/about#data" className="underline underline-offset-4">
              How we collect data
            </Link>
          </p>
        </aside>
      </div>
    </article>
  )
}
