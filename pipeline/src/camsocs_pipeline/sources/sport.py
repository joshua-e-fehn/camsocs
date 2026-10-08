"""Sport Cambridge: the University sports clubs A–Z and each club's page
(source-research §3).

- **The A–Z** (`AZ_URL`, source type ``sport_az``) is the Sports Service's list
  of recognised University sports clubs, so it is the register for
  ``registrations.sportsService`` (primary evidence). Each entry also gives
  ``orgType`` sports_club, ``level`` university and — by the documented rule
  (data-model §5) — ``categories`` sport.
- **Each club page** (``sport_club_page``) gives the club's full name (the bold
  lead, "Cambridge University Athletic Club (CUAC)" → name + ``shortName``),
  its description and its Instagram link. Its "Contact" is the Sports
  Service's generic ``support@sport.cam.ac.uk`` (some pages carry the typo
  ``support@sport.ac.uk``): that is not the club's address and is never
  claimed as one.

Traps: four A–Z links point at ``live-cambridge-sports-cwp.pantheonsite.io``,
the hosting platform's own domain for the same Drupal site, whose robots.txt
disallows every crawler. We never fetch that host; the same path on the
canonical ``www.sport.cam.ac.uk`` (whose robots.txt allows it) is fetched
instead (`canonical_url`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit, urlunsplit

from selectolax.lexbor import LexborNode

from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.contact_links import (
    dedupe_socials,
    instagram_handle,
    link_text_disagrees,
    social_link,
)
from camsocs_pipeline.sources.observe import (
    Harvest,
    clean_text,
    fetch_info,
    missing_reason,
    parse_html,
    retrieved_at,
)

AZ_URL = "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs"
CANONICAL_ORIGIN = "https://www.sport.cam.ac.uk"
#: The hosting platform's domain for the same site; robots.txt there disallows all.
PLATFORM_HOST_SUFFIX = ".pantheonsite.io"

_GENDERS = {"men": "men", "mens": "men", "women": "women", "womens": "women", "mixed": "mixed"}
#: "Lacrosse Club (Men)", "Basketball - Women": a gender at the end of a name.
_GENDER_SUFFIX = re.compile(r"(?:\s+[-–]\s*|\s*\()(men|mens|women|womens|mixed)\)?\s*$", re.I)
_SHORT_DESCRIPTION_MAX = 200


def canonical_url(url: str) -> str:
    """The same path on www.sport.cam.ac.uk for a link to the platform host."""
    parts = urlsplit(url)
    if parts.netloc.lower().endswith(PLATFORM_HOST_SUFFIX):
        origin = urlsplit(CANONICAL_ORIGIN)
        return urlunsplit((origin.scheme, origin.netloc, parts.path, parts.query, ""))
    return url


@dataclass(frozen=True)
class AzEntry:
    name: str
    url: str
    slug: str


def parse_az(html: str, base_url: str = AZ_URL) -> list[AzEntry]:
    """The clubs listed under "Sports Clubs A-Z", in page order."""
    tree = parse_html(html)
    heading = next(
        (h for h in tree.css("h2") if "sports clubs a-z" in h.text(strip=True).lower()), None
    )
    if heading is None or heading.parent is None:
        return []
    entries: list[AzEntry] = []
    seen: set[str] = set()
    for anchor in heading.parent.css("a"):
        href = (anchor.attributes.get("href") or "").strip()
        name = clean_text(anchor.text())
        if not href or not name or href.startswith(("#", "mailto:")):
            continue
        url = canonical_url(urljoin(base_url, href))
        if url in seen:
            continue
        seen.add(url)
        slug = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
        entries.append(AzEntry(name=name, url=url, slug=slug))
    return entries


def guide_url(html: str, base_url: str = AZ_URL) -> str | None:
    """The Sports Club Guide PDF the A–Z links to, on the canonical host."""
    tree = parse_html(html)
    for anchor in tree.css("a"):
        href = anchor.attributes.get("href") or ""
        if href.lower().endswith(".pdf") and "guide" in (anchor.text() + href).lower():
            return canonical_url(urljoin(base_url, href))
    return None


@dataclass
class ClubPage:
    heading: str | None = None
    name: str | None = None
    short_name: str | None = None
    description: str | None = None
    short_description: str | None = None
    socials: list[dict[str, str]] = field(default_factory=list)


_ACRONYM = re.compile(r"^(?P<name>.*?)\s*\((?P<short>[A-Z][A-Za-z&]{1,11})\)\s*$")


def _prose_block(tree) -> LexborNode | None:
    """The club's own text: the prose block holding "Follow us" / "Contact",
    else the longest prose block in the article."""
    blocks = tree.css('article [data-testid="prose"]') or tree.css('[data-testid="prose"]')
    for block in blocks:
        text = block.text().lower()
        if "follow us" in text or "contact" in text:
            return block
    return max(blocks, key=lambda b: len(b.text()), default=None)


def split_name(lead: str) -> tuple[str, str | None]:
    """ "Cambridge University Athletic Club (CUAC)" → (name, "CUAC")."""
    lead = clean_text(lead).rstrip(",;:. ")
    match = _ACRONYM.match(lead)
    if match:
        return match.group("name").strip(), match.group("short")
    return lead, None


_NAME_IN_TEXT = re.compile(
    r"\b(?P<name>(?:Cambridge University|University of Cambridge)\s+"
    r"(?:[A-Z][\w'’&-]*\s+|and\s+|of\s+){0,6}?(?:Club|Society|Association|Group))"
    r"(?:\s*\((?P<short>[A-Z][A-Za-z&]{1,11})\))?"
)


def name_in_text(text: str) -> tuple[str, str | None] | None:
    """The club's full name where the lead sentence states it ("Established in
    1896, Cambridge University Amateur Boxing Club (CUABC) is …")."""
    match = _NAME_IN_TEXT.search(text)
    return (match.group("name"), match.group("short")) if match else None


def first_sentence(text: str) -> str | None:
    match = re.match(r"(.+?[.!?])(\s|$)", text)
    sentence = (match.group(1) if match else text).strip()
    return sentence if 0 < len(sentence) <= _SHORT_DESCRIPTION_MAX else None


def parse_club_page(html: str, base_url: str) -> ClubPage:
    tree = parse_html(html)
    page = ClubPage()
    h1 = tree.css_first("h1")
    page.heading = clean_text(h1.text()) if h1 else None
    block = _prose_block(tree)
    if block is None:
        return page
    paragraphs: list[str] = []
    for paragraph in block.css("p"):
        text = clean_text(paragraph.text())
        lowered = text.lower()
        if not text or lowered.startswith(("follow us", "contact")):
            continue
        paragraphs.append(text)
    strong = block.css_first("strong")
    if strong is not None and not strong.text(strip=True).lower().startswith("contact"):
        page.name, page.short_name = split_name(strong.text())
    elif paragraphs and (stated := name_in_text(paragraphs[0])):
        page.name, page.short_name = stated
    if paragraphs:
        page.description = "\n\n".join(paragraphs)
        page.short_description = first_sentence(paragraphs[0])
    socials = []
    for anchor in block.css("a"):
        href = anchor.attributes.get("href") or ""
        entry = social_link(urljoin(base_url, href)) if href else None
        # A link whose text names another account than its target (a pasted
        # link of another club) is neither a social nor an identity hint.
        if entry is not None and not link_text_disagrees(entry, anchor.text()):
            socials.append(entry)
    page.socials = dedupe_socials(socials)
    return page


def sport_from_name(name: str) -> str | None:
    """A heuristic sport name from a club name: "Bowmen (Archery)" → "Archery",
    "Amateur Boxing Club" → "Boxing". Claimed as ``inferred``."""
    match = re.match(r"^(?P<base>.*?)\s*\((?P<paren>[^)]*)\)\s*$", name)
    if match and match.group("paren").strip().lower() not in _GENDERS:
        return match.group("paren").strip()
    base = match.group("base") if match else name
    base = re.sub(r"\b(Club|Society|Association)\s*$", "", base).strip()
    base = re.sub(r"^Amateur\s+", "", base).strip()
    return base or None


def gender_of(name: str) -> str | None:
    """ "Basketball - Men" / "Lacrosse Club (Women)" → the gender; a leading
    "Mixed" (Mixed Martial Arts) is not one."""
    match = _GENDER_SUFFIX.search(name.strip())
    return _GENDERS[match.group(1).lower()] if match else None


def without_gender(name: str) -> str:
    return _GENDER_SUFFIX.sub("", name.strip())


def gender_from_name(name: str) -> list[str]:
    gender = gender_of(name)
    return [gender] if gender else []


def az_observation(entry: AzEntry, result: FetchResult, client: PoliteClient) -> Observation:
    """What the register says about one club."""
    fields = [
        parser_field(
            "registrations.sportsService",
            {"registered": True, "sourceUrl": result.final_url},
            extractor="sport_az.listed",
            evidence="primary",
        ),
        parser_field("orgType", "sports_club", extractor="sport_az.listed", evidence="primary"),
        parser_field("level", "university", extractor="sport_az.listed", evidence="primary"),
        parser_field("isCounterpart", False, extractor="sport_az.listed", evidence="primary"),
        # data-model §5: sportsService-registered clubs are in `sport` by rule.
        parser_field("categories", ["sport"], extractor="sport_az.category", evidence="primary"),
        parser_field("aliases", [entry.name], extractor="sport_az.name", evidence="secondary"),
    ]
    genders = gender_from_name(entry.name)
    if genders:
        fields.append(
            parser_field(
                "sport.genderCategories", genders, extractor="sport_az.name", evidence="secondary"
            )
        )
    return Observation(
        source_type="sport_az",
        source_key=entry.slug,
        source_url=result.final_url,
        retrieved_at=retrieved_at(result),
        content_sha256=result.content_sha256,
        fetch=fetch_info(client, result),
        entity_type="organisation",
        identity=IdentityHints(
            name=entry.name, org_type="sports_club", level="university", sport_slug=entry.slug
        ),
        internal={"sport_slug": entry.slug},
        fields=fields,
    )


def club_observation(entry: AzEntry, result: FetchResult, client: PoliteClient) -> Observation:
    """What the club's page says; a failed fetch is recorded as such."""
    extractor = "sport_club_page"
    fields = []
    page = ClubPage()
    if result.ok:
        page = parse_club_page(result.text, result.final_url)
        name = page.name or page.heading or entry.name
        fields.append(
            parser_field("name", name, extractor=f"{extractor}.name", evidence="secondary")
        )
        aliases = sorted({a for a in (entry.name, page.heading) if a and a != name})
        if aliases:
            fields.append(
                parser_field(
                    "aliases", aliases, extractor=f"{extractor}.name", evidence="secondary"
                )
            )
        if page.short_name:
            fields.append(
                parser_field(
                    "shortName",
                    page.short_name,
                    extractor=f"{extractor}.name",
                    evidence="secondary",
                )
            )
        fields.append(
            parser_field(
                "description",
                page.description,
                extractor=f"{extractor}.prose",
                evidence="secondary",
            )
        )
        if page.short_description:
            # The lead sentence, when it is short enough; a longer one is not
            # a missing short description, just none we can quote.
            fields.append(
                parser_field(
                    "shortDescription",
                    page.short_description,
                    extractor=f"{extractor}.prose",
                    evidence="secondary",
                )
            )
        fields.append(
            parser_field(
                "socials", page.socials, extractor=f"{extractor}.socials", evidence="secondary"
            )
        )
        sport = sport_from_name(entry.name)
        if sport:
            fields.append(
                parser_field(
                    "sport.sport", sport, extractor=f"{extractor}.sport_rule", evidence="secondary",
                    inferred=True,
                )
            )  # fmt: skip
    else:
        reason = missing_reason(result)
        for field_name in ("description", "socials"):
            fields.append(
                missing_field(
                    field_name, reason, extractor=f"{extractor}.fetch", evidence="secondary"
                )
            )
    handle = instagram_handle(page.socials)
    internal: dict[str, object] = {"sport_slug": entry.slug}
    if handle:
        internal["instagram_handle"] = handle
    return Observation(
        source_type="sport_club_page",
        source_key=entry.slug,
        source_url=result.final_url if result.ok else result.url,
        retrieved_at=retrieved_at(result),
        content_sha256=result.content_sha256,
        fetch=fetch_info(client, result),
        entity_type="organisation",
        identity=IdentityHints(
            name=page.name or entry.name,
            aliases=list(
                dict.fromkeys(a for a in (entry.name, page.heading, page.short_name) if a)
            ),
            org_type="sports_club",
            level="university",
            sport_slug=entry.slug,
            instagram_handle=handle,
        ),
        internal=internal,
        fields=fields,
    )


def harvest(client: PoliteClient, limit: int | None = None) -> Harvest:
    out = Harvest()
    az = client.fetch(AZ_URL)
    out.fetched += 1
    if not az.ok:
        out.failed += 1
        out.notes.append(f"A–Z page {az.outcome} ({az.detail or az.status}); nothing staged")
        return out
    entries = parse_az(az.text, az.final_url)
    out.notes.append(f"{len(entries)} clubs on the A–Z")
    if limit is not None:
        entries = entries[:limit]
    for entry in entries:
        out.add(az_observation(entry, az, client))
        page = client.fetch(entry.url)
        out.fetched += 1
        if not page.ok:
            out.failed += 1
            out.notes.append(f"{entry.name}: {page.outcome} ({page.detail or page.status})")
        out.add(club_observation(entry, page, client))
    with_instagram = sum(
        1
        for o in out.observations
        if o.source_type == "sport_club_page" and o.identity.instagram_handle
    )
    out.notes.append(f"{with_instagram} club pages link an Instagram account")
    return out


__all__ = [
    "AZ_URL",
    "AzEntry",
    "ClubPage",
    "az_observation",
    "canonical_url",
    "club_observation",
    "gender_from_name",
    "gender_of",
    "guide_url",
    "harvest",
    "name_in_text",
    "parse_az",
    "parse_club_page",
    "split_name",
    "sport_from_name",
    "without_gender",
]
