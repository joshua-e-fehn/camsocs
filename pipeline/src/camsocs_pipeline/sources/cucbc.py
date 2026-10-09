"""CUCBC boat clubs (source-research §7): ``/clubs`` and each club's details page.

CUCBC lists 37 clubs: the 31 college boat clubs, plus CUBC, CUCBC itself,
Addenbrooke's, Anglia Ruskin, the Theological Colleges and the Vet School. Its
robots.txt sets ``Crawl-delay: 10``, which the polite client honours; details
pages are reused from the cache for a week (`DETAILS_FRESH_FOR`).

Per club (source type ``cucbc``): ``registrations.cucbc`` (CUCBC is the
register), the club website from the "Club Website" column (a Facebook group
there is a social link, not a website), ``sport.sport`` Rowing, and the club's
type: a college boat club (``college_boat_club``, ``level`` college,
``member_college`` its college) when its name names a college, or by
`NON_COLLEGE_CLUBS` otherwise. "Lady Margaret Boat Club" names no college; its
college comes from the club's own site, which states it (`NAMED_ELSEWHERE`).

The details page's "CUCBC Email" is written ``name[at]cucbc.org`` to keep it
from harvesters: it is never decoded (``email`` missing /
``access_restricted``). Its officer table names people and is never read.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import urljoin

from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.colleges import college_in_name, college_relationships
from camsocs_pipeline.sources.contact_links import (
    clean_url,
    has_obfuscated_emails,
    host_of,
    social_link,
)
from camsocs_pipeline.sources.observe import (
    Harvest,
    clean_text,
    fetch_info,
    parse_html,
    retrieved_at,
)
from camsocs_pipeline.sources.policy import SOCIETY_WEBSITE

CLUBS_URL = "https://www.cucbc.org/clubs"
DETAILS_FRESH_FOR = timedelta(days=7)

#: Clubs that are not a college's: (orgType, level, level stated?) — the level
#: of the medical, veterinary and theological clubs is our reading, so inferred.
NON_COLLEGE_CLUBS: dict[str, tuple[str, str, bool]] = {
    "cambridge university boat club": ("sports_club", "university", True),
    "cambridge university combined boat clubs": ("other", "intercollegiate", True),
    "addenbrooke's student boat club": ("sports_club", "intercollegiate", False),
    "anglia ruskin boat club": ("other_university_society", "external", True),
    "theological colleges boat club": ("sports_club", "external", False),
    "vet school boat club": ("sports_club", "department", False),
}

#: Clubs whose name does not name their college, with the page that says
#: which college it is (checked 2026-10-07: "The Lady Margaret Boat Club is the
#: rowing club of St John's College, Cambridge").
NAMED_ELSEWHERE: dict[str, tuple[str, str]] = {
    "lady margaret boat club": ("St John's College", "https://www.ladymargaretboatclub.org/"),
}


@dataclass(frozen=True)
class ClubRow:
    name: str
    details_url: str | None
    website: str | None


def parse_clubs(html: str, base_url: str = CLUBS_URL) -> list[ClubRow]:
    """The rows of the Boat Clubs table: club, details link, website link."""
    tree = parse_html(html)
    table = tree.css_first("#content-primary table") or tree.css_first("table")
    rows: list[ClubRow] = []
    for tr in table.css("tr") if table is not None else []:
        cells = tr.css("td")
        if len(cells) < 3:
            continue
        name = clean_text(cells[0].text())
        details = cells[1].css_first("a")
        website = cells[2].css_first("a")
        details_href = (details.attributes.get("href") or "").strip() if details else ""
        website_href = (website.attributes.get("href") or "").strip() if website else ""
        if not name:
            continue
        rows.append(
            ClubRow(
                name=name,
                details_url=urljoin(base_url, details_href) if details_href else None,
                website=clean_url(urljoin(base_url, website_href)) if website_href else None,
            )
        )
    return rows


@dataclass(frozen=True)
class ClubDetails:
    full_name: str | None
    short_name: str | None
    email_obfuscated: bool


def parse_details(html: str) -> ClubDetails:
    """The "Club Details" table; the officers table is not read."""
    tree = parse_html(html)
    values: dict[str, str] = {}
    block = tree.css_first(".clubs-info-club")
    for tr in block.css("tr") if block is not None else []:
        cells = tr.css("td")
        if len(cells) >= 2:
            values[clean_text(cells[0].text()).rstrip(":").lower()] = clean_text(cells[1].text())
    email_cell = values.get("cucbc email", "")
    return ClubDetails(
        full_name=values.get("full name") or None,
        short_name=values.get("short name") or None,
        email_obfuscated=bool(email_cell) and has_obfuscated_emails(email_cell),
    )


def classify(name: str) -> tuple[str, str, bool, str | None, str | None]:
    """(orgType, level, stated?, college, college evidence URL)."""
    key = name.lower().replace("’", "'")
    if key in NON_COLLEGE_CLUBS:
        org_type, level, stated = NON_COLLEGE_CLUBS[key]
        return org_type, level, stated, None, None
    if key in NAMED_ELSEWHERE:
        college, evidence = NAMED_ELSEWHERE[key]
        return "college_boat_club", "college", True, college, evidence
    college = college_in_name(name)
    if college:
        return "college_boat_club", "college", True, college, None
    return "sports_club", "intercollegiate", False, None, None


def club_observation(
    row: ClubRow,
    listing: FetchResult,
    client: PoliteClient,
    details: ClubDetails | None,
    *,
    college_confirmed: bool = True,
) -> Observation:
    """One club as CUCBC's ``/clubs`` lists it. What only the club's details
    page states (its full name, the hidden address) is that page's own
    observation (`details_observation`), attributed to that page.
    ``college_confirmed`` false: the page that names the club's college
    (`NAMED_ELSEWHERE`) did not confirm it this run, so no college is
    claimed."""
    extractor = "cucbc.clubs"
    evidence = "secondary"
    org_type, level, stated, college, college_evidence = classify(row.name)
    if not college_confirmed:
        college, college_evidence = None, None
    full_name = details.full_name if details and details.full_name else None
    name = full_name or row.name
    fields = [
        parser_field(
            "registrations.cucbc",
            {"registered": True, "sourceUrl": listing.final_url},
            extractor=f"{extractor}.listed",
            evidence="primary",
        ),
        parser_field("orgType", org_type, extractor=f"{extractor}.type", evidence=evidence),
        parser_field("level", level, extractor=f"{extractor}.type", evidence=evidence,
                     inferred=not stated),
        parser_field("isCounterpart", False, extractor=f"{extractor}.type", evidence=evidence),
        parser_field("sport.sport", "Rowing", extractor=f"{extractor}.sport", evidence=evidence),
        parser_field("categories", ["sport"], extractor=f"{extractor}.category_rule",
                     evidence=evidence, inferred=True),
    ]  # fmt: skip
    if full_name is None:
        fields.insert(
            0, parser_field("name", row.name, extractor=f"{extractor}.name", evidence=evidence)
        )
    elif row.name != full_name:
        fields.append(
            parser_field("aliases", [row.name], extractor=f"{extractor}.name", evidence=evidence)
        )
    website: str | None = None
    if row.website:
        social = social_link(row.website)
        if social is not None:
            fields.append(
                parser_field(
                    "socials", [social], extractor=f"{extractor}.website", evidence=evidence
                )
            )
        else:
            website = row.website
            fields.append(
                parser_field(
                    "website", website, extractor=f"{extractor}.website", evidence=evidence
                )
            )
    relationships = []
    if college:
        # The club's own site, when it is what names the college, is primary.
        relationships = college_relationships(
            college,
            college_evidence or listing.final_url,
            evidence="primary" if college_evidence else "secondary",
        )
    internal: dict[str, object] = {}
    if details and details.short_name:
        internal["cucbc_club"] = details.short_name
    if website:
        internal["website_domain"] = host_of(website)
    return Observation(
        source_type="cucbc",
        source_key=row.details_url or row.name,
        source_url=listing.final_url,
        retrieved_at=retrieved_at(listing),
        content_sha256=listing.content_sha256,
        fetch=fetch_info(client, listing),
        entity_type="organisation",
        identity=IdentityHints(
            name=name,
            aliases=[a for a in {row.name} if a != name],
            org_type=org_type,
            level=level if stated else None,
            college_hint=college,
            cucbc_club=details.short_name if details else None,
            website_domain=host_of(website) if website else None,
        ),
        relationships=relationships,
        internal=internal,
        fields=fields,
    )


def details_observation(
    listed: Observation, page: FetchResult, client: PoliteClient, details: ClubDetails
) -> Observation | None:
    """What the club's details page states, from that page: its full name,
    and that its "CUCBC Email" is hidden (written ``name[at]cucbc.org`` to
    keep it from harvesters; never decoded). Same identity as the listing."""
    extractor, evidence = "cucbc.details", "secondary"
    fields = []
    if details.full_name:
        fields.append(
            parser_field(
                "name", details.full_name, extractor=f"{extractor}.name", evidence=evidence
            )
        )
    if details.email_obfuscated:
        fields.append(
            missing_field(
                "email", "access_restricted", extractor=f"{extractor}.email", evidence=evidence
            )
        )
    if not fields:
        return None
    return Observation(
        source_type="cucbc",
        source_key=page.final_url,
        source_url=page.final_url,
        retrieved_at=retrieved_at(page),
        content_sha256=page.content_sha256,
        fetch=fetch_info(client, page),
        entity_type="organisation",
        identity=listed.identity,
        fields=fields,
    )


def harvest(client: PoliteClient, limit: int | None = None) -> Harvest:
    out = Harvest()
    listing = client.fetch(CLUBS_URL)
    out.fetched += 1
    if not listing.ok:
        out.failed += 1
        out.notes.append(f"/clubs {listing.outcome} ({listing.detail or listing.status})")
        return out
    rows = parse_clubs(listing.text, listing.final_url)
    colleges = sum(1 for row in rows if classify(row.name)[3])
    out.notes.append(f"{len(rows)} clubs on /clubs, {colleges} of them college boat clubs")
    if limit is not None:
        rows = rows[:limit]
    for row in rows:
        details: ClubDetails | None = None
        page: FetchResult | None = None
        if row.details_url:
            page = client.fetch(row.details_url, fresh_for=DETAILS_FRESH_FOR)
            out.fetched += 1
            if page.ok:
                details = parse_details(page.text)
            else:
                out.notes.append(f"{row.name}: details {page.outcome}")
        confirmed = True
        elsewhere = NAMED_ELSEWHERE.get(row.name.lower())
        if elsewhere is not None:
            confirmed = confirms_college(client, *elsewhere)
            out.fetched += 1
            if not confirmed:
                out.notes.append(f"{row.name}: {elsewhere[1]} no longer names {elsewhere[0]}")
        listed = club_observation(row, listing, client, details, college_confirmed=confirmed)
        out.add(listed)
        if details is not None and page is not None:
            detailed = details_observation(listed, page, client, details)
            if detailed is not None:
                out.add(detailed)
    unplaced = [
        row.name
        for row in rows
        if classify(row.name)[3] is None and row.name.lower() not in NON_COLLEGE_CLUBS
    ]
    if unplaced:
        out.notes.append(f"clubs of unknown type (sports_club, inferred): {', '.join(unplaced)}")
    return out


def confirms_college(client: PoliteClient, college: str, url: str) -> bool:
    """Whether `url` (the club's own website) still says the club belongs to
    `college`. A society website: fetched with the D3 society purpose."""
    page = client.fetch(url, fresh_for=DETAILS_FRESH_FOR, purpose=SOCIETY_WEBSITE)
    if not page.ok:
        return False
    stem = college.replace(" College", "").replace("’", "'").lower()
    text = page.text.replace("’", "'").replace("&#8217;", "'").lower()
    return stem in text


__all__ = [
    "CLUBS_URL",
    "NAMED_ELSEWHERE",
    "NON_COLLEGE_CLUBS",
    "ClubDetails",
    "ClubRow",
    "classify",
    "club_observation",
    "confirms_college",
    "details_observation",
    "harvest",
    "parse_clubs",
    "parse_details",
]
