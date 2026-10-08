"""The 31 colleges and their JCR / MCR bodies (source-research §8; LB §1.6, §2.1).

Two sources:

1. **The University's college A–Z** (`COLLEGE_AZ_URL`, source type
   ``college_list``): one observation per college — name and website, as an
   institutional counterpart (``orgType`` college, ``isCounterpart`` true).
2. **Each college's student bodies** (`BODIES`): the JCR and MCR, or what the
   college calls them (Pembroke JPC and Graduate Parlour, Trinity TCSU and BA
   Society, King's KCSU and KCGS, Darwin DCSA, Wolfson WCSA, Clare Hall GSB, …).
   The table was built on 2026-10-07 by following the links on each college's
   own website (homepage, sitemap, student pages); every URL in it was fetched
   that day. It records *where to look*; what we claim comes from the pages
   fetched at run time:

   - the **evidence page** (a college page that names the body, or the body's
     own site) gives the body's ``name`` — ``found`` when the page shows the
     full name, ``inferred`` when it only shows the short form ("JCR");
   - the **home page** (the body's own site) gives ``website`` only when it
     answers *and* names the body (a lapsed domain does not: kcgs.org.uk now
     serves something else), plus its social links and role contacts. A home
     page that fails is recorded as ``website`` missing with the reason —
     never as found;
   - a college page shared by several bodies yields only the links labelled
     for this body ("JCR Instagram"); a page dedicated to the body yields the
     links and contacts in its main content (never the college's own footer).

   Traps (§8) are handled by the rules rather than by special cases: the Caius
   JCR site disallows every crawler (robots.txt) → ``access_restricted``;
   Wolfson's WCSA site resets the connection → ``unreachable`` (the college's
   own WCSA page is used instead of an archive copy); Queens' and Churchill
   hide addresses behind Cloudflare email protection → never decoded, ``email``
   and ``roleEmails`` missing / ``access_restricted``; members-only and 403
   pages (Homerton's society list, Lucy Cavendish, Peterhouse) are not in the
   table. Named officers are not read: personal CRSids and names stay out.

Relationships: each body is ``member_college`` of its college and the college
``parent_of`` the body (`parent` on the observation, which the load stage turns
into ``parentKey``; ``collegeKeys`` comes from ``member_college``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin

from selectolax.lexbor import LexborHTMLParser, LexborNode

from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.extract.evidence import normalise_text
from camsocs_pipeline.models.observation import IdentityHints, Observation, RelObs
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.contact_links import (
    Contacts,
    classify_email,
    clean_url,
    dedupe_socials,
    find_emails,
    has_obfuscated_emails,
    host_of,
    instagram_handle,
    name_tokens,
    normalise_email,
    social_link,
)
from camsocs_pipeline.sources.observe import (
    Harvest,
    clean_text,
    fetch_info,
    missing_reason,
    parse_html,
    retrieved_at,
    visible_text,
)

COLLEGE_AZ_URL = "https://www.cam.ac.uk/colleges-and-departments/college-a-z"

#: The 31 colleges as the A–Z names them (checked 2026-10-07). Used to give
#: every reference to a college (a boat club's, a theatre society's) the same
#: identity; the colleges stage warns if the live list ever differs.
COLLEGES: tuple[str, ...] = (
    "Christ's College",
    "Churchill College",
    "Clare College",
    "Clare Hall",
    "Corpus Christi College",
    "Darwin College",
    "Downing College",
    "Emmanuel College",
    "Fitzwilliam College",
    "Girton College",
    "Gonville & Caius College",
    "Homerton College",
    "Hughes Hall",
    "Jesus College",
    "King's College",
    "Lucy Cavendish College",
    "Magdalene College",
    "Murray Edwards College",
    "Newnham College",
    "Pembroke College",
    "Peterhouse",
    "Queens' College",
    "Robinson College",
    "Selwyn College",
    "Sidney Sussex College",
    "St Catharine's College",
    "St Edmund's College",
    "St John's College",
    "Trinity College",
    "Trinity Hall",
    "Wolfson College",
)

#: Other names sources use for a college.
_COLLEGE_ALIASES: dict[str, str] = {
    "caius": "Gonville & Caius College",
    "gonville and caius": "Gonville & Caius College",
    "catz": "St Catharine's College",
    "fitz": "Fitzwilliam College",
    "corpus": "Corpus Christi College",
    "emma": "Emmanuel College",
    "eddies": "St Edmund's College",
    "lucy": "Lucy Cavendish College",
    "medwards": "Murray Edwards College",
    "new hall": "Murray Edwards College",
    "sidney": "Sidney Sussex College",
    "tit hall": "Trinity Hall",
}


def _college_key(text: str) -> str:
    text = text.lower().replace("’", "'").replace("&", " and ")
    text = re.sub(r"\bst\.?\s", "st ", text)
    text = re.sub(r"[^a-z ]+", "", text.replace("'", ""))
    text = re.sub(r"\bcollege\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


_BY_KEY = {_college_key(name): name for name in COLLEGES}


def canonical_college(hint: str | None) -> str | None:
    """The A–Z name of the college a hint names ("Caius", "St. Catharine's",
    "Queens'"), or None."""
    if not hint:
        return None
    key = _college_key(hint)
    if key in _BY_KEY:
        return _BY_KEY[key]
    return _COLLEGE_ALIASES.get(key)


def college_in_name(name: str) -> str | None:
    """The college a club name contains ("Caius Boat Club", "First and Third
    Trinity Boat Club"); the longest match wins, so "Trinity Hall" beats
    "Trinity" and "Clare Hall" beats "Clare"."""
    key = f" {_college_key(name)} "
    best: str | None = None
    best_len = 0
    for college_key, college in [*_BY_KEY.items(), *_COLLEGE_ALIASES.items()]:
        canonical = _BY_KEY.get(college_key, college)
        if f" {college_key} " in key and len(college_key) > best_len:
            best, best_len = canonical, len(college_key)
    return best


def college_identity(college: str) -> IdentityHints:
    """How every source refers to a college (canonical A–Z name)."""
    return IdentityHints(name=college, org_type="college", level="college")


def college_relationships(
    college: str, evidence_url: str, *, parent: bool = False, evidence: str = "secondary"
) -> list[RelObs]:
    """``member_college`` from the observed group to its college, and (for a
    JCR/MCR) the college as ``parent_of`` it. `evidence`: of the page at
    `evidence_url` (primary when it is the group's own)."""
    rels = [
        RelObs(
            type="member_college",
            to_identity=college_identity(college),
            evidence_url=evidence_url,
            direction="outgoing",
            evidence=evidence,
        )
    ]
    if parent:
        rels.append(
            RelObs(
                type="parent_of",
                to_identity=college_identity(college),
                evidence_url=evidence_url,
                direction="incoming",
            )
        )
    return rels


# --- the college A–Z --------------------------------------------------------------------


@dataclass(frozen=True)
class CollegeEntry:
    name: str
    website: str | None


def parse_college_az(html: str, base_url: str = COLLEGE_AZ_URL) -> list[CollegeEntry]:
    """Each ``<h3>`` college under "List of Colleges" with its "Visit the …
    website" link."""
    tree = parse_html(html)
    heading = next(
        (h for h in tree.css("h2") if "list of colleges" in h.text(strip=True).lower()), None
    )
    if heading is None or heading.parent is None:
        return []
    entries: list[CollegeEntry] = []
    current: str | None = None
    website: str | None = None
    started = False
    for node in heading.parent.traverse(include_text=False):
        if node is heading or node.mem_id == heading.mem_id:
            started = True
        elif not started:
            continue
        elif node.tag == "h2":
            break
        elif node.tag == "h3":
            if current:
                entries.append(CollegeEntry(current, website))
            current, website = clean_text(node.text()), None
        elif node.tag == "a" and current and website is None:
            text = node.text(strip=True).lower()
            href = node.attributes.get("href") or ""
            if text.startswith("visit") and "website" in text and href:
                website = clean_url(urljoin(base_url, href))
    if current:
        entries.append(CollegeEntry(current, website))
    return entries


def college_observations(
    result: FetchResult, client: PoliteClient
) -> tuple[list[Observation], list[str]]:
    notes: list[str] = []
    if not result.ok:
        return [], [f"college A–Z: {result.outcome} ({result.detail or result.status})"]
    entries = parse_college_az(result.text, result.final_url)
    names = {entry.name for entry in entries}
    if names != set(COLLEGES):
        unexpected = sorted(names - set(COLLEGES))
        absent = sorted(set(COLLEGES) - names)
        notes.append(f"college A–Z differs from COLLEGES: new {unexpected}, absent {absent}")
    info = fetch_info(client, result)
    observations = []
    for entry in entries:
        fields = [
            parser_field("name", entry.name, extractor="college_az.name", evidence="secondary"),
            parser_field("orgType", "college", extractor="college_az.type", evidence="secondary"),
            parser_field("level", "college", extractor="college_az.type", evidence="secondary"),
            parser_field(
                "isCounterpart", True, extractor="college_az.counterpart", evidence="secondary"
            ),
        ]
        if entry.website:
            fields.append(
                parser_field(
                    "website", entry.website, extractor="college_az.website", evidence="secondary"
                )
            )
        observations.append(
            Observation(
                source_type="college_list",
                source_key=entry.name,
                source_url=result.final_url,
                retrieved_at=retrieved_at(result),
                content_sha256=result.content_sha256,
                fetch=info,
                entity_type="organisation",
                identity=IdentityHints(
                    name=entry.name,
                    org_type="college",
                    level="college",
                    website_domain=host_of(entry.website) if entry.website else None,
                ),
                fields=fields,
            )
        )
    notes.append(f"{len(entries)} colleges on the A–Z")
    return observations, notes


# --- JCR / MCR bodies ---------------------------------------------------------------------


@dataclass(frozen=True)
class Body:
    """One college student body and where it is published (checked 2026-10-07)."""

    college: str
    name: str
    org_type: str  # jcr | mcr
    college_body: str  # jcr | mcr | joint
    #: Texts any of which shows a page is talking about this body ("JCR").
    match: tuple[str, ...]
    #: The body's own site, as its college links it.
    home: str | None = None
    #: A page that names the body, when it is not `home` (usually the college's).
    evidence: str | None = None
    #: `evidence` is about this body alone, so its main content is the body's.
    dedicated: bool = False
    short_name: str | None = None
    aliases: tuple[str, ...] = ()


def _b(college: str, name: str, org_type: str, match: tuple[str, ...], **kw) -> Body:
    return Body(
        college=college,
        name=name,
        org_type=org_type,
        college_body=kw.pop("college_body", org_type),
        match=match,
        **kw,
    )


_J, _M = (
    ("JCR", "Junior Combination Room", "Junior Common Room"),
    (
        "MCR",
        "Middle Combination Room",
    ),
)

BODIES: tuple[Body, ...] = (
    _b("Christ's College", "Christ's JCR", "jcr", _J, home="https://thejcr.co.uk/",
       aliases=("Christ's College JCR",)),
    _b("Christ's College", "Christ's College MCR", "mcr", _M, home="http://www.christsmcr.co.uk/",
       evidence="https://www.christs.cam.ac.uk/admissions/postgraduate-admissions/christs-college-graduate-union-mcr",
       dedicated=True, aliases=("Christ's MCR", "Christ's College Graduate Union")),
    _b("Churchill College", "Churchill College JCR", "jcr", _J,
       evidence="https://www.chu.cam.ac.uk/about/governance/jcr-and-mcr/"),
    _b("Churchill College", "Churchill College MCR", "mcr", _M,
       evidence="https://www.chu.cam.ac.uk/about/governance/jcr-and-mcr/"),
    _b("Clare College", "Union of Clare Students", "jcr", ("UCS", "Union of Clare Students"),
       home="https://ucs.clare.cam.ac.uk/", short_name="UCS", aliases=("Clare JCR",)),
    _b("Clare College", "Clare MCR", "mcr", _M, home="https://mcr.clare.cam.ac.uk/",
       evidence="https://www.clare.cam.ac.uk/admissions-outreach/postgraduate-study/mcr",
       dedicated=True, aliases=("Clare College MCR",)),
    _b("Clare Hall", "Clare Hall Graduate Student Body", "mcr", ("Graduate Student Body", "GSB"),
       home="https://www.clarehall.cam.ac.uk/gsb/", short_name="GSB"),
    _b("Corpus Christi College", "Corpus Christi JCR", "jcr", _J,
       home="https://www.jcr.corpus.cam.ac.uk/", aliases=("Corpus JCR",)),
    _b("Corpus Christi College", "Corpus Christi College MCR", "mcr", _M,
       home="https://corpusmcr.soc.srcf.net/", aliases=("Corpus MCR",)),
    _b("Darwin College", "Darwin College Students' Association", "mcr",
       ("DCSA", "Darwin College Students' Association", "Darwin College Students Association"),
       home="https://www.dcsa.darwin.cam.ac.uk/", short_name="DCSA"),
    _b("Downing College", "Downing JCR", "jcr", _J, home="https://www.jcr.dow.cam.ac.uk/",
       evidence="https://www.dow.cam.ac.uk/people/downing-jcr-website", dedicated=True),
    _b("Downing College", "Downing MCR", "mcr", _M,
       evidence="https://www.dow.cam.ac.uk/people/downing-mcr", dedicated=True),
    _b("Emmanuel College", "Emmanuel College Students' Union", "jcr", ("ECSU",),
       home="https://www.ecsu.org.uk/", evidence="https://www.emmaexperience.uk/",
       short_name="ECSU"),
    _b("Fitzwilliam College", "Fitzwilliam College JCR", "jcr", _J, home="https://www.fitzjcr.com",
       evidence="https://www.fitz.cam.ac.uk/jcr-mcr", aliases=("Fitz JCR",)),
    _b("Fitzwilliam College", "Fitz MCR", "mcr", _M,
       home="https://sites.google.com/cam.ac.uk/fitzmcr",
       evidence="https://www.fitz.cam.ac.uk/jcr-mcr", aliases=("Fitzwilliam College MCR",)),
    _b("Girton College", "Girton College JCR", "jcr", _J, home="https://girtonjcr.soc.srcf.net/",
       evidence="https://www.girton.cam.ac.uk/life-girton/jcr", dedicated=True),
    _b("Girton College", "Girton College MCR", "mcr", _M,
       home="https://sites.google.com/cam.ac.uk/girton-mcr/home",
       evidence="https://www.girton.cam.ac.uk/life-girton/mcr", dedicated=True),
    _b("Gonville & Caius College", "Gonville & Caius Student Union", "jcr",
       ("Student Union", "JCR"), home="http://jcr.cai.cam.ac.uk/",
       evidence="https://www.cai.cam.ac.uk/living-here/facilities/clubs-and-societies",
       aliases=("Caius JCR",)),
    _b("Homerton College", "Homerton Union of Students", "jcr",
       ("HUS", "Homerton Union of Students"), home="https://www.hus-jcr.co.uk/",
       evidence="https://www.homerton.cam.ac.uk/current-members/students/undergraduates/jcr",
       dedicated=True, short_name="HUS", aliases=("Homerton JCR",)),
    _b("Homerton College", "Homerton College MCR", "mcr", _M,
       evidence="https://www.homerton.cam.ac.uk/current-members/students/postgraduates/mcr",
       dedicated=True),
    _b("Hughes Hall", "Hughes Hall MCR", "mcr", _M,
       home="https://www.hughes.cam.ac.uk/student-centre/hughes-hall-mcr/"),
    _b("Jesus College", "Jesus College Student Union", "jcr",
       ("JCSU", "Jesus College Student Union"), home="https://jcsu.jesus.cam.ac.uk/",
       short_name="JCSU", aliases=("Jesus JCR",)),
    _b("Jesus College", "Jesus College MCR", "mcr", _M, home="https://mcr.jesus.cam.ac.uk/"),
    _b("King's College", "King's College Student Union", "jcr", ("KCSU", "King's College SU"),
       home="https://kcsu.org.uk/", short_name="KCSU", aliases=("King's College SU",)),
    _b("King's College", "King's Graduate Society", "mcr", ("King's Graduate Society", "KCGS"),
       home="https://kcgs.org.uk/", evidence="https://kcsu.org.uk/", short_name="KCGS"),
    _b("Lucy Cavendish College", "Lucy Cavendish JCR", "jcr", ("JCR",),
       evidence="https://www.lucy.cam.ac.uk/our-college/place-live-and-study/students-union"),
    _b("Lucy Cavendish College", "Lucy Cavendish MCR", "mcr", ("MCR",),
       evidence="https://www.lucy.cam.ac.uk/our-college/place-live-and-study/students-union"),
    _b("Magdalene College", "Magdalene College JCR", "jcr", _J,
       home="https://www.jcr.magd.cam.ac.uk/",
       evidence="https://www.magd.cam.ac.uk/college-life/undergraduate-life-jcr", dedicated=True),
    _b("Magdalene College", "Magdalene MCR", "mcr", _M, home="https://www.mcr.magd.cam.ac.uk/",
       evidence="https://www.magd.cam.ac.uk/college-life/postgraduate-life-mcr", dedicated=True,
       aliases=("Magdalene College MCR",)),
    _b("Murray Edwards College", "Murray Edwards JCR", "jcr", _J,
       evidence="https://www.murrayedwards.cam.ac.uk/college-life/sports-and-societies"),
    _b("Murray Edwards College", "Murray Edwards MCR", "mcr", _M,
       evidence="https://www.murrayedwards.cam.ac.uk/college-life/sports-and-societies"),
    _b("Newnham College", "Newnham College JCR", "jcr", _J, home="https://newnhamjcr.uk/"),
    _b("Newnham College", "Newnham College MCR", "mcr", _M,
       home="https://newnhammcr.soc.srcf.net/"),
    _b("Pembroke College", "Pembroke JPC", "jcr", ("JPC", "Junior Parlour"),
       home="https://jp.pem.cam.ac.uk/", short_name="JPC", aliases=("Pembroke JCR",)),
    _b("Pembroke College", "Pembroke College Graduate Parlour", "mcr", ("Graduate Parlour",),
       home="https://gp.pem.cam.ac.uk/", aliases=("Pembroke MCR",)),
    _b("Peterhouse", "Peterhouse JCR", "jcr", _J, home="http://www.peterhousejcr.co.uk/",
       evidence="https://www.pet.cam.ac.uk/incoming-students"),
    _b("Peterhouse", "Peterhouse MCR", "mcr", _M,
       evidence="https://www.pet.cam.ac.uk/incoming-students"),
    _b("Queens' College", "Queens' JCR", "jcr", _J, home="https://qjcr.org.uk/",
       aliases=("Queens' College JCR",)),
    _b("Robinson College", "Robinson College Students' Association", "jcr",
       ("RCSA", "Robinson College Students' Association"), home="https://www.rcsa.co.uk/",
       short_name="RCSA"),
    _b("Robinson College", "Robinson MCR", "mcr", _M, home="https://mcr.robinson.cam.ac.uk/"),
    _b("St Catharine's College", "Catz JCR", "jcr", _J, home="https://www.catzjcr.com/",
       evidence="https://www.caths.cam.ac.uk/students/junior-common-room", dedicated=True,
       aliases=("St Catharine's JCR",)),
    _b("St Catharine's College", "St Catharine's College MCR", "mcr", _M,
       home="https://mcr.caths.cam.ac.uk/",
       evidence="https://www.caths.cam.ac.uk/students/postgraduate-students/mcr", dedicated=True,
       aliases=("Catz MCR",)),
    _b("St Edmund's College", "St Edmund's Combination Room", "mcr", ("Combination Room",),
       evidence="https://www.st-edmunds.cam.ac.uk/college-life/bar-cr/", dedicated=True,
       college_body="joint"),
    _b("St John's College", "St John's JCR", "jcr", _J, home="https://www.sjcjcr.com/",
       evidence="https://www.joh.cam.ac.uk/live-and-study/societies/junior-combination-room",
       dedicated=True, aliases=("St. John's JCR",)),
    _b("St John's College", "Samuel Butler Room", "mcr", ("Samuel Butler Room", "SBR"),
       home="http://sbr.soc.srcf.net/",
       evidence="https://www.joh.cam.ac.uk/live-and-study/societies/the-samuel-butler-room",
       dedicated=True, short_name="SBR", aliases=("St John's MCR",)),
    _b("Selwyn College", "Selwyn College JCR", "jcr", _J, home="https://selwynjcr.org/"),
    _b("Selwyn College", "Selwyn College MCR", "mcr", _M, home="http://www-mcr.sel.cam.ac.uk/",
       evidence="https://www.sel.cam.ac.uk/current-members/information-students"),
    _b("Sidney Sussex College", "Sidney Sussex College Students' Union", "jcr", ("SSCSU",),
       evidence="https://www.sid.cam.ac.uk/life-sidney/clubs-and-societies/sscsu-jcr",
       dedicated=True, short_name="SSCSU", aliases=("Sidney JCR",)),
    _b("Sidney Sussex College", "Sidney Sussex MCR", "mcr", _M,
       home="http://www.sidneysussexmcr.com/",
       evidence="https://www.sid.cam.ac.uk/life-sidney/clubs-and-societies/mcr", dedicated=True),
    _b("Trinity College", "Trinity College Students' Union", "jcr", ("TCSU",),
       home="http://www.tcsu.net/", short_name="TCSU"),
    _b("Trinity College", "BA Society", "mcr", ("BA Society",), home="http://basociety.net/",
       aliases=("Trinity BA Society",)),
    _b("Trinity Hall", "Trinity Hall JCR", "jcr", _J, home="https://jcr.trinhall.cam.ac.uk/"),
    _b("Trinity Hall", "Trinity Hall MCR", "mcr", _M, home="https://mcr.trinhall.cam.ac.uk/"),
    _b("Wolfson College", "Wolfson College Students' Association", "mcr", ("WCSA",),
       home="https://wcsa.wolfson.cam.ac.uk/",
       evidence="https://www.wolfson.cam.ac.uk/student-association-wcsa", dedicated=True,
       short_name="WCSA", college_body="joint"),
)  # fmt: skip

#: A page with less readable text than this is a script-rendered app: it
#: cannot name anyone, so the college's link to it is the evidence.
_SCRIPT_APP_TEXT = 200
_MAIN_SELECTORS = ("main", "article", "[role=main]", "#content", ".content", "#main")


def names_body(text: str, body: Body) -> str | None:
    """``full`` if `text` shows the body's name or an alias, ``short`` if only
    a match token ("JCR"), else None."""
    folded = normalise_text(text)
    if any(normalise_text(name) in folded for name in (body.name, *body.aliases)):
        return "full"
    for token in body.match:
        if re.search(rf"(?<![a-z]){re.escape(normalise_text(token))}(?![a-z])", folded):
            return "short"
    return None


def _main_content(tree: LexborHTMLParser) -> LexborNode | None:
    for selector in _MAIN_SELECTORS:
        node = tree.css_first(selector)
        if node is not None:
            return node
    return None


def _labelled(text: str, body: Body) -> bool:
    folded = normalise_text(text)
    return any(
        re.search(rf"(?<![a-z]){re.escape(normalise_text(token))}(?![a-z])", folded)
        for token in (*body.match, body.name)
    )


@dataclass
class PageReading:
    """What one fetched page says about one body."""

    named: str | None = None
    socials: list[dict[str, str]] = field(default_factory=list)
    contacts: Contacts = field(default_factory=Contacts)
    obfuscated: bool = False
    text_length: int = 0


def body_tokens(body: Body) -> set[str]:
    """Short lower-case marks of the body ("jcr", "wcsa", "gsb") that its own
    links and addresses carry ("instagram.com/hugheshallmcr", "gsb.president@")."""
    marks = {body.org_type, *(m for m in body.match)}
    if body.short_name:
        marks.add(body.short_name)
    tokens = {re.sub(r"[^a-z0-9]", "", mark.lower()) for mark in marks}
    return {token for token in tokens if 2 < len(token) <= 10}


def _carries(text: str, tokens: set[str]) -> bool:
    compact = re.sub(r"[^a-z0-9]", "", text.lower())
    return any(token in compact for token in tokens)


def read_body_page(
    html: str,
    base_url: str,
    body: Body,
    *,
    scope: str,
    college_host: str | None = None,
) -> PageReading:
    """Reads one page for `body`. ``scope``: ``all`` (the body's own site),
    ``main`` (a page about the body alone: its main content only) or
    ``labelled`` (a shared page: only links whose text names the body).

    A page on the college's own site (``college_host``) also carries the
    college's links and addresses, so there only those that carry the body's
    mark (`body_tokens`: ``instagram.com/girtonmcr``, ``gsb.president@``) or
    sit in a link naming it are the body's."""
    tree = parse_html(html)
    title = tree.css_first("title")
    obfuscated = has_obfuscated_emails(html)
    page_host = host_of(base_url)
    on_college_site = college_host is not None and page_host == college_host
    if on_college_site and scope == "all":
        scope = "main"
    root: LexborNode | None = tree.body
    if scope == "main":
        root = _main_content(tree) or tree.body
    reading = PageReading(obfuscated=obfuscated)
    own = name_tokens(body.name, body.short_name, *body.aliases)
    marks = body_tokens(body)
    social_entries: list[dict[str, str]] = []
    addresses: list[tuple[str, str]] = []
    for anchor in root.css("a") if root is not None else []:
        href = (anchor.attributes.get("href") or "").strip()
        label = anchor.text(strip=True) + " " + (anchor.attributes.get("aria-label") or "")
        if scope == "labelled" and not _labelled(label + " " + href, body):
            continue
        if href.lower().startswith("mailto:"):
            addresses.append((href[7:], label))
            continue
        if not href or href.startswith("#"):
            continue
        entry = social_link(urljoin(base_url, href))
        if entry is None:
            continue
        if on_college_site and not (_carries(entry["url"], marks) or _labelled(label, body)):
            continue
        social_entries.append(entry)
    text = visible_text(tree)
    reading.text_length = len(text)
    reading.named = names_body((title.text() if title else "") + " " + text, body)
    if scope != "labelled" and root is not None:
        addresses.extend((address, "") for address in find_emails(_norm_root_text(root)))
    for address, label in addresses:
        local = normalise_email(address).rpartition("@")[0]
        if on_college_site and not (_carries(local, marks) or _labelled(label, body)):
            continue
        reading.contacts.add(classify_email(address, own, label=label or None, site_host=page_host))
    reading.socials = dedupe_socials(social_entries)
    return reading


def _norm_root_text(root: LexborNode) -> str:
    return clean_text(root.text(separator=" "))


def body_identity(body: Body, website: str | None = None) -> IdentityHints:
    return IdentityHints(
        name=body.name,
        aliases=[alias for alias in (body.short_name, *body.aliases) if alias],
        org_type=body.org_type,
        level="college",
        college_hint=body.college,
        website_domain=host_of(website) if website else None,
    )


def _classification(body: Body, evidence: str) -> list:
    audiences = {
        "jcr": ["undergraduates", "own_college_only"],
        "mcr": ["postgraduates", "own_college_only"],
        "joint": ["undergraduates", "postgraduates", "own_college_only"],
    }[body.college_body]
    fields = [
        parser_field("orgType", body.org_type, extractor="colleges.body_type", evidence=evidence),
        parser_field("level", "college", extractor="colleges.body_type", evidence=evidence),
        parser_field(
            "collegeBody", body.college_body, extractor="colleges.body_type", evidence=evidence
        ),
        parser_field("isCounterpart", False, extractor="colleges.body_type", evidence=evidence),
        # What a JCR / MCR is for, by definition of the body type, not read off the page.
        parser_field(
            "audiences", audiences, extractor="colleges.body_audience", evidence=evidence,
            inferred=True,
        ),
    ]  # fmt: skip
    if body.short_name:
        fields.append(
            parser_field("shortName", body.short_name, extractor="colleges.seed", evidence=evidence)
        )
    return fields


def _contact_fields(reading: PageReading, extractor: str, evidence: str) -> list:
    fields = []
    contacts = reading.contacts
    if contacts.email:
        fields.append(
            parser_field("email", contacts.email, extractor=f"{extractor}.email", evidence=evidence)
        )
    if contacts.role_emails:
        fields.append(
            parser_field(
                "roleEmails",
                contacts.role_emails,
                extractor=f"{extractor}.role_emails",
                evidence=evidence,
            )
        )
    if reading.obfuscated and not contacts.email and not contacts.role_emails:
        # The page hides its addresses from automated readers; never decoded (§8).
        for name in ("email", "roleEmails"):
            fields.append(
                missing_field(
                    name,
                    "access_restricted",
                    extractor=f"{extractor}.obfuscated",
                    evidence=evidence,
                )
            )
    if reading.socials:
        fields.append(
            parser_field(
                "socials", reading.socials, extractor=f"{extractor}.socials", evidence=evidence
            )
        )
    return fields


def _observation(
    body: Body,
    result: FetchResult,
    client: PoliteClient,
    fields: list,
    *,
    source_type: str = "society_website",
    website: str | None = None,
    socials: list[dict[str, str]] | None = None,
) -> Observation:
    identity = body_identity(body, website)
    identity.instagram_handle = instagram_handle(socials)
    internal: dict[str, object] = {}
    if identity.instagram_handle:
        internal["instagram_handle"] = identity.instagram_handle
    if website:
        internal["website_domain"] = host_of(website)
    # Only a page we read can be evidence of the body's college; a failed
    # fetch says nothing but "this URL failed".
    return Observation(
        source_type=source_type,
        source_key=result.url,
        source_url=result.final_url if result.ok else result.url,
        retrieved_at=retrieved_at(result),
        content_sha256=result.content_sha256,
        fetch=fetch_info(client, result),
        entity_type="organisation",
        identity=identity,
        parent=college_identity(body.college) if result.ok else None,
        relationships=college_relationships(body.college, result.final_url, parent=True)
        if result.ok
        else [],
        internal=internal,
        fields=fields,
    )


def _name_fields(body: Body, named: str | None, extractor: str, evidence: str) -> list:
    if named is None:
        return []
    fields = [
        parser_field(
            "name", body.name, extractor=extractor, evidence=evidence, inferred=named == "short"
        )
    ]
    if body.aliases:
        fields.append(
            parser_field(
                "aliases", list(body.aliases), extractor="colleges.seed", evidence=evidence
            )
        )
    return fields


def harvest_body(
    client: PoliteClient, body: Body, college_host: str | None = None
) -> tuple[list[Observation], list[str]]:
    """Observations of one body: its evidence page (when separate) and its
    home page. ``college_host``: the host of the college's own website."""
    observations: list[Observation] = []
    notes: list[str] = []
    label = f"{body.college} / {body.name}"

    if body.evidence:
        result = client.fetch(body.evidence)
        if result.ok:
            scope = "main" if body.dedicated else "labelled"
            reading = read_body_page(
                result.text, result.final_url, body, scope=scope, college_host=college_host
            )
            if reading.named is None:
                notes.append(f"{label}: evidence page no longer names the body")
            else:
                fields = [
                    *_name_fields(body, reading.named, "colleges.evidence_name", "secondary"),
                    *_classification(body, "secondary"),
                    *_contact_fields(reading, "colleges.evidence", "secondary"),
                ]
                observations.append(
                    _observation(body, result, client, fields, socials=reading.socials)
                )
        else:
            notes.append(f"{label}: evidence page {result.outcome}")

    if body.home:
        result = client.fetch(body.home)
        if result.ok:
            reading = read_body_page(
                result.text, result.final_url, body, scope="all", college_host=college_host
            )
            script_app = reading.text_length < _SCRIPT_APP_TEXT and bool(observations)
            if reading.named or script_app:
                website = clean_url(result.final_url)
                evidence = "primary" if reading.named else "secondary"
                fields = [
                    *_name_fields(body, reading.named, "colleges.home_name", "primary"),
                    parser_field("website", website, extractor="colleges.home", evidence=evidence),
                    *_classification(body, evidence),
                    *_contact_fields(reading, "colleges.home", evidence),
                ]
                observations.append(
                    _observation(
                        body, result, client, fields, website=website, socials=reading.socials
                    )
                )
            else:
                notes.append(
                    f"{label}: {result.final_url} answers but does not name the body "
                    "(lapsed or reused domain?) — no website claimed"
                )
        else:
            reason = missing_reason(result)
            fields = [
                missing_field("website", reason, extractor="colleges.home", evidence="primary")
            ]
            observations.append(_observation(body, result, client, fields))
            notes.append(f"{label}: home {result.outcome} → website missing ({reason})")
    return observations, notes


def harvest(client: PoliteClient, limit: int | None = None) -> Harvest:
    """The college A–Z, then every body in `BODIES` (``limit`` caps the bodies)."""
    out = Harvest()
    az = client.fetch(COLLEGE_AZ_URL)
    out.fetched += 1
    observations, notes = college_observations(az, client)
    out.add(observations)
    out.notes.extend(notes)
    if not az.ok:
        out.failed += 1
    college_hosts = {
        entry.name: host_of(entry.website)
        for entry in (parse_college_az(az.text, az.final_url) if az.ok else [])
        if entry.website
    }
    bodies = BODIES if limit is None else BODIES[:limit]
    for body in bodies:
        observations, notes = harvest_body(client, body, college_hosts.get(body.college))
        out.add(observations)
        out.notes.extend(notes)
        out.fetched += 1
        if not observations:
            out.failed += 1
    named = {o.identity.name for o in out.observations if o.identity.org_type in ("jcr", "mcr")}
    out.notes.append(f"{len(named)} of {len(bodies)} JCR/MCR bodies observed")
    return out


__all__ = [
    "BODIES",
    "COLLEGES",
    "COLLEGE_AZ_URL",
    "Body",
    "CollegeEntry",
    "body_tokens",
    "canonical_college",
    "college_identity",
    "college_in_name",
    "college_observations",
    "college_relationships",
    "harvest",
    "harvest_body",
    "names_body",
    "parse_college_az",
    "read_body_page",
]
