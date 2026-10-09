"""Cambridge SU "Find a Society": the directory and every profile (source-research §1).

The directory (`DIRECTORY_URL`) is one server-rendered MSL page listing every
SU-registered society; each entry links to a profile at
``/organisation/<id or slug>/``. Both are parsed deterministically here — no
LLM — and turned into staging observations (`models.observation`):

- one ``su_directory`` observation per entry: name, SU category, the SU
  registration and what the logo's file name says about it;
- one ``su_profile`` observation per profile: email, socials, short and long
  description, website, termcard, mailing-list and chat links, feeds.

Everything the SU publishes about a society was written by the society
itself, so claims are ``primary`` evidence (§1 decision: full profiles,
descriptions included).

Rules that are easy to get wrong, and where they are enforced:

- **robots.txt** disallows ``/asset/`` for every agent, and every logo lives
  there (checked 2026-10-07). Under Joshua's decision D3 (PLAN.md,
  2026-10-08; `sources/policy.py`) an SU ``/asset/`` file linked from a
  society's profile may still be fetched with the society purpose, so the
  logo is staged as ``{"sourceUrl"}`` and the load stage stores our own copy
  (`media.py`); it is never hotlinked. Where no override applies the logo is
  ``missing`` / ``access_restricted`` (`logo_field`).
- **The Join widget is login-gated** on every profile ("Please log in to join
  this organisation."): ``joinUrl`` is ``missing`` / ``access_restricted``.
  The login page is never fetched.
- **Absent is evidence.** The profile has fixed slots (email, Instagram,
  Facebook, X, website, short and long description); an empty slot is
  ``missing`` / ``not_published``.
- **Personal CRSid addresses never enter a claim**: a CRSid in the email slot
  is withheld (``missing`` / ``not_published``, as the public projection would
  show it), and CRSids in descriptions are replaced by a marker.
- **The MSL mailing-list widget** (``mailinglist_chkLists``) lists internal SU
  voter groups with their creators' names. It is never read.
- A social URL typed into the website slot (Linktree, Instagram, …) is a
  social, not a website. A chat invite is only ever a platform.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from zoneinfo import ZoneInfo

from selectolax.lexbor import LexborHTMLParser, LexborNode

from camsocs_pipeline.claims import epoch_ms, missing_field, parser_field
from camsocs_pipeline.models.observation import (
    FetchInfo,
    FieldObs,
    IdentityHints,
    Observation,
)
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.links import (
    absolute_url,
    chat_platform,
    classify_email,
    email_domain,
    email_type,
    host_of,
    instagram_handle,
    is_email,
    is_social_host,
    mailing_list_link,
    name_tokens,
    social_link,
    unwrap_redirect,
    withhold_private,
)
from camsocs_pipeline.sources.markdown import html_to_markdown, html_to_text

SU_ORIGIN = "https://www.cambridgesu.co.uk"
DIRECTORY_URL = f"{SU_ORIGIN}/opportunities/societies/"

LONDON = ZoneInfo("Europe/London")

#: The directory's placeholder for an entry without a category.
UNCATEGORISED = "Not categorised"
#: data-model `shortDescription` / `description` limits (webapp/convex/lib/fields.ts).
SHORT_DESCRIPTION_MAX = 200
DESCRIPTION_MAX = 20_000

EVIDENCE = "primary"

# --- the directory ------------------------------------------------------------------------


@dataclass(frozen=True)
class DirectoryEntry:
    """One society as the directory lists it."""

    su_id: str
    name: str
    profile_url: str
    #: The profile path's slug when it is not the numeric id (``/organisation/cu3d/``).
    su_slug: str | None
    category: str | None
    logo_url: str | None
    #: Academic year of the SU form the logo was uploaded with
    #: ("Society Handover Form 2026-27", "New Society_ Register Here (2024-2025)").
    form_year: str | None = None
    #: When that form's logo was uploaded (the stamp MSL puts in the file name).
    logo_uploaded_at: datetime | None = None

    @property
    def logo_file(self) -> str | None:
        if self.logo_url is None:
            return None
        return unquote(urlsplit(self.logo_url).path.rsplit("/", 1)[-1])


_FORM_YEAR = (
    re.compile(r"Handover Form (\d{4})-(\d{2})(?!\d)"),
    re.compile(r"Register Here \((\d{4})-\d{2}(\d{2})\)"),
)
_LOGO_STAMP = re.compile(r"__Logo__\d+_(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})__")


def parse_directory(html: str, base_url: str = DIRECTORY_URL) -> list[DirectoryEntry]:
    """Every entry of the directory page, in page order.

    Entries are ``li[data-msl-grouping-id]``; each is preceded by its logo
    ``li.msl-gl-logo`` in the same list.
    """
    tree = LexborHTMLParser(html)
    entries: list[DirectoryEntry] = []
    for listing in tree.css("ul.msl_organisation_list"):
        logo_src: str | None = None
        item = listing.first_child
        while item is not None:
            if item.is_element_node and item.tag == "li":
                classes = (item.attributes.get("class") or "").split()
                if "msl-gl-logo" in classes:
                    img = item.css_first("img")
                    logo_src = img.attributes.get("src") if img is not None else None
                elif "data-msl-grouping-id" in item.attributes:
                    entry = _directory_entry(item, logo_src, base_url)
                    if entry is not None:
                        entries.append(entry)
                    logo_src = None
            item = item.next
    return entries


def _directory_entry(
    item: LexborNode, logo_src: str | None, base_url: str
) -> DirectoryEntry | None:
    su_id = (item.attributes.get("data-msl-grouping-id") or "").strip()
    link = item.css_first("a.msl-gl-link")
    if not su_id or link is None:
        return None
    name = html_to_text(link)
    profile_url = absolute_url(link.attributes.get("href"), base_url)
    if not name or profile_url is None:
        return None
    category = html_to_text(item.css_first("dd.msl-gl-attribute")) or None
    logo_url = absolute_url(logo_src, base_url) if logo_src else None
    if logo_url is not None:
        # The thumbnail parameters are presentation, not identity.
        logo_url = logo_url.split("?", 1)[0]
    logo_name = unquote(logo_url.rsplit("/", 1)[-1]) if logo_url else ""
    return DirectoryEntry(
        su_id=su_id,
        name=name,
        profile_url=profile_url,
        su_slug=_profile_slug(profile_url, su_id),
        category=category,
        logo_url=logo_url,
        form_year=_form_year(logo_name),
        logo_uploaded_at=_logo_stamp(logo_name),
    )


def _profile_slug(profile_url: str, su_id: str) -> str | None:
    segments = [s for s in urlsplit(profile_url).path.split("/") if s]
    if len(segments) == 2 and segments[0] == "organisation" and segments[1] != su_id:
        return segments[1]
    return None


def _form_year(logo_name: str) -> str | None:
    for pattern in _FORM_YEAR:
        match = pattern.search(logo_name)
        if match:
            return f"{match.group(1)}-{match.group(2)}"
    return None


def _logo_stamp(logo_name: str) -> datetime | None:
    match = _LOGO_STAMP.search(logo_name)
    if match is None:
        return None
    year, month, day, hour, minute = (int(part) for part in match.groups())
    try:
        return datetime(year, month, day, hour, minute, tzinfo=LONDON)
    except ValueError:
        return None


def academic_year_of(moment: datetime) -> str:
    """ "2026-27" for any instant from 1 July 2026 to 30 June 2027 (London) —
    `academicYearOf` in webapp/convex/lib/derived.ts."""
    local = moment.astimezone(LONDON)
    start = local.year if local.month >= 7 else local.year - 1
    return f"{start}-{(start + 1) % 100:02d}"


# --- a profile -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Resource:
    title: str
    url: str


@dataclass
class Profile:
    """What one profile page publishes. Absent slots are None / empty."""

    name: str | None = None
    #: The email slot's address as published (may be personal; see `profile_observation`).
    email: str | None = None
    #: The email slot held something that is not an address.
    email_unreadable: str | None = None
    socials: list[dict[str, str]] = field(default_factory=list)
    short_description: str | None = None
    description: str | None = None
    website: str | None = None
    join_requires_login: bool = False
    resources: list[Resource] = field(default_factory=list)
    #: Links found in the descriptions and resources, by what they are.
    mailing_list: dict[str, str] | None = None
    chat_platforms: list[str] = field(default_factory=list)
    role_emails: list[dict[str, str]] = field(default_factory=list)
    talks_list_ids: list[str] = field(default_factory=list)
    google_calendar_ids: list[str] = field(default_factory=list)
    ics_urls: list[str] = field(default_factory=list)
    ticketing_urls: list[str] = field(default_factory=list)


#: The profile's fixed social slots (MSL icon classes) → our platforms.
_SOCIAL_SLOTS = ("socinstagram", "socfacebook", "soctwitter")

_ADDRESS = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_YEAR = re.compile(r"\b(20\d{2})\b")
_TALKS_LIST = re.compile(r"^/show/(?:index|xml|ics|rss|archive)/(\d+)")
_TICKETING = (
    ("fixr.co", re.compile(r"^/organi[sz]ers?/[^/]+")),
    ("ticketsource.co.uk", re.compile(r"^/[^/]+/?$")),
    ("tickettailor.com", re.compile(r"^/events/[^/]+/?$")),
    ("eventbrite.co.uk", re.compile(r"^/o/[^/]+")),
    ("eventbrite.com", re.compile(r"^/o/[^/]+")),
)


def parse_profile(html: str, url: str) -> Profile:
    tree = LexborHTMLParser(html)
    profile = Profile()
    profile.name = html_to_text(tree.css_first("h1")) or None

    _read_email(tree, profile)
    _read_socials(tree, profile)

    short = tree.css_first(".grp-shrt-desc")
    short_text = withhold_private(html_to_text(short))
    profile.short_description = short_text or None
    long = tree.css_first(".grp-lng-desc")
    description = html_to_markdown(long, url) if long is not None else ""
    profile.description = description or None

    website = tree.css_first("a.msl_web")
    if website is not None:
        _read_website(absolute_url(website.attributes.get("href"), url), profile)

    join = tree.css_first(".side_box .mslwidget")
    profile.join_requires_login = join is not None and "log in to join" in html_to_text(join)

    for item in tree.css(".msl-resourcelist li.msl-resource a.msl-resourcetitle"):
        resource_url = absolute_url(item.attributes.get("href"), url)
        title = html_to_text(item)
        if resource_url and title:
            profile.resources.append(Resource(title=title, url=resource_url))

    for node in (short, long):
        if node is not None:
            _read_links(node, url, profile)
    return profile


def _read_email(tree: LexborHTMLParser, profile: Profile) -> None:
    slot = tree.css_first("a.socemail")
    if slot is None:
        return
    href = (slot.attributes.get("href") or "").strip()
    address = unquote(href[len("mailto:") :] if href.lower().startswith("mailto:") else href)
    address = address.split("?", 1)[0].strip()
    if is_email(address):
        profile.email = address
    else:
        profile.email_unreadable = html_to_text(slot) or href or None


def _read_socials(tree: LexborHTMLParser, profile: Profile) -> None:
    for anchor in tree.css("a.msl-icon"):
        classes = (anchor.attributes.get("class") or "").split()
        if not any(slot in classes for slot in _SOCIAL_SLOTS):
            continue
        url = absolute_url(anchor.attributes.get("href"))
        item = social_link(url) if url else None
        if item is not None:
            _add_social(profile, item)


def _add_social(profile: Profile, item: dict[str, str]) -> None:
    key = _comparable(item["url"])
    if all(_comparable(existing["url"]) != key for existing in profile.socials):
        profile.socials.append(item)


def _comparable(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.")
    return f"{host}{parts.path.rstrip('/')}".lower()


def _read_website(url: str | None, profile: Profile) -> None:
    if url is None:
        return
    social = social_link(url)
    if social is not None:
        _add_social(profile, social)
        return
    platform = chat_platform(url)
    if platform is not None:
        _add_chat(profile, platform)
        return
    if is_social_host(url):
        return  # a social link that names no account ("facebook.com/group.php")
    profile.website = url


def _add_chat(profile: Profile, platform: str) -> None:
    if platform not in profile.chat_platforms:
        profile.chat_platforms.append(platform)


def _read_links(node: LexborNode, base_url: str, profile: Profile) -> None:
    """Mailing lists, chat channels, role addresses and feeds named in free text."""
    for anchor in node.css("a[href]"):
        href = (anchor.attributes.get("href") or "").strip()
        if href.lower().startswith("mailto:"):
            address = unquote(href[len("mailto:") :]).split("?", 1)[0].strip()
            _read_address(address, profile)
            continue
        url = absolute_url(unwrap_redirect(href), base_url)
        if url is None:
            continue
        _read_url(url, profile)
    for address in _ADDRESS.findall(node.text(separator=" ")):
        _read_address(address.rstrip("."), profile)


def _read_address(address: str, profile: Profile) -> None:
    """An address in a description: a Sympa list is the mailing list; an
    address naming a committee post (``treasurer.cbms@…``) is a role email.
    Nothing else is taken from free text — a general-looking address there
    may be anyone's."""
    if not is_email(address) or email_type(address) == "personal_crsid":
        return
    if email_type(address) == "lists_cam" and profile.mailing_list is None:
        profile.mailing_list = {"platform": "sympa", "address": address}
        return
    reading = classify_email(address)
    if reading.kind != "role" or reading.role in (None, "other"):
        return
    entry = {"role": reading.role, "email": address}
    if all(
        (e["role"], e["email"].lower()) != (entry["role"], address.lower())
        for e in profile.role_emails
    ):
        profile.role_emails.append(entry)


def _read_url(url: str, profile: Profile) -> None:
    host = host_of(url)
    path = urlsplit(url).path
    listing = mailing_list_link(url)
    if listing is not None:
        if profile.mailing_list is None or "signupUrl" not in profile.mailing_list:
            address = (profile.mailing_list or {}).get("address")
            profile.mailing_list = {**listing, **({"address": address} if address else {})}
        return
    platform = chat_platform(url)
    if platform is not None:
        _add_chat(profile, platform)
        return
    if host in ("linktr.ee", "linktree.com"):
        social = social_link(url)
        if social is not None:
            _add_social(profile, social)
        return
    if host == "talks.cam.ac.uk":
        match = _TALKS_LIST.match(path)
        if match and match.group(1) not in profile.talks_list_ids:
            profile.talks_list_ids.append(match.group(1))
        return
    if host == "calendar.google.com":
        calendar_id = _google_calendar_id(url)
        if calendar_id and calendar_id not in profile.google_calendar_ids:
            profile.google_calendar_ids.append(calendar_id)
        return
    if path.lower().endswith(".ics") and url not in profile.ics_urls:
        profile.ics_urls.append(url)
        return
    for ticket_host, pattern in _TICKETING:
        if host == ticket_host and pattern.match(path) and url not in profile.ticketing_urls:
            profile.ticketing_urls.append(url)
            return


def sympa_list_name(mailing_list: dict[str, str] | None) -> str | None:
    """The Sympa list a mailing-list value names (``soc-chess``), from its
    address or its ``/sympa/subscribe|info/<list>`` link."""
    if not mailing_list or mailing_list.get("platform") != "sympa":
        return None
    address = mailing_list.get("address")
    if address:
        return address.partition("@")[0].lower()
    segments = [s for s in urlsplit(mailing_list.get("signupUrl", "")).path.split("/") if s]
    return unquote(segments[2]).lower() if len(segments) >= 3 else None


def _google_calendar_id(url: str) -> str | None:
    """A calendar id the link states in plain text (``?src=`` or
    ``/calendar/ical/<id>/``). An encoded ``cid`` is left alone."""
    parts = urlsplit(url)
    source = parse_qs(parts.query).get("src")
    if source:
        return source[0]
    match = re.match(r"^/calendar/ical/([^/]+)/", parts.path)
    return unquote(match.group(1)) if match else None


# --- observations ---------------------------------------------------------------------------


def _fetched_at(page: FetchResult) -> datetime:
    return datetime.fromisoformat(page.fetched_at)


def _fetch_info(page: FetchResult, *, note: str | None = None) -> FetchInfo:
    return FetchInfo(http_status=page.status, robots_verdict="allowed", access_note=note)


def _identity(entry: DirectoryEntry, name: str | None = None, **hints: Any) -> IdentityHints:
    return IdentityHints(
        name=name or entry.name,
        su_id=entry.su_id,
        su_slug=entry.su_slug,
        **{key: value for key, value in hints.items() if value},
    )


def _internal(entry: DirectoryEntry, **values: Any) -> dict[str, Any]:
    internal: dict[str, Any] = {"su_org_id": entry.su_id}
    if entry.su_slug:
        internal["su_slug"] = entry.su_slug
    internal.update({key: value for key, value in values.items() if value})
    return internal


def logo_field(entry: DirectoryEntry, *, robots_allows: bool | None) -> FieldObs | None:
    """The logo as far as we may record it. ``robots_allows``: whether we may
    fetch the file (robots.txt, or the D3 society override for SU
    ``/asset/`` files); None = not checked (a dry run), and then nothing is
    said. A fetchable logo is staged as ``{"sourceUrl"}``: the load stage
    stores our own copy, or posts nothing when the bytes cannot be had —
    never a hotlink."""
    extractor = "su_directory.logo"
    if entry.logo_url is None:
        return missing_field("logo", "not_published", extractor=extractor, evidence=EVIDENCE)
    if robots_allows is False:
        return missing_field("logo", "access_restricted", extractor=extractor, evidence=EVIDENCE)
    if robots_allows is None:
        return None
    return parser_field(
        "logo", {"sourceUrl": entry.logo_url}, extractor=extractor, evidence=EVIDENCE
    )


def directory_observation(
    entry: DirectoryEntry,
    page: FetchResult,
    *,
    logo_allowed: bool | None,
    logo_note: str | None = None,
) -> Observation:
    """What the directory says about one society (source type ``su_directory``).
    ``logo_note``: how the logo may be fetched, when that needed the D3
    society override (``robots_override:society``); it goes on the access
    note of the observation's `sources` row."""
    retrieved_at = _fetched_at(page)
    fields: list[FieldObs] = [
        parser_field("name", entry.name, extractor="su_directory.name", evidence=EVIDENCE),
    ]
    if entry.category and entry.category != UNCATEGORISED:
        fields.append(
            parser_field(
                "suCategory", entry.category, extractor="su_directory.category", evidence=EVIDENCE
            )
        )
    else:
        fields.append(
            missing_field(
                "suCategory", "not_published", extractor="su_directory.category", evidence=EVIDENCE
            )
        )

    registration: dict[str, Any] = {"registered": True, "sourceUrl": DIRECTORY_URL}
    # Only a form for the year we are in confirms it; an older form's logo just
    # was not replaced, and the listing itself says "registered now".
    if entry.form_year is not None and entry.form_year == academic_year_of(retrieved_at):
        registration["year"] = entry.form_year
    fields.append(
        parser_field(
            "registrations.su",
            registration,
            extractor="su_directory.registration",
            evidence=EVIDENCE,
            value_raw=entry.logo_file if "year" in registration else None,
        )
    )
    if entry.logo_uploaded_at is not None and entry.logo_uploaded_at <= retrieved_at:
        fields.append(
            parser_field(
                "lastActiveAt",
                epoch_ms(entry.logo_uploaded_at),
                extractor="su_directory.logo_form_stamp",
                evidence=EVIDENCE,
                value_raw=entry.logo_file,
                inferred=True,
            )
        )
    logo = logo_field(entry, robots_allows=logo_allowed)
    if logo is not None:
        fields.append(logo)

    return Observation(
        entity_type="organisation",
        source_type="su_directory",
        source_key=entry.su_id,
        source_url=DIRECTORY_URL,
        retrieved_at=retrieved_at,
        content_sha256=page.content_sha256,
        fetch=_fetch_info(page, note=f"logo: {logo_note}" if logo_note else None),
        identity=_identity(entry),
        fields=fields,
        internal=_internal(entry),
    )


def profile_observation(entry: DirectoryEntry, profile: Profile, page: FetchResult) -> Observation:
    """What a profile says about its society (source type ``su_profile``)."""

    def found(name: str, value: Any, rule: str, **kwargs: Any) -> FieldObs:
        return parser_field(
            name, value, extractor=f"su_profile.{rule}", evidence=EVIDENCE, **kwargs
        )

    def absent(name: str, reason: str, rule: str) -> FieldObs:
        return missing_field(name, reason, extractor=f"su_profile.{rule}", evidence=EVIDENCE)

    fields: list[FieldObs] = []
    if profile.name:
        fields.append(found("name", profile.name, "name"))

    # The profile's contact slot is the society's (labelled), but a CRSid or
    # a name-shaped address ("jane.smith@cantab.net") names a person: never
    # stored as its email, shown as the projection would.
    reading = (
        classify_email(profile.email, name_tokens(entry.name, profile.name), labelled=True)
        if profile.email
        else None
    )
    if profile.email and reading is not None and reading.kept:
        fields.append(found("email", profile.email, "email"))
    elif profile.email:
        fields.append(absent("email", "not_published", "email.personal_withheld"))
    elif profile.email_unreadable:
        fields.append(absent("email", "not_found", "email.unreadable"))
    else:
        fields.append(absent("email", "not_published", "email"))

    fields.append(
        found("socials", profile.socials, "socials")
        if profile.socials
        else absent("socials", "not_published", "socials")
    )

    short = profile.short_description
    if short and _js_length(short) <= SHORT_DESCRIPTION_MAX:
        fields.append(found("shortDescription", short, "short_description"))
    elif not short:
        fields.append(absent("shortDescription", "not_published", "short_description"))
    description = profile.description
    if description and _js_length(description) <= DESCRIPTION_MAX:
        fields.append(found("description", description, "description"))
    elif not description:
        fields.append(absent("description", "not_published", "description"))

    fields.append(
        found("website", profile.website, "website")
        if profile.website
        else absent("website", "not_published", "website")
    )
    if profile.join_requires_login:
        fields.append(absent("joinUrl", "access_restricted", "join"))

    termcard = current_termcard(profile.resources, _fetched_at(page))
    if termcard is not None:
        resource, dated = termcard
        fields.append(found("termcardUrl", resource.url, "termcard", inferred=not dated))
    if profile.mailing_list is not None:
        fields.append(found("mailingList", profile.mailing_list, "mailing_list"))
    if profile.chat_platforms:
        fields.append(
            found("chatChannels", [{"platform": p} for p in profile.chat_platforms], "chat")
        )
    if profile.role_emails:
        fields.append(found("roleEmails", profile.role_emails, "role_emails"))

    instagram = next(
        (instagram_handle(s["url"]) for s in profile.socials if s["platform"] == "instagram"),
        None,
    )
    website_domain = host_of(profile.website) if profile.website else None
    own_domain = (
        email_domain(profile.email)
        if profile.email
        and reading is not None
        and reading.kept
        and email_type(profile.email) == "role_own_domain"
        else None
    )
    sympa = sympa_list_name(profile.mailing_list)
    return Observation(
        entity_type="organisation",
        source_type="su_profile",
        source_key=entry.su_id,
        source_url=entry.profile_url,
        retrieved_at=_fetched_at(page),
        content_sha256=page.content_sha256,
        fetch=_fetch_info(page),
        identity=_identity(
            entry,
            profile.name,
            instagram_handle=instagram,
            website_domain=website_domain,
            email_domain=own_domain,
            talks_list_ids=profile.talks_list_ids,
        ),
        fields=fields,
        internal=_internal(
            entry,
            instagram_handle=instagram,
            website_domain=website_domain,
            sympa_list=sympa,
            talks_list_ids=profile.talks_list_ids,
            google_calendar_ids=profile.google_calendar_ids,
            ics_urls=profile.ics_urls,
            ticketing_urls=profile.ticketing_urls,
        ),
    )


def _js_length(text: str) -> int:
    """Length as the server counts it (`String.length`, UTF-16 code units):
    an emoji is two."""
    return len(text.encode("utf-16-le")) // 2


def unavailable_profile_observation(entry: DirectoryEntry, page: FetchResult) -> Observation:
    """A listed profile that answered 404/410 or 401/403: the `sources` row
    records the outcome; no field is claimed from a page we could not read."""
    note = "not_found" if page.outcome == "not_found" else "access_restricted"
    return Observation(
        entity_type="organisation",
        source_type="su_profile",
        source_key=entry.su_id,
        source_url=entry.profile_url,
        retrieved_at=_fetched_at(page),
        fetch=FetchInfo(http_status=page.status, access_note=note),
        identity=_identity(entry),
        internal=_internal(entry),
    )


def current_termcard(
    resources: list[Resource], retrieved_at: datetime
) -> tuple[Resource, bool] | None:
    """The termcard among a profile's resources, and whether its title dates
    it to this academic year. One titled for an earlier year ("Michaelmas 2020
    Term Card", "Easter 2026 Termcard" in 2026-27) is stale and not returned;
    an undated one is returned as undated (its claim is then ``inferred``)."""
    current = int(academic_year_of(retrieved_at)[:4])
    undated: Resource | None = None
    for resource in resources:
        words = re.sub(r"[^a-z0-9]+", " ", f"{resource.title} {resource.url}".lower()).split()
        if "termcard" not in words and not ("term" in words and "card" in words):
            continue
        start = _academic_start(resource.title)
        if start is None:
            undated = undated or resource
        elif start >= current:
            return resource, True
    return (undated, False) if undated is not None else None


def _academic_start(title: str) -> int | None:
    """The academic year (by its first calendar year) a title names, if any:
    "2026-27" → 2026, "Michaelmas 2026" → 2026, "Lent 2027" → 2026."""
    text = title.lower()
    years = [int(year) for year in _YEAR.findall(text)]
    if not years:
        return None
    year = min(years) if re.search(r"20\d{2}\s*[-/]\s*(20)?\d{2}\b", text) else max(years)
    if re.search(r"\b(lent|easter)\b", text) and not re.search(r"\bmichaelmas\b", text):
        return year - 1
    return year


__all__ = [
    "DESCRIPTION_MAX",
    "DIRECTORY_URL",
    "SHORT_DESCRIPTION_MAX",
    "DirectoryEntry",
    "Profile",
    "Resource",
    "academic_year_of",
    "current_termcard",
    "directory_observation",
    "logo_field",
    "parse_directory",
    "parse_profile",
    "profile_observation",
    "sympa_list_name",
    "unavailable_profile_observation",
]
