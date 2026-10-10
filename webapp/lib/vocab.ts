/**
 * Controlled vocabularies, as `as const` tuples.
 *
 * The single source of truth for every closed set of values that crosses a
 * boundary — Convex validators (`literalUnion` in convex/lib/validators.ts),
 * UI labels, and the Python pipeline, which mirrors these tuples in
 * `pipeline/src/camsocs_pipeline/models/vocab.py`. A pytest parses this file
 * and fails if the two drift (`test_vocab_parity.py`), so:
 *
 *  - every tuple is written `export const NAME = [ "a", "b" ] as const` with
 *    string literals only (no spreads, no computed values) — the parity test
 *    reads them with a regex;
 *  - a new tuple here needs the same name in vocab.py.
 *
 * No server imports here, so the client bundle and `bun test` can both use it.
 * Pattern from salo-ba lib/research/vocab.ts and Bundestracker. Meanings are
 * specified in docs/data-model.md; the section is cited on each tuple.
 */

// --- pipeline runs ------------------------------------------------------------

/**
 * The state of one pipeline run (`harvestRuns.status`).
 *
 *  - `running`  — `runs.start` was called and `runs.finish` was not (yet). A run
 *                 that stays here crashed or was killed; it is evidence, not noise.
 *  - `success`  — every requested stage finished without error.
 *  - `partial`  — at least one stage failed and at least one succeeded.
 *  - `failed`   — every stage failed, or the run reported a run-level error.
 */
export const HARVEST_RUN_STATUSES = ["running", "success", "partial", "failed"] as const
export type HarvestRunStatus = (typeof HARVEST_RUN_STATUSES)[number]

/**
 * The outcome of one stage within a run.
 *
 *  - `ok`      — the stage ran to completion (possibly with nothing to do).
 *  - `failed`  — the stage raised; its partial counts are still reported.
 *  - `not_run` — the stage was requested but skipped because a stage it
 *                depends on failed.
 */
export const HARVEST_STAGE_STATUSES = ["ok", "failed", "not_run"] as const
export type HarvestStageStatus = (typeof HARVEST_STAGE_STATUSES)[number]

// --- provenance (data-model §1, §3) -------------------------------------------

/** `FieldMeta.status` — the state of one resolved field (data-model §1). */
export const FIELD_STATUSES = [
  "found",
  "inferred",
  "owner_confirmed",
  "manual",
  "conflicting",
  "missing",
  "not_applicable",
] as const
export type FieldStatus = (typeof FIELD_STATUSES)[number]

/**
 * The status a pipeline claim may carry. `owner_confirmed` / `manual` /
 * `conflicting` are never posted: the first two follow from the method, the
 * last is a resolution outcome.
 */
export const CLAIM_STATUSES = ["found", "inferred", "missing", "not_applicable"] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** primary = the organisation's own channel, or the official register for
 * registration facts; secondary = anyone else. */
export const EVIDENCE_KINDS = ["primary", "secondary"] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** Why a field has no value (`FieldMeta.missingReason`). `not_attempted` is the
 * server's default for a field no source has spoken about yet. */
export const MISSING_REASONS = [
  "not_found",
  "not_published",
  "access_restricted",
  "unreachable",
  "not_attempted",
] as const
export type MissingReason = (typeof MISSING_REASONS)[number]

/** How a claim was produced. */
export const CLAIM_METHODS = ["parser", "llm", "manual", "owner_submitted"] as const
export type ClaimMethod = (typeof CLAIM_METHODS)[number]

/** `extract/evidence.py` verdict on an LLM claim's verbatim quote. */
export const QUOTE_CHECKS = ["exact", "normalised", "absent"] as const
export type QuoteCheck = (typeof QUOTE_CHECKS)[number]

/** `fieldClaims.reviewStatus`. Pipeline claims enter `accepted`; a newer claim
 * from the same source and method marks the older one `superseded`. */
export const REVIEW_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** Entity types a field claim can target. */
export const ENTITY_TYPES = ["organisation", "event", "team", "session", "venue"] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/** `sources.sourceType` — also `Observation.source_type` in the pipeline. */
export const SOURCE_TYPES = [
  "su_directory",
  "su_profile",
  "proctors_register",
  "sport_az",
  "sport_club_page",
  "sport_guide_pdf",
  "camdram",
  "talks_list",
  "society_website",
  "linktree",
  "college_list",
  "cucbc",
  "playwaze",
  "uni_events_api",
  "ics_feed",
  "luma",
  "su_whatson",
  "mailing_list_email",
  "instagram_api",
  "termcard",
  "wayback",
  "manual",
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Source types whose URLs never appear in a public projection (data-model §7). */
export const INTERNAL_SOURCE_TYPES = ["mailing_list_email", "manual"] as const

export const ROBOTS_VERDICTS = ["allowed", "disallowed", "crawl_delay"] as const
export type RobotsVerdict = (typeof ROBOTS_VERDICTS)[number]

// --- organisations (data-model §2) ---------------------------------------------

export const ORG_TYPES = [
  "society",
  "sports_club",
  "college_club",
  "jcr",
  "mcr",
  "college_boat_club",
  "college",
  "department",
  "uni_office",
  "student_union",
  "company",
  "ngo",
  "public_body",
  "other_university_society",
  "media",
  "theatre_company",
  "other",
] as const
export type OrgType = (typeof ORG_TYPES)[number]

export const ORG_LEVELS = [
  "university",
  "college",
  "department",
  "intercollegiate",
  "external",
] as const
export type OrgLevel = (typeof ORG_LEVELS)[number]

export const COLLEGE_BODIES = ["jcr", "mcr", "college_run", "joint"] as const
export type CollegeBody = (typeof COLLEGE_BODIES)[number]

/** Derived (data-model §6), never claimed. */
export const ORG_STATUSES = ["active", "dormant", "archived", "unknown"] as const
export type OrgStatus = (typeof ORG_STATUSES)[number]

/** The registers an organisation can be on; each lapses independently. */
export const REGISTRATION_BODIES = ["su", "proctors", "sportsService", "camdram", "cucbc"] as const
export type RegistrationBody = (typeof REGISTRATION_BODIES)[number]

/** Our taxonomy (data-model §5). Labels in `CATEGORY_LABELS`. */
export const CATEGORIES = [
  "academic",
  "science_tech",
  "careers_professional",
  "entrepreneurship",
  "arts_creative",
  "music",
  "theatre_film_dance",
  "media_publishing",
  "cultural_international",
  "faith",
  "politics_debate",
  "causes_volunteering",
  "identity_wellbeing",
  "sport",
  "outdoors",
  "hobbies_games",
] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  academic: "Academic & Subject",
  science_tech: "Science, Tech & Engineering",
  careers_professional: "Careers & Professional",
  entrepreneurship: "Entrepreneurship & Innovation",
  arts_creative: "Arts, Design & Creative Writing",
  music: "Music",
  theatre_film_dance: "Theatre, Film & Dance",
  media_publishing: "Media & Publishing",
  cultural_international: "Cultural & International",
  faith: "Faith & Belief",
  politics_debate: "Politics, Debate & Law",
  causes_volunteering: "Campaigns, Charity & Volunteering",
  identity_wellbeing: "Identity, Community & Wellbeing",
  sport: "Sport & Fitness",
  outdoors: "Outdoors & Adventure",
  hobbies_games: "Hobbies, Games & Food",
}

export const ACTIVITY_TYPES = [
  "talks",
  "socials",
  "competitions",
  "performances",
  "workshops",
  "trips",
  "training",
  "publications",
  "volunteering",
  "careers_events",
  "formals",
  "worship",
  "meetings",
] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

export const AUDIENCES = [
  "undergraduates",
  "postgraduates",
  "staff",
  "alumni",
  "public",
  "own_college_only",
  "women",
  "men",
  "mixed",
  "lgbtq",
  "international",
  "beginners",
] as const
export type Audience = (typeof AUDIENCES)[number]

/** Derived on the server from the resolved address (`convex/lib/derived.ts`). */
export const EMAIL_TYPES = [
  "role_own_domain",
  "cambridgesu",
  "srcf",
  "lists_cam",
  "college_domain",
  "webmail",
  "personal_crsid",
  "legacy_cusu",
] as const
export type EmailType = (typeof EMAIL_TYPES)[number]

export const ROLES = [
  "president",
  "secretary",
  "treasurer",
  "sponsorship",
  "events",
  "publicity",
  "welfare",
  "captain",
  "other",
] as const
export type Role = (typeof ROLES)[number]

export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook_page",
  "facebook_group",
  "x",
  "linkedin",
  "tiktok",
  "youtube",
  "linktree",
  "website_blog",
  "wechat",
  "threads",
  "bluesky",
] as const
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number]

/** Chat channels are stored as "has a channel" + how to join — never an invite URL. */
export const CHAT_PLATFORMS = ["whatsapp", "discord", "telegram", "slack", "groupme"] as const
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number]

export const MAILING_LIST_PLATFORMS = ["sympa", "mailchimp", "google_group", "other"] as const
export type MailingListPlatform = (typeof MAILING_LIST_PLATFORMS)[number]

export const MEMBERSHIP_PERIODS = ["life", "year", "term", "one_off", "free"] as const
export type MembershipPeriod = (typeof MEMBERSHIP_PERIODS)[number]

export const BLUE_STATUSES = ["full", "full_some", "discretionary_full", "half", "none"] as const
export type BlueStatus = (typeof BLUE_STATUSES)[number]

export const GENDER_CATEGORIES = ["men", "women", "open", "mixed"] as const
export type GenderCategory = (typeof GENDER_CATEGORIES)[number]

export const TERM_SCOPES = ["full_term", "all_year", "michaelmas", "lent", "easter"] as const
export type TermScope = (typeof TERM_SCOPES)[number]

export const TERMS = ["michaelmas", "lent", "easter"] as const
export type Term = (typeof TERMS)[number]

// --- events (data-model §2) ----------------------------------------------------

/** `members_only` is never shown; `cam_only` needs a verified @cam.ac.uk session. */
export const EVENT_VISIBILITIES = ["public", "cam_only", "members_only"] as const
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number]

export const EVENT_TYPES = [
  "talk",
  "social",
  "performance",
  "competition",
  "match",
  "workshop",
  "trip",
  "formal",
  "careers",
  "meeting",
  "training",
  "worship",
  "fair",
  "other",
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_STATUSES = ["confirmed", "tbc"] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const EVENT_SOURCES = [
  "camdram",
  "talks_cam",
  "ics",
  "luma",
  "google_calendar",
  "playwaze",
  "uni_events_api",
  "cucbc",
  "su_whatson",
  "mailing_list",
  "instagram_api",
  "termcard",
  "website",
  "manual",
] as const
export type EventSource = (typeof EVENT_SOURCES)[number]

export const EVENT_ORGANISER_ROLES = ["organiser", "co_host", "sponsor"] as const
export type EventOrganiserRole = (typeof EVENT_ORGANISER_ROLES)[number]

/** Whether an event's organisations host it or only take part in someone else's
 * (decision D6): least to most restrictive, so the `strictest` merge lets any
 * current reading that shows the event to be external win. */
export const EVENT_HOSTING = ["hosts", "takes_part"] as const
export type EventHosting = (typeof EVENT_HOSTING)[number]

// --- relationships ---------------------------------------------------------------

export const RELATIONSHIP_TYPES = [
  "sponsors",
  "co_hosted",
  "sister_of",
  "affiliated_with",
  "parent_of",
  "member_college",
  "speaker_from",
  "partner_of",
  "venue_host",
] as const
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number]

/** The only relationship types that may ever be public, and only when the
 * organisation itself published them (primary evidence). */
export const PUBLICABLE_RELATIONSHIP_TYPES = ["sponsors", "co_hosted"] as const

export const RELATIONSHIP_VISIBILITIES = ["public", "internal"] as const
export type RelationshipVisibility = (typeof RELATIONSHIP_VISIBILITIES)[number]

// --- inbox, listing requests ---------------------------------------------------------

export const INBOUND_EXTRACTION_STATUSES = ["pending", "done", "failed", "skipped"] as const
export type InboundExtractionStatus = (typeof INBOUND_EXTRACTION_STATUSES)[number]

export const LISTING_REQUEST_KINDS = ["claim", "correct", "remove", "object", "add"] as const
export type ListingRequestKind = (typeof LISTING_REQUEST_KINDS)[number]

export const LISTING_REQUEST_STATUSES = ["open", "accepted", "rejected", "done"] as const
export type ListingRequestStatus = (typeof LISTING_REQUEST_STATUSES)[number]

/** What a suppression covers — an accepted removal or objection (retention.md
 * R8): a whole listing, one field of it, one contact address (stored only as a
 * sha256), or one named person in the broker tables. */
export const SUPPRESSION_SCOPES = [
  "organisation",
  "field",
  "contact",
  "person",
  "event",
  "name",
] as const
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number]

// --- broker (data-model §4) --------------------------------------------------------

export const CONSENT_BASES = ["public_source", "consent", "legitimate_interest"] as const
export type ConsentBasis = (typeof CONSENT_BASES)[number]

export const NEED_OFFER_ITEMS = [
  "sponsorship",
  "speakers",
  "co_hosting",
  "venue",
  "members",
  "volunteers",
  "media_coverage",
  "funding",
  "mentoring",
  "expertise",
  "equipment",
  "careers_access",
] as const
export type NeedOfferItem = (typeof NEED_OFFER_ITEMS)[number]

/**
 * A need or offer's standing (data-model §4). The pipeline writes `inferred`;
 * the broker confirms (`confirmed`) or rejects (`rejected`). Both broker
 * verdicts are final: the pipeline never touches them, and a rejected item is
 * not re-inferred — the rejection is a tombstone, hidden from the UI.
 */
export const NEED_OFFER_STATUSES = ["inferred", "confirmed", "rejected"] as const
export type NeedOfferStatus = (typeof NEED_OFFER_STATUSES)[number]

export const PECR_SUBSCRIBER_TYPES = ["individual", "corporate", "unknown"] as const
export type PecrSubscriberType = (typeof PECR_SUBSCRIBER_TYPES)[number]

export const INTERACTION_CHANNELS = [
  "email",
  "meeting",
  "call",
  "message",
  "event",
  "other",
] as const
export type InteractionChannel = (typeof INTERACTION_CHANNELS)[number]

export const INTRODUCTION_STATUSES = [
  "idea",
  "proposed",
  "sent",
  "accepted",
  "met",
  "declined",
  "stale",
] as const
export type IntroductionStatus = (typeof INTRODUCTION_STATUSES)[number]

// --- claimable fields per entity type (data-model §2) ----------------------------------

/**
 * The fields a claim may target, per entity type. `convex/lib/fields.ts` holds
 * the validator and resolution rule for each and asserts it covers exactly
 * these. Dotted names are sub-fields assembled into one object
 * (`sport.blueStatus` → `organisations.sport.blueStatus`,
 * `registrations.su` → `organisations.registrations.su`).
 *
 * Not claimable, because the server derives them: `slug`, `status`,
 * `emailType`, `searchText`, `missingFields`, `termWeekLabel`, `confidence`,
 * `lastSeenAt`, and the event organiser arrays (set by `eventOrganisers`).
 */
export const ORGANISATION_FIELDS = [
  "name",
  "aliases",
  "shortName",
  "orgType",
  "level",
  "collegeKeys",
  "collegeBody",
  "parentKey",
  "isCounterpart",
  "defunct",
  "lastActiveAt",
  "registrations.su",
  "registrations.proctors",
  "registrations.sportsService",
  "registrations.camdram",
  "registrations.cucbc",
  "categories",
  "activityTypes",
  "audiences",
  "languages",
  "tags",
  "suCategory",
  "department",
  "logo",
  "shortDescription",
  "description",
  "howToJoin",
  "joinUrl",
  "membership",
  "beginnerFriendly",
  "trials",
  "timeCommitment",
  "termcardUrl",
  "accessibilityNote",
  "sport.sport",
  "sport.blueStatus",
  "sport.varsity",
  "sport.bucs",
  "sport.collegeCompetition",
  "sport.genderCategories",
  "sport.kitCostNote",
  "sport.venues",
  "website",
  "email",
  "roleEmails",
  "contactFormUrl",
  "mailingList",
  "socials",
  "chatChannels",
] as const
export type OrganisationField = (typeof ORGANISATION_FIELDS)[number]

export const EVENT_FIELDS = [
  "title",
  "description",
  "startsAt",
  "endsAt",
  "allDay",
  "venueKey",
  "venueText",
  "speakers",
  "price",
  "bookingUrl",
  "signupRequired",
  "visibility",
  "eventType",
  "image",
  "cancelled",
  "status",
  "source",
  "externalId",
  "sourceUrl",
  "hosting",
  "externalUrl",
] as const
export type EventField = (typeof EVENT_FIELDS)[number]

export const TEAM_FIELDS = [
  "orgKey",
  "name",
  "rank",
  "gender",
  "league",
  "memberCollegeKeys",
] as const
export type TeamField = (typeof TEAM_FIELDS)[number]

export const SESSION_FIELDS = [
  "orgKey",
  "title",
  "dayOfWeek",
  "startTime",
  "endTime",
  "venueKey",
  "venueText",
  "termScope",
  "note",
] as const
export type SessionField = (typeof SESSION_FIELDS)[number]

export const VENUE_FIELDS = ["name", "aliases", "address", "collegeKey", "lat", "lng"] as const
export type VenueField = (typeof VENUE_FIELDS)[number]

// --- display labels (public site) ------------------------------------------------------
//
// Records, not tuples: the parity test reads only `export const NAME = [...] as
// const`, and `Record<Union, string>` makes the compiler insist every value has
// a label.

export const ORG_LEVEL_LABELS: Record<OrgLevel, string> = {
  university: "University",
  college: "College",
  department: "Department",
  intercollegiate: "Intercollegiate",
  external: "External",
}

export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  society: "Society",
  sports_club: "Sports club",
  college_club: "College club",
  jcr: "JCR",
  mcr: "MCR",
  college_boat_club: "College boat club",
  college: "College",
  department: "Department",
  uni_office: "University office",
  student_union: "Students' union",
  company: "Company",
  ngo: "Charity or NGO",
  public_body: "Public body",
  other_university_society: "Society at another university",
  media: "Student media",
  theatre_company: "Theatre company",
  other: "Other",
}

export const ORG_STATUS_LABELS: Record<OrgStatus, string> = {
  active: "Active",
  dormant: "Dormant",
  archived: "Archived",
  unknown: "Activity unknown",
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  talks: "Talks",
  socials: "Socials",
  competitions: "Competitions",
  performances: "Performances",
  workshops: "Workshops",
  trips: "Trips",
  training: "Training",
  publications: "Publications",
  volunteering: "Volunteering",
  careers_events: "Careers events",
  formals: "Formals",
  worship: "Worship",
  meetings: "Meetings",
}

export const AUDIENCE_LABELS: Record<Audience, string> = {
  undergraduates: "Undergraduates",
  postgraduates: "Postgraduates",
  staff: "Staff",
  alumni: "Alumni",
  public: "Open to the public",
  own_college_only: "Own college only",
  women: "Women",
  men: "Men",
  mixed: "Mixed",
  lgbtq: "LGBTQ+",
  international: "International students",
  beginners: "Beginners",
}

export const BLUE_STATUS_LABELS: Record<BlueStatus, string> = {
  full: "Full Blue",
  full_some: "Full Blue (some players)",
  discretionary_full: "Discretionary Full Blue",
  half: "Half Blue",
  none: "No Blue",
}

export const GENDER_CATEGORY_LABELS: Record<GenderCategory, string> = {
  men: "Men",
  women: "Women",
  open: "Open",
  mixed: "Mixed",
}

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  talk: "Talk",
  social: "Social",
  performance: "Performance",
  competition: "Competition",
  match: "Match",
  workshop: "Workshop",
  trip: "Trip",
  formal: "Formal",
  careers: "Careers",
  meeting: "Meeting",
  training: "Training",
  worship: "Worship",
  fair: "Fair",
  other: "Other",
}

export const EVENT_SOURCE_LABELS: Record<EventSource, string> = {
  camdram: "Camdram",
  talks_cam: "talks.cam",
  ics: "Calendar feed",
  luma: "Luma",
  google_calendar: "Google Calendar",
  playwaze: "Playwaze",
  uni_events_api: "University events listing",
  cucbc: "CUCBC",
  su_whatson: "SU What's On",
  mailing_list: "Society mailing list",
  instagram_api: "Instagram (official API)",
  termcard: "Termcard",
  website: "Society website",
  manual: "Added by hand",
}

export const ROLE_LABELS: Record<Role, string> = {
  president: "President",
  secretary: "Secretary",
  treasurer: "Treasurer",
  sponsorship: "Sponsorship",
  events: "Events",
  publicity: "Publicity",
  welfare: "Welfare",
  captain: "Captain",
  other: "Other",
}

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook_page: "Facebook",
  facebook_group: "Facebook group",
  x: "X",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  linktree: "Linktree",
  website_blog: "Blog",
  wechat: "WeChat",
  threads: "Threads",
  bluesky: "Bluesky",
}

export const CHAT_PLATFORM_LABELS: Record<ChatPlatform, string> = {
  whatsapp: "WhatsApp",
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  groupme: "GroupMe",
}

export const MAILING_LIST_PLATFORM_LABELS: Record<MailingListPlatform, string> = {
  sympa: "University mailing list (Sympa)",
  mailchimp: "Mailchimp",
  google_group: "Google Group",
  other: "Mailing list",
}

export const MEMBERSHIP_PERIOD_LABELS: Record<MembershipPeriod, string> = {
  life: "for life",
  year: "per year",
  term: "per term",
  one_off: "one-off",
  free: "free",
}

export const TERM_SCOPE_LABELS: Record<TermScope, string> = {
  full_term: "Full Term",
  all_year: "All year",
  michaelmas: "Michaelmas",
  lent: "Lent",
  easter: "Easter",
}

export const REGISTRATION_BODY_LABELS: Record<RegistrationBody, string> = {
  su: "Cambridge SU directory",
  proctors: "Proctors' register",
  sportsService: "Sport Cambridge clubs",
  camdram: "Camdram",
  cucbc: "CUCBC",
}

export const LISTING_REQUEST_KIND_LABELS: Record<ListingRequestKind, string> = {
  claim: "Claim this listing",
  correct: "Correct something",
  remove: "Remove this listing",
  object: "Object to processing",
  add: "Add a missing society",
}

export const SUPPRESSION_SCOPE_LABELS: Record<SuppressionScope, string> = {
  organisation: "Whole listing",
  field: "One field",
  contact: "A contact address",
  person: "A named person (broker contacts)",
  event: "One or more events",
  name: "A person's name, in any public text",
}

/** What a visitor sees for each organisation field (missing-field lists and
 * the correction form). */
export const ORGANISATION_FIELD_LABELS: Record<OrganisationField, string> = {
  name: "Name",
  aliases: "Other names",
  shortName: "Short name",
  orgType: "Type",
  level: "Level",
  collegeKeys: "College",
  collegeBody: "College body",
  parentKey: "Parent organisation",
  isCounterpart: "Partner organisation",
  defunct: "Defunct",
  lastActiveAt: "Last activity",
  "registrations.su": "SU registration",
  "registrations.proctors": "Proctors' registration",
  "registrations.sportsService": "Sport Cambridge registration",
  "registrations.camdram": "Camdram listing",
  "registrations.cucbc": "CUCBC membership",
  categories: "Categories",
  activityTypes: "Activities",
  audiences: "Who it is for",
  languages: "Languages",
  tags: "Tags",
  suCategory: "SU category",
  department: "Department",
  logo: "Logo",
  shortDescription: "Short description",
  description: "Description",
  howToJoin: "How to join",
  joinUrl: "Join link",
  membership: "Membership and prices",
  beginnerFriendly: "Beginner-friendly",
  trials: "Trials or auditions",
  timeCommitment: "Time commitment",
  termcardUrl: "Termcard",
  accessibilityNote: "Accessibility",
  "sport.sport": "Sport",
  "sport.blueStatus": "Blue status",
  "sport.varsity": "Varsity",
  "sport.bucs": "BUCS",
  "sport.collegeCompetition": "College competition",
  "sport.genderCategories": "Gender categories",
  "sport.kitCostNote": "Kit costs",
  "sport.venues": "Training venues",
  website: "Website",
  email: "General email",
  roleEmails: "Role email addresses",
  contactFormUrl: "Contact form",
  mailingList: "Mailing list",
  socials: "Social media",
  chatChannels: "Group chats",
}
