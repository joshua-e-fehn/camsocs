"""Camdram societies (source-research §5): ``societies.json``, one request.

Each society becomes a ``camdram`` observation: identity by ``camdram_id`` /
``camdram_slug``, name and short name, ``registrations.camdram``, its image as
the logo's source (our own copy is made later; a logo is never hotlinked),
and its Facebook page (``facebook_id`` is a page id or a page URL → a
``facebook.com`` link; anything else, such as a link shortener, is dropped).
``college`` places a society in its college (``level`` college +
``member_college``) — the only college signal used: "Girton Musical Theatre"
is a village group, not Girton College's.

**Not everything on Camdram is a theatre company** (`camdram_type`, re-checked
2026-10-09 against every entry's name and description):

- a student radio station (Cam FM: "Cambridge's student radio station") is
  ``media`` (category media_publishing);
- film societies ("Film Association", "Filmmaking Society", "a new Cambridge
  film-makers' society", "a student-led film production company") are
  ``society`` with categories theatre_film_dance + media_publishing; a
  "Theatre & Film Company" stays a theatre company with both categories;
- a music society is a ``society`` (music); opera, musical theatre and
  Gilbert & Sullivan companies stay theatre companies with music added; a
  ballet club is a dance ``society``; Amnesty International's group is a
  campaigning ``society`` (causes_volunteering);
- entries that are not student groups are counterparts, never listed:
  Camdram's own meta-page and ADC Online (the ADC Theatre's online
  programme) as ``other``; community companies (Pied Pipers "an amateur
  community Musical Theatre Company", Girton Musical Theatre "based in the
  village of Girton … anyone over the age of 16", The Festival Players "for
  all ages", WRiTEON "not specifically a student organisation") at level
  ``external`` — city clubs are out of scope (PLAN §2.2); another
  university's society ("Anglia Ruskin") is ``other_university_society``.

**Descriptions carry committees** (§5's trap): role addresses
(``president@cuadc.org``) become ``roleEmails`` — never people — and a general
address (``info@…``, the society's own name) becomes ``email``; personal
CRSids and addresses that may be a person's are dropped. The public
``description`` keeps only the leading prose: it stops at the first paragraph
that lists a committee, names a role or carries an address or a Camdram
person link, so no officer's name or CRSid reaches a public field.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.colleges import canonical_college, college_relationships
from camsocs_pipeline.sources.links import (
    CRSID_PATTERN,
    Contacts,
    classify_email,
    find_emails,
    name_tokens,
    normalise_email,
)
from camsocs_pipeline.sources.observe import Harvest, fetch_info, retrieved_at

SOCIETIES_URL = "https://www.camdram.net/societies.json"
SOCIETY_PAGE = "https://www.camdram.net/societies/{slug}"
#: How the society page renders a society's image (checked 2026-10-07).
IMAGE_URL = "https://www.camdram.net/media/cache/thumbnail/{filename}"
OTHER_UNIVERSITIES = frozenset({"anglia ruskin", "anglia ruskin university", "aru"})

#: A line that starts a committee list or a contact block…
_STOP_LINE = re.compile(
    r"^\W*(\*\*)?\s*(\d{4}\s*[-–/]\s*\d{2,4}\s*)?(current\s+)?"
    r"(presidents?|co-?presidents?|vice[- ]?presidents?|secretary|secretaries|"
    r"treasurers?|publicists?|chairs?|producers?|directors?|technical\s+director|officers?|"
    r"contacts?|e-?mail|enquiries)\b",
    re.IGNORECASE,
)
#: …or mentions one anywhere in the line (committee lists, founders, contacts,
#: CRSids — "Hugh Stubbins (hs503)").
_STOP_ANYWHERE = re.compile(
    r"(committee|comittee|founders?\b|enquiries\s+to|please\s+contact|contact\s+us\s+at|"
    rf"crsid|\(\s*{CRSID_PATTERN}\s*\)|\b{CRSID_PATTERN}@)",
    re.IGNORECASE,
)
#: …or reads "Post: First Last" ("Artistic Director: Charlie McGuire").
_POST_AND_NAME = re.compile(
    r"^\W*[A-Z][\w'’&/ -]{1,40}\s*[:–-]\s*[A-Z][\w'’-]+(\s+[A-Z][\w'’-]+){1,3}\W*$"
)
_PERSON_LINK = re.compile(r"camdram\.net/people/", re.IGNORECASE)
_SHORT_NAME_MAX = 40
_DESCRIPTION_MIN = 20


def public_description(text: str | None) -> str | None:
    """The leading prose of a Camdram description, up to the first line that
    starts a committee list or a contact block, or carries an address or a
    Camdram person link. None when nothing is left."""
    if not text:
        return None
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept: list[str] = []
    for line in lines:
        if (
            _STOP_LINE.search(line)
            or _STOP_ANYWHERE.search(line)
            or _POST_AND_NAME.match(line)
            or _PERSON_LINK.search(line)
            or find_emails(line)
        ):
            break
        kept.append(line.rstrip())
    joined = re.sub(r"\n\s*\n(\s*\n)+", "\n\n", "\n".join(kept)).strip()
    # A bare link is not a description.
    if not joined or re.fullmatch(r"\S+", joined) or len(joined) < _DESCRIPTION_MIN:
        return None
    return joined


_MAILTO_LINK = re.compile(r"\[(?P<label>[^\]]{1,80})\]\(mailto:(?P<address>[^)\s]+)\)", re.I)


def description_contacts(text: str, own_tokens: set[str]) -> Contacts:
    """Addresses in a description. A markdown link's label names the post
    ("[Club Publicist](mailto:publicist@…)", "[Actors' Rep](mailto:actor@…)")."""
    contacts = Contacts()
    labelled: set[str] = set()
    for match in _MAILTO_LINK.finditer(text):
        address = normalise_email(match.group("address"))
        labelled.add(address.lower())
        contacts.add(classify_email(address, own_tokens, label=match.group("label")))
    for address in find_emails(text):
        if normalise_email(address).lower() not in labelled:
            contacts.add(classify_email(address, own_tokens))
    return contacts


def facebook_url(value: object) -> str | None:
    """A Facebook page link from Camdram's ``facebook_id`` (an id or a URL)."""
    if value is None:
        return None
    text = str(value).strip()
    if re.fullmatch(r"\d{5,20}", text):
        return f"https://www.facebook.com/{text}"
    if re.match(r"^https?://(www\.|m\.)?facebook\.com/[^\s]+$", text, re.IGNORECASE):
        return text
    return None


@dataclass(frozen=True)
class CamdramType:
    """What kind of organisation a Camdram entry is (module docstring)."""

    org_type: str = "theatre_company"
    categories: tuple[str, ...] = ("theatre_film_dance",)
    #: Not a student group we list (`isCounterpart`).
    counterpart: bool = False
    #: The level when it does not follow from the college (an outside group).
    level: str | None = None
    #: Why, for the claims' ``valueRaw`` when the type is not the default.
    reason: str | None = None


#: Entries that are not student groups, by slug (checked 2026-10-09).
_NOT_STUDENT_GROUPS: dict[str, CamdramType] = {
    "camdram": CamdramType(
        "other", (), True, None, "Camdram's own meta-page: \"We don't fund any shows\""
    ),
    "adc-online": CamdramType(
        "other", ("theatre_film_dance",), True, None, "the ADC Theatre's online programme"
    ),
    "pied-pipers": CamdramType(
        "theatre_company", ("theatre_film_dance", "music"), True, "external",
        "\"an amateur community Musical Theatre Company\"",
    ),
    "girton-musical-theatre": CamdramType(
        "theatre_company", ("theatre_film_dance", "music"), True, "external",
        "\"based in the village of Girton\", open to anyone over 16",
    ),
    "the-festival-players": CamdramType(
        "theatre_company", ("theatre_film_dance", "music"), True, "external",
        "\"a friendly, Cambridge-based musical theatre society for all ages\"",
    ),
    "writeon": CamdramType(
        "theatre_company", ("theatre_film_dance",), True, "external",
        "\"we are not specifically a student organisation\"",
    ),
    "cambridge-university-amnesty-international": CamdramType(
        "society", ("causes_volunteering",), False, None,
        "Amnesty International's student group, which staged a production",
    ),
}  # fmt: skip

_RADIO = re.compile(r"\bradio\b|\b\d{2,3}(\.\d)?\s?fm\b|^cam fm$", re.IGNORECASE)
_FILM = re.compile(
    r"\bfilm\s?(making|makers?|production|association|society)\b|\bfilm-?makers?\b"
    r"|\bfilmmaking\b",
    re.IGNORECASE,
)
_THEATRE_WORDS = re.compile(r"\b(theatre|theater|drama|dramatic|players)\b", re.IGNORECASE)
_MUSICAL = re.compile(r"\b(opera|operatic|musical|gilbert|g\s?&\s?s)\b", re.IGNORECASE)
_MUSIC_SOCIETY = re.compile(r"\bmusic society\b", re.IGNORECASE)
_DANCE = re.compile(r"\b(ballet|dance|dancing)\b", re.IGNORECASE)


def camdram_type(slug: str, name: str, description: str | None) -> CamdramType:
    """The kind of organisation one Camdram entry is (module docstring)."""
    if slug in _NOT_STUDENT_GROUPS:
        return _NOT_STUDENT_GROUPS[slug]
    lead = " ".join((description or "").split())[:300]
    if _RADIO.search(name) or re.search(r"\bstudent radio\b", lead, re.IGNORECASE):
        return CamdramType("media", ("media_publishing",), reason="a student radio station")
    if _FILM.search(name) or _FILM.search(lead) or re.search(r"\bfilm\b", name, re.IGNORECASE):
        if _THEATRE_WORDS.search(name):
            return CamdramType(
                "theatre_company", ("theatre_film_dance", "media_publishing"),
                reason="a theatre and film company",
            )  # fmt: skip
        return CamdramType(
            "society", ("theatre_film_dance", "media_publishing"), reason="a film society"
        )
    if _MUSIC_SOCIETY.search(name):
        return CamdramType("society", ("music",), reason="a music society")
    if _DANCE.search(name) and not _THEATRE_WORDS.search(name):
        return CamdramType("society", ("theatre_film_dance",), reason="a dance society")
    if _MUSICAL.search(name):
        return CamdramType(categories=("theatre_film_dance", "music"))
    return CamdramType()


def society_observation(
    society: dict, result: FetchResult, client: PoliteClient
) -> Observation | None:
    name = str(society.get("name") or "").strip()
    slug = str(society.get("slug") or "").strip()
    if not name or not slug:
        return None
    short = str(society.get("short_name") or "").strip()
    college_text = str(society.get("college") or "").strip()
    college = canonical_college(college_text)
    raw_description = society.get("description")
    other_university = not college and college_text.lower() in OTHER_UNIVERSITIES
    kind = (
        CamdramType("other_university_society", ("theatre_film_dance",), True, "external")
        if other_university
        else camdram_type(slug, name, raw_description if isinstance(raw_description, str) else None)
    )
    extractor = "camdram.societies"
    evidence = "secondary"
    fields = [
        parser_field("name", name, extractor=f"{extractor}.name", evidence=evidence),
        parser_field(
            "orgType", kind.org_type, extractor=f"{extractor}.type", evidence=evidence,
            value_raw=kind.reason,
        ),
        parser_field("isCounterpart", kind.counterpart, extractor=extractor, evidence=evidence),
        parser_field(
            "registrations.camdram",
            {"registered": True, "sourceUrl": SOCIETY_PAGE.format(slug=slug)},
            extractor=f"{extractor}.listed",
            evidence="primary",
        ),
    ]  # fmt: skip
    if kind.categories:
        # Camdram lists theatre (and film / performance) groups: categories by rule.
        fields.append(
            parser_field(
                "categories", list(kind.categories), extractor=f"{extractor}.category_rule",
                evidence=evidence, inferred=True,
            )
        )  # fmt: skip
    if college:
        fields.append(
            parser_field("level", "college", extractor=f"{extractor}.college", evidence=evidence)
        )
    elif kind.level is not None:
        fields.append(
            parser_field("level", kind.level, extractor=f"{extractor}.type", evidence=evidence)
        )
    elif kind.org_type == "other":
        pass  # a platform, not a group: no level
    else:
        # No college on Camdram: most such societies are University-wide, but
        # Camdram does not say so.
        fields.append(
            parser_field(
                "level", "university", extractor=f"{extractor}.no_college", evidence=evidence,
                inferred=True,
            )
        )  # fmt: skip
    if short and short != name and len(short) <= _SHORT_NAME_MAX:
        fields.append(
            parser_field("shortName", short, extractor=f"{extractor}.name", evidence=evidence)
        )
        fields.append(
            parser_field("aliases", [short], extractor=f"{extractor}.name", evidence=evidence)
        )
    description = public_description(raw_description if isinstance(raw_description, str) else None)
    if description:
        fields.append(
            parser_field(
                "description", description, extractor=f"{extractor}.description", evidence=evidence
            )
        )
    contacts = description_contacts(
        raw_description if isinstance(raw_description, str) else "",
        name_tokens(name, short, slug.replace("-", " ")),
    )
    if contacts.email:
        fields.append(
            parser_field("email", contacts.email, extractor=f"{extractor}.email", evidence=evidence)
        )
    if contacts.role_emails:
        fields.append(
            parser_field(
                "roleEmails", contacts.role_emails, extractor=f"{extractor}.role_emails",
                evidence=evidence,
            )
        )  # fmt: skip
    facebook = facebook_url(society.get("facebook_id"))
    if facebook:
        fields.append(
            parser_field(
                "socials", [{"platform": "facebook_page", "url": facebook}],
                extractor=f"{extractor}.facebook_id", evidence=evidence,
            )
        )  # fmt: skip
    image = society.get("image")
    if isinstance(image, dict) and image.get("filename"):
        fields.append(
            parser_field(
                "logo", {"sourceUrl": IMAGE_URL.format(filename=image["filename"])},
                extractor=f"{extractor}.image", evidence=evidence,
            )
        )  # fmt: skip
    camdram_id = society.get("id") if isinstance(society.get("id"), int) else None
    internal: dict[str, object] = {"camdram_slug": slug}
    if camdram_id is not None:
        internal["camdram_id"] = camdram_id
    return Observation(
        source_type="camdram",
        source_key=slug,
        source_url=result.final_url,
        retrieved_at=retrieved_at(result),
        content_sha256=result.content_sha256,
        fetch=fetch_info(client, result),
        entity_type="organisation",
        identity=IdentityHints(
            name=name,
            aliases=[short] if short and short != name else [],
            org_type=kind.org_type,
            level="college" if college else None,
            college_hint=college or (college_text or None),
            camdram_id=camdram_id,
            camdram_slug=slug,
        ),
        relationships=college_relationships(college, result.final_url) if college else [],
        internal=internal,
        fields=fields,
    )


def harvest(client: PoliteClient, limit: int | None = None) -> Harvest:
    out = Harvest()
    result = client.fetch(SOCIETIES_URL, accept="application/json")
    out.fetched += 1
    if not result.ok:
        out.failed += 1
        out.notes.append(f"societies.json {result.outcome} ({result.detail or result.status})")
        return out
    try:
        societies = json.loads(result.text)
    except ValueError as error:
        out.failed += 1
        out.notes.append(f"societies.json is not JSON: {error}")
        return out
    if not isinstance(societies, list):
        out.failed += 1
        out.notes.append("societies.json is not a list")
        return out
    out.notes.append(f"{len(societies)} societies on Camdram")
    if limit is not None:
        societies = societies[:limit]
    for society in societies:
        observation = (
            society_observation(society, result, client) if isinstance(society, dict) else None
        )
        if observation is None:
            out.failed += 1
            continue
        out.add(observation)
    colleges = sum(1 for o in out.observations if o.relationships)
    out.notes.append(f"{colleges} placed in a college")
    return out


__all__ = [
    "SOCIETIES_URL",
    "CamdramType",
    "camdram_type",
    "description_contacts",
    "facebook_url",
    "harvest",
    "public_description",
    "society_observation",
]
