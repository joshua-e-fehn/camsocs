"""Controlled vocabularies — the Python mirror of webapp/lib/vocab.ts.

Every tuple here has the same name and the same values, in the same order, as
an `export const NAME = [...] as const` tuple in webapp/lib/vocab.ts, which is
the source of truth (meanings are documented there and in
docs/data-model.md). `src/tests/test_vocab_parity.py` parses the TypeScript
file and fails on any drift, so a change lands in both files in one commit.

`one_of(TUPLE)` turns a tuple into a pydantic validator for wire and staging
models (models/wire.py, models/observation.py).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated

from pydantic import AfterValidator

HARVEST_RUN_STATUSES: tuple[str, ...] = (
    "running",
    "success",
    "partial",
    "failed",
)

HARVEST_STAGE_STATUSES: tuple[str, ...] = (
    "ok",
    "failed",
    "not_run",
)

FIELD_STATUSES: tuple[str, ...] = (
    "found",
    "inferred",
    "owner_confirmed",
    "manual",
    "conflicting",
    "missing",
    "not_applicable",
)

CLAIM_STATUSES: tuple[str, ...] = (
    "found",
    "inferred",
    "missing",
    "not_applicable",
)

EVIDENCE_KINDS: tuple[str, ...] = (
    "primary",
    "secondary",
)

MISSING_REASONS: tuple[str, ...] = (
    "not_found",
    "not_published",
    "access_restricted",
    "unreachable",
    "not_attempted",
)

CLAIM_METHODS: tuple[str, ...] = (
    "parser",
    "llm",
    "manual",
    "owner_submitted",
)

QUOTE_CHECKS: tuple[str, ...] = (
    "exact",
    "normalised",
    "absent",
)

REVIEW_STATUSES: tuple[str, ...] = (
    "proposed",
    "accepted",
    "rejected",
    "superseded",
)

ENTITY_TYPES: tuple[str, ...] = (
    "organisation",
    "event",
    "team",
    "session",
    "venue",
)

SOURCE_TYPES: tuple[str, ...] = (
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
)

INTERNAL_SOURCE_TYPES: tuple[str, ...] = (
    "mailing_list_email",
    "manual",
)

ROBOTS_VERDICTS: tuple[str, ...] = (
    "allowed",
    "disallowed",
    "crawl_delay",
)

ORG_TYPES: tuple[str, ...] = (
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
)

ORG_LEVELS: tuple[str, ...] = (
    "university",
    "college",
    "department",
    "intercollegiate",
    "external",
)

COLLEGE_BODIES: tuple[str, ...] = (
    "jcr",
    "mcr",
    "college_run",
    "joint",
)

ORG_STATUSES: tuple[str, ...] = (
    "active",
    "dormant",
    "archived",
    "unknown",
)

REGISTRATION_BODIES: tuple[str, ...] = (
    "su",
    "proctors",
    "sportsService",
    "camdram",
    "cucbc",
)

CATEGORIES: tuple[str, ...] = (
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
)

ACTIVITY_TYPES: tuple[str, ...] = (
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
)

AUDIENCES: tuple[str, ...] = (
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
)

EMAIL_TYPES: tuple[str, ...] = (
    "role_own_domain",
    "cambridgesu",
    "srcf",
    "lists_cam",
    "college_domain",
    "webmail",
    "personal_crsid",
    "legacy_cusu",
)

ROLES: tuple[str, ...] = (
    "president",
    "secretary",
    "treasurer",
    "sponsorship",
    "events",
    "publicity",
    "welfare",
    "captain",
    "other",
)

SOCIAL_PLATFORMS: tuple[str, ...] = (
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
)

CHAT_PLATFORMS: tuple[str, ...] = (
    "whatsapp",
    "discord",
    "telegram",
    "slack",
    "groupme",
)

MAILING_LIST_PLATFORMS: tuple[str, ...] = (
    "sympa",
    "mailchimp",
    "google_group",
    "other",
)

MEMBERSHIP_PERIODS: tuple[str, ...] = (
    "life",
    "year",
    "term",
    "one_off",
    "free",
)

BLUE_STATUSES: tuple[str, ...] = (
    "full",
    "full_some",
    "discretionary_full",
    "half",
    "none",
)

GENDER_CATEGORIES: tuple[str, ...] = (
    "men",
    "women",
    "open",
    "mixed",
)

TERM_SCOPES: tuple[str, ...] = (
    "full_term",
    "all_year",
    "michaelmas",
    "lent",
    "easter",
)

TERMS: tuple[str, ...] = (
    "michaelmas",
    "lent",
    "easter",
)

EVENT_VISIBILITIES: tuple[str, ...] = (
    "public",
    "cam_only",
    "members_only",
)

EVENT_TYPES: tuple[str, ...] = (
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
)

EVENT_STATUSES: tuple[str, ...] = (
    "confirmed",
    "tbc",
)

EVENT_SOURCES: tuple[str, ...] = (
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
)

EVENT_ORGANISER_ROLES: tuple[str, ...] = (
    "organiser",
    "co_host",
    "sponsor",
)

RELATIONSHIP_TYPES: tuple[str, ...] = (
    "sponsors",
    "co_hosted",
    "sister_of",
    "affiliated_with",
    "parent_of",
    "member_college",
    "speaker_from",
    "partner_of",
    "venue_host",
)

PUBLICABLE_RELATIONSHIP_TYPES: tuple[str, ...] = (
    "sponsors",
    "co_hosted",
)

RELATIONSHIP_VISIBILITIES: tuple[str, ...] = (
    "public",
    "internal",
)

INBOUND_EXTRACTION_STATUSES: tuple[str, ...] = (
    "pending",
    "done",
    "failed",
    "skipped",
)

LISTING_REQUEST_KINDS: tuple[str, ...] = (
    "claim",
    "correct",
    "remove",
    "object",
    "add",
)

LISTING_REQUEST_STATUSES: tuple[str, ...] = (
    "open",
    "accepted",
    "rejected",
    "done",
)

CONSENT_BASES: tuple[str, ...] = (
    "public_source",
    "consent",
    "legitimate_interest",
)

NEED_OFFER_ITEMS: tuple[str, ...] = (
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
)

NEED_OFFER_STATUSES: tuple[str, ...] = (
    "inferred",
    "confirmed",
)

PECR_SUBSCRIBER_TYPES: tuple[str, ...] = (
    "individual",
    "corporate",
    "unknown",
)

INTERACTION_CHANNELS: tuple[str, ...] = (
    "email",
    "meeting",
    "call",
    "message",
    "event",
    "other",
)

INTRODUCTION_STATUSES: tuple[str, ...] = (
    "idea",
    "proposed",
    "sent",
    "accepted",
    "met",
    "declined",
    "stale",
)

ORGANISATION_FIELDS: tuple[str, ...] = (
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
)

EVENT_FIELDS: tuple[str, ...] = (
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
)

TEAM_FIELDS: tuple[str, ...] = (
    "orgKey",
    "name",
    "rank",
    "gender",
    "league",
    "memberCollegeKeys",
)

SESSION_FIELDS: tuple[str, ...] = (
    "orgKey",
    "title",
    "dayOfWeek",
    "startTime",
    "endTime",
    "venueKey",
    "venueText",
    "termScope",
    "note",
)

VENUE_FIELDS: tuple[str, ...] = (
    "name",
    "aliases",
    "address",
    "collegeKey",
    "lat",
    "lng",
)


def one_of(values: tuple[str, ...]) -> Callable[[str], str]:
    """A check that a string is one of `values` (for `AfterValidator`)."""
    allowed = frozenset(values)

    def check(value: str) -> str:
        if value not in allowed:
            raise ValueError(f"{value!r} is not one of {', '.join(values)}")
        return value

    return check


def Vocab(values: tuple[str, ...]):
    """`Annotated[str, …]` restricted to `values`."""
    return Annotated[str, AfterValidator(one_of(values))]


#: Every claimable field per entity type (convex/lib/fields.ts).
FIELDS_BY_ENTITY_TYPE: dict[str, tuple[str, ...]] = {
    "organisation": ORGANISATION_FIELDS,
    "event": EVENT_FIELDS,
    "team": TEAM_FIELDS,
    "session": SESSION_FIELDS,
    "venue": VENUE_FIELDS,
}
