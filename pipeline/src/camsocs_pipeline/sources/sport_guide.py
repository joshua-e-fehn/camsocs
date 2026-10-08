"""The Sports Club Guide 2026-27 PDF (source-research §4).

Read deterministically with pypdf, in two steps:

1. `pdf_layout` turns each page into positioned text **chunks** (font, size,
   x, y — pypdf's ``visitor_text``) and positioned **glyph runs** (every
   ``Tj``/``TJ`` with the font it was drawn in — ``visitor_operand_before``).
   Everything after that is pure and unit-tested on synthetic layouts.
2. Two parsers read the layout:

   - `parse_sections`: each club section of the "Sports Club A-Z" pages — a
     heading in the heavy face, the description in the light face below it,
     then links and "contact:" lines. → description, website, social links,
     contact addresses (published as the club's contact, so a Gmail address
     counts; personal CRSids never do).
   - `parse_glance`: the "Sports Clubs at a Glance" table. Its ticks are
     Webdings glyphs, so the text layer reads only "a a a" — which column each
     tick sits in is lost (§4's trap). The glyph positions are not: every tick
     is its own ``Tj`` at an exact x, the seven columns are 34 pt apart, and
     each tick shares its row's baseline. The column headings are checked
     before any tick is read, and if the ticks do not fall into exactly seven
     evenly spaced columns the table is skipped and the run says so — no
     guessing, and no LLM is needed (the vision fallback §4 suggested would
     only ever be ``inferred``; these readings are verifiable, so ``found``).

     Columns → fields: Students → audiences undergraduates + postgraduates;
     Staff → staff; Beginner → audiences beginners and ``beginnerFriendly``;
     Blue, Half Blue → no tick is ``sport.blueStatus`` none (a tick says *some*
     Blue status without saying which: missing / ``not_published``); College
     Competition → ``sport.collegeCompetition``. An empty cell is a published
     "no". Intermediate and Elite have no field.

Table rows are matched to sections by name (`match_names`); a row that fits no
section, or more than one, is staged on its own. Each club becomes one
observation of the PDF (``sport_guide_pdf``). Its identity carries the
Instagram handle and website domain, and — when the latest Sport A–Z harvest
has a club page with the same Instagram handle or a matching name — that
club's ``sport_slug``, so the resolver can join the two. The guide never claims
``name`` (its headings are sports, "Archery (Bowmen)", not club names), so a
section that matches no club creates nothing.

The PDF is linked from the A–Z on the hosting platform's domain, whose
robots.txt disallows all crawlers; the same file on the canonical
``www.sport.cam.ac.uk`` (allowed) is fetched instead (`sport.canonical_url`).
"""

from __future__ import annotations

import io
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise

import pypdf

from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.models.observation import FieldObs, IdentityHints, Observation
from camsocs_pipeline.sources import sport
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.contact_links import (
    bare_urls,
    clean_url,
    dedupe_socials,
    find_emails,
    host_of,
    instagram_from_handle,
    instagram_handle,
    is_social_host,
    read_contacts,
    social_link,
)
from camsocs_pipeline.sources.observe import Harvest, fetch_info, retrieved_at
from camsocs_pipeline.sources.sport import gender_of, without_gender

# --- layout ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    """A run of text as pypdf reports it, in content-stream order."""

    x: float
    y: float
    size: float
    font: str
    text: str


@dataclass(frozen=True)
class Glyph:
    """Where one ``Tj``/``TJ`` drew, in which font, and what (the operand's
    raw character codes, so a tick and a space in the same font differ)."""

    x: float
    y: float
    font: str
    code: str = ""


@dataclass
class PageLayout:
    number: int  # 1-based
    chunks: list[Chunk] = field(default_factory=list)
    glyphs: list[Glyph] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(chunk.text for chunk in self.chunks)


def _apply(tm: Sequence[float], cm: Sequence[float]) -> tuple[float, float]:
    x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
    y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
    return x, y


def _base_font(fontdict: object) -> str:
    try:
        name = str(fontdict.get("/BaseFont", ""))  # type: ignore[union-attr]
    except AttributeError:
        return ""
    return name.split("+", 1)[-1].lstrip("/")


def pdf_layout(data: bytes) -> list[PageLayout]:
    """Every page's positioned chunks and glyph runs."""
    reader = pypdf.PdfReader(io.BytesIO(data))
    pages: list[PageLayout] = []
    for number, page in enumerate(reader.pages, start=1):
        layout = PageLayout(number)
        fonts: dict[str, str] = {}
        try:
            resources = page["/Resources"]["/Font"]
            for key, ref in resources.items():
                fonts[str(key)] = _base_font(ref.get_object())
        except (KeyError, TypeError):
            pass
        current = {"font": ""}

        def before(op: bytes, args: list, cm, tm, layout=layout, fonts=fonts, current=current):
            if op == b"Tf" and args:
                current["font"] = fonts.get(str(args[0]), str(args[0]))
            elif op in (b"Tj", b"TJ", b"'", b'"'):
                x, y = _apply(tm, cm)
                code = repr(args[-1]) if args else ""
                layout.glyphs.append(Glyph(round(x, 2), round(y, 2), current["font"], code))

        def text(chars: str, cm, tm, fontdict, size, layout=layout):
            if not chars.strip():
                return
            x, y = _apply(tm, cm)
            layout.chunks.append(
                Chunk(
                    round(x, 2),
                    round(y, 2),
                    round(abs(size * tm[0] * cm[0]), 2),
                    _base_font(fontdict),
                    chars,
                )
            )

        page.extract_text(visitor_operand_before=before, visitor_text=text)
        pages.append(layout)
    return pages


# --- names -------------------------------------------------------------------------------

_STOP = frozenset(
    {"club", "clubs", "society", "association", "team", "the", "and", "of", "cu", "university"}
)


def _stem(token: str) -> str:
    if token.endswith("ing") and len(token) > 5:
        token = token[:-3]
    if token.endswith("s") and len(token) > 4:
        token = token[:-1]
    return token


def match_tokens(label: str) -> frozenset[str]:
    """Stemmed name words without the gender and filler words, for matching
    one source's names against another's ("Athletic" ≈ "Athletics")."""
    text = without_gender(label).lower().replace("&", " and ")
    text = re.sub(r"rock\s*'?\s*n\s*'?\s*roll", "rocknroll", re.sub("[‘’]", "'", text))
    tokens = re.findall(r"[a-z0-9]+", text.replace("'", ""))
    return frozenset(_stem(t) for t in tokens if t not in _STOP)


def match_names(label: str, candidates: Sequence[str]) -> list[int]:
    """Indexes of the candidates `label` names: one token set inside the other,
    genders compatible, best overlap. Several only when they differ by gender
    alone ("Cricket" → "Cricket (Men)" and "Cricket (Women)"); none when the
    best is a tie between different names."""
    tokens, gender = match_tokens(label), gender_of(label)
    if not tokens:
        return []
    scored: list[tuple[float, int]] = []
    for index, candidate in enumerate(candidates):
        other, other_gender = match_tokens(candidate), gender_of(candidate)
        if not other or (gender and other_gender and gender != other_gender):
            continue
        if tokens <= other or other <= tokens:
            scored.append((len(tokens & other) / len(tokens | other), index))
    if not scored:
        return []
    best = max(score for score, _ in scored)
    winners = [index for score, index in scored if score == best]
    if len(winners) > 1 and len({match_tokens(candidates[i]) for i in winners}) > 1:
        return []
    return winners


# --- sections ----------------------------------------------------------------------------

_HEADING_FONT = re.compile(r"(-Hv|Heavy|Black)", re.I)
_SIDE_TAB = re.compile(r"\S\s+•\s+\S")
_FURNITURE = re.compile(r"^(university of cambridge\s+sports guide|sports club a-z|\d{1,3})$", re.I)
#: Body text is set at 7–8 pt; links and contact lines at 9–10 pt.
_BODY_TEXT_MAX_SIZE = 9.0
_INSTAGRAM_HANDLE = re.compile(
    r"instagram(?:\.com)?\s*(?:/\s*tiktok)?\s*:\s*@?([A-Za-z0-9_.]{2,30})", re.I
)
_LIGHT_FONT = re.compile(r"(-Lt|Light)", re.I)


@dataclass
class Section:
    heading: str
    page: int
    description: str | None = None
    website: str | None = None
    socials: list[dict[str, str]] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)


def _is_side_tab(chunk: Chunk) -> bool:
    """The rotated tab listing a page's clubs ("Aikido • American Football")."""
    return chunk.size < 1 and bool(_SIDE_TAB.search(chunk.text))


def _club_pages(pages: Sequence[PageLayout]) -> list[PageLayout]:
    """The A–Z run: from the first to the last page with a side tab (a page
    in between may lack its tab; the pages after it are about college sport)."""
    tabbed = [page.number for page in pages if any(_is_side_tab(c) for c in page.chunks)]
    if not tabbed:
        return []
    return [page for page in pages if tabbed[0] <= page.number <= tabbed[-1]]


def _is_link_line(chunk: Chunk, text: str) -> bool:
    """Links and contacts are set in the regular face; a line made of links
    counts as one whatever its face."""
    if not _LIGHT_FONT.search(chunk.font) or text.lower().startswith("contact") or "@" in text:
        return True
    linked = sum(len(token) for token in bare_urls(text))
    return linked >= 0.6 * len(text.replace(" ", ""))


def _join_lines(lines: Iterable[str]) -> str:
    out = ""
    for line in (line.strip() for line in lines):
        if not line:
            continue
        if out.endswith("-") and line[:1].islower() and out[-2:-1].isalpha():
            out += line
        else:
            out = f"{out} {line}" if out else line
    return re.sub(r"\s+", " ", out).strip()


def _read_links(section: Section) -> None:
    text = " \n".join(section.lines)
    section.emails = find_emails(text)
    socials: list[dict[str, str]] = []
    for handle in _INSTAGRAM_HANDLE.findall(text):
        entry = instagram_from_handle(handle)
        if entry:
            socials.append(entry)
    text_without_emails = text
    for address in section.emails:
        text_without_emails = text_without_emails.replace(address, " ")
    for token in bare_urls(text_without_emails):
        entry = social_link(token)
        if entry is not None:
            socials.append(entry)
        elif section.website is None and not is_social_host(token):
            section.website = clean_url(token)
    section.socials = dedupe_socials(socials)


def parse_sections(pages: Sequence[PageLayout]) -> list[Section]:
    """Every club section on the A–Z pages, in page order."""
    sections: list[Section] = []
    for page in _club_pages(pages):
        current: Section | None = None
        description: list[str] = []
        heading_y: float | None = None
        for chunk in page.chunks:
            text = chunk.text.strip()
            if _is_side_tab(chunk) or _FURNITURE.match(text) or chunk.size < 1:
                heading_y = None
                continue
            if heading_y is not None and current is not None and abs(chunk.y - heading_y) < 1.0:
                # The rest of the heading's line, often in another face: "Cricket" + " (Men)".
                current.heading = f"{current.heading} {text}"
                continue
            if _HEADING_FONT.search(chunk.font) and chunk.size >= _BODY_TEXT_MAX_SIZE:
                if current is not None:
                    current.description = _join_lines(description) or None
                    sections.append(current)
                current, description, heading_y = Section(text, page.number), [], chunk.y
                continue
            heading_y = None
            if current is None:
                continue
            if _is_link_line(chunk, text):
                current.lines.append(text)
            else:
                description.append(text)
        if current is not None:
            current.description = _join_lines(description) or None
            sections.append(current)
    for section in sections:
        section.heading = re.sub(r"\s+", " ", section.heading).replace("( ", "(").strip()
        _read_links(section)
    return sections


# --- the "at a glance" table --------------------------------------------------------------

#: Column order on the page (checked against the headings before reading ticks).
GLANCE_COLUMNS = (
    "students",
    "staff",
    "beginner",
    "intermediate",
    "elite",
    "blue",
    "college_competition",
)
_GLANCE_HEADINGS = ("Students", "Staff", "Beginner", "Intermediate", "Elite", "Blue", "College")
_TICK_FONT = re.compile(r"(webdings|wingdings|dingbats)", re.I)
_ROW_LABEL_MAX_X = 160.0
_ROW_TOLERANCE = 6.0
_COLUMN_TOLERANCE = 3.0


@dataclass(frozen=True)
class GlanceRow:
    label: str
    page: int
    columns: frozenset[str]


@dataclass
class Glance:
    rows: list[GlanceRow] = field(default_factory=list)
    #: Rows whose ticks did not cross-check with the text layer: not claimed.
    skipped: list[str] = field(default_factory=list)
    problem: str | None = None


def _cluster(values: Iterable[float], tolerance: float) -> list[float]:
    centres: list[list[float]] = []
    for value in sorted(values):
        if centres and value - centres[-1][-1] <= tolerance:
            centres[-1].append(value)
        else:
            centres.append([value])
    return [sum(group) / len(group) for group in centres]


def _ticks(page: PageLayout) -> list[Glyph]:
    """The tick glyphs: the symbol-font draws with the table's most common
    code (the same font also draws spaces, which are not ticks)."""
    symbols = [glyph for glyph in page.glyphs if _TICK_FONT.search(glyph.font)]
    if not symbols:
        return []
    tick = Counter(glyph.code for glyph in symbols).most_common(1)[0][0]
    return [glyph for glyph in symbols if glyph.code == tick]


def _columns(ticks: Sequence[Glyph], page: PageLayout) -> list[float] | str:
    """The x of each of the seven tick columns on one page (the table sits at
    a different offset on facing pages), or what is wrong with them."""
    if not ticks:
        return f"page {page.number}: no tick glyphs"
    columns = _cluster((tick.x for tick in ticks), _COLUMN_TOLERANCE)
    gaps = [b - a for a, b in pairwise(columns)]
    if len(columns) != len(GLANCE_COLUMNS) or (max(gaps) - min(gaps)) > _COLUMN_TOLERANCE:
        return f"page {page.number}: ticks fall into {len(columns)} uneven columns, expected 7"
    return columns


def _text_layer_ticks(page: PageLayout, row_y: float) -> int | None:
    """How many tick characters the text layer shows on a row (the run "a a a"),
    to cross-check the positions read from the drawing operations."""
    runs = [
        chunk
        for chunk in page.chunks
        if _TICK_FONT.search(chunk.font) and abs(chunk.y - row_y) <= _ROW_TOLERANCE
    ]
    if not runs:
        return None
    return sum(len(chunk.text.replace(" ", "")) for chunk in runs)


def _row_labels(page: PageLayout) -> dict[float, str]:
    """Row label by baseline: the left-hand chunks, joined when one label is
    set in two faces ("Dance Society" + " (Dance Competition Team)")."""
    labels: dict[float, list[Chunk]] = {}
    for chunk in page.chunks:
        text = chunk.text.strip()
        if chunk.x >= _ROW_LABEL_MAX_X or not text:
            continue
        if "at a glance" in text.lower() or _FURNITURE.match(text):
            continue
        row_y = next((y for y in labels if abs(y - chunk.y) < 1.0), chunk.y)
        labels.setdefault(row_y, []).append(chunk)
    return {
        y: re.sub(r"\s+", " ", "".join(c.text for c in sorted(group, key=lambda c: c.x))).strip()
        for y, group in labels.items()
    }


def parse_glance(pages: Sequence[PageLayout]) -> Glance:
    """The at-a-glance rows with their ticked columns, or a stated problem."""
    glance_pages = [p for p in pages if "clubs at a glance" in p.text.lower()]
    if not glance_pages:
        return Glance(problem="no 'at a glance' page found")
    for page in glance_pages:
        absent = [h for h in _GLANCE_HEADINGS if h.lower() not in page.text.lower()]
        if absent:
            return Glance(
                problem=f"page {page.number}: column headings changed (no {', '.join(absent)})"
            )
    glance = Glance()
    for page in glance_pages:
        ticks = _ticks(page)
        columns = _columns(ticks, page)
        if isinstance(columns, str):
            return Glance(problem=columns)
        rows = _row_labels(page)
        ticked: dict[float, list[str]] = {y: [] for y in rows}
        tick_y: dict[float, float] = {}
        for glyph in ticks:
            row_y = min(rows, key=lambda y: abs(y - glyph.y), default=None)
            if row_y is None or abs(row_y - glyph.y) > _ROW_TOLERANCE:
                continue
            column = min(range(len(columns)), key=lambda i: abs(columns[i] - glyph.x))
            ticked[row_y].append(GLANCE_COLUMNS[column])
            tick_y[row_y] = glyph.y
        for y in sorted(rows, reverse=True):
            if not ticked[y]:
                continue
            expected = _text_layer_ticks(page, tick_y[y])
            if expected is not None and expected != len(ticked[y]):
                glance.skipped.append(
                    f"{rows[y]} (drawn {len(ticked[y])} ticks, text layer {expected})"
                )
                continue
            glance.rows.append(GlanceRow(rows[y], page.number, frozenset(ticked[y])))
    return glance


def glance_fields(rows: Sequence[GlanceRow]) -> list[FieldObs]:
    """Claims from one club's row(s) (several when split by gender)."""
    ticked = set().union(*(row.columns for row in rows))
    audiences: list[str] = []
    if "students" in ticked:
        audiences += ["undergraduates", "postgraduates"]
    if "staff" in ticked:
        audiences.append("staff")
    if "beginner" in ticked:
        audiences.append("beginners")
    extractor = "sport_guide.glance"
    fields = [
        parser_field("audiences", audiences, extractor=extractor, evidence="secondary"),
        parser_field(
            "beginnerFriendly", "beginner" in ticked, extractor=extractor, evidence="secondary"
        ),
        parser_field(
            "sport.collegeCompetition",
            "college_competition" in ticked,
            extractor=extractor,
            evidence="secondary",
        ),
    ]
    if "blue" not in ticked:
        # The Sports Service's own table: no Blue / Half Blue for this sport.
        fields.append(
            parser_field("sport.blueStatus", "none", extractor=extractor, evidence="primary")
        )
    else:
        # Some Blue status, the table does not say which: the level is not
        # published — which also retracts an earlier "none" from this table.
        fields.append(
            missing_field(
                "sport.blueStatus", "not_published", extractor=extractor, evidence="primary"
            )
        )
    genders = sorted({g for g in (gender_of(row.label) for row in rows) if g})
    if genders:
        fields.append(
            parser_field(
                "sport.genderCategories", genders, extractor=extractor, evidence="secondary"
            )
        )
    return fields


# --- observations ------------------------------------------------------------------------


def section_fields(section: Section) -> list[FieldObs]:
    extractor = "sport_guide.section"
    fields = [
        parser_field("description", section.description, extractor=extractor, evidence="secondary"),
        parser_field("socials", section.socials, extractor=extractor, evidence="secondary"),
    ]
    if section.website:
        fields.append(
            parser_field("website", section.website, extractor=extractor, evidence="secondary")
        )
    contacts = read_contacts(section.emails, labelled=True)
    if contacts.email:
        fields.append(
            parser_field(
                "email", contacts.email, extractor=f"{extractor}.contact", evidence="secondary"
            )
        )
    if contacts.role_emails:
        fields.append(
            parser_field(
                "roleEmails",
                contacts.role_emails,
                extractor=f"{extractor}.contact",
                evidence="secondary",
            )
        )
    return fields


@dataclass(frozen=True)
class KnownClub:
    """A Sport A–Z club, for linking guide entries to it (`sport_slug`)."""

    slug: str
    names: tuple[str, ...]
    instagram: str | None = None


def link_club(heading: str, handle: str | None, clubs: Sequence[KnownClub]) -> str | None:
    """The A–Z slug a guide entry is about: same Instagram handle, else an
    unambiguous name match."""
    if handle:
        same = {club.slug for club in clubs if club.instagram and club.instagram == handle.lower()}
        if len(same) == 1:
            return same.pop()
    names = [name for club in clubs for name in club.names]
    owners = [club.slug for club in clubs for _ in club.names]
    slugs = {owners[i] for i in match_names(heading, names)}
    return slugs.pop() if len(slugs) == 1 else None


def assign_rows(
    rows: Sequence[GlanceRow], headings: Sequence[str]
) -> tuple[dict[int, list[GlanceRow]], list[GlanceRow]]:
    """Table rows → section indexes. A section claimed by rows of different
    names (not gender variants of one: "Rowing (Boat Club)" and "Rowing
    (College)") takes none of them; they stay on their own."""
    rows_for: dict[int, list[GlanceRow]] = {}
    standalone: list[GlanceRow] = []
    for row in rows:
        matches = match_names(row.label, headings)
        for index in matches:
            rows_for.setdefault(index, []).append(row)
        if not matches:
            standalone.append(row)
    for index, assigned in list(rows_for.items()):
        if len({match_tokens(row.label) for row in assigned}) > 1:
            del rows_for[index]
            standalone.extend(row for row in assigned if row not in standalone)
    return rows_for, standalone


@dataclass
class _Draft:
    name: str
    fields: list[FieldObs]
    socials: list[dict[str, str]]
    website: str | None
    slug: str | None
    has_glance: bool


def _merge(drafts: Sequence[_Draft]) -> _Draft:
    """Several guide entries about one A–Z club (Swimming and Water Polo, the
    men's and women's cricket pages): one observation, so they do not
    supersede each other. Lists are united, a tick in any row counts, the
    first entry's text wins, and "no Blue status" survives only if every
    entry with a table row says so."""
    first = drafts[0]
    merged: dict[str, FieldObs] = {}
    order: list[str] = []
    blue_rows = sum(1 for d in drafts if d.has_glance)
    blue_none = sum(
        1 for d in drafts for f in d.fields if f.field == "sport.blueStatus" and f.value == "none"
    )
    for draft in drafts:
        for obs in draft.fields:
            if obs.field == "sport.blueStatus" and obs.value == "none" and blue_none < blue_rows:
                continue
            if obs.field not in merged:
                merged[obs.field] = obs.model_copy(deep=True)
                order.append(obs.field)
                continue
            kept = merged[obs.field]
            if isinstance(kept.value, list) and isinstance(obs.value, list):
                seen = {repr(item) for item in kept.value}
                kept.value = kept.value + [i for i in obs.value if repr(i) not in seen]
            elif isinstance(kept.value, bool) and isinstance(obs.value, bool):
                kept.value = kept.value or obs.value
            elif kept.value is None and obs.value is not None:
                merged[obs.field] = obs.model_copy(deep=True)
    socials = dedupe_socials([s for d in drafts for s in d.socials])
    return _Draft(
        first.name,
        [merged[name] for name in order],
        socials,
        first.website or next((d.website for d in drafts if d.website), None),
        first.slug,
        any(d.has_glance for d in drafts),
    )


def build_observations(
    result: FetchResult,
    client: PoliteClient,
    sections: Sequence[Section],
    glance: Glance,
    clubs: Sequence[KnownClub] = (),
) -> tuple[list[Observation], list[str]]:
    notes: list[str] = []
    rows_for, standalone = assign_rows(glance.rows, [s.heading for s in sections])
    if standalone:
        notes.append("glance rows on their own: " + ", ".join(row.label for row in standalone))
    if glance.problem:
        notes.append(f"at-a-glance table skipped: {glance.problem}")
    if glance.skipped:
        notes.append("at-a-glance rows not cross-checked, skipped: " + "; ".join(glance.skipped))

    drafts: list[_Draft] = []
    for index, section in enumerate(sections):
        fields = section_fields(section)
        if index in rows_for:
            fields += glance_fields(rows_for[index])
        slug = link_club(section.heading, instagram_handle(section.socials), clubs)
        drafts.append(
            _Draft(
                section.heading, fields, section.socials, section.website, slug, index in rows_for
            )
        )
    for row in standalone:
        slug = link_club(row.label, None, clubs)
        drafts.append(_Draft(row.label, glance_fields([row]), [], None, slug, True))

    grouped: dict[str, list[_Draft]] = {}
    final: list[_Draft] = []
    for draft in drafts:
        if draft.slug is None:
            final.append(draft)
        else:
            grouped.setdefault(draft.slug, []).append(draft)
    for slug, group in grouped.items():
        if len(group) > 1:
            notes.append(f"{slug}: merged {', '.join(d.name for d in group)}")
        final.append(_merge(group) if len(group) > 1 else group[0])

    info = fetch_info(client, result)
    observations: list[Observation] = []
    for draft in final:
        internal: dict[str, object] = {"sport_slug": draft.slug} if draft.slug else {}
        observations.append(
            Observation(
                source_type="sport_guide_pdf",
                source_key=draft.slug or draft.name,
                source_url=result.final_url,
                retrieved_at=retrieved_at(result),
                content_sha256=result.content_sha256,
                fetch=info,
                entity_type="organisation",
                identity=IdentityHints(
                    name=draft.name,
                    sport_slug=draft.slug,
                    instagram_handle=instagram_handle(draft.socials),
                    website_domain=host_of(draft.website) if draft.website else None,
                ),
                internal=internal,
                fields=draft.fields,
            )
        )
    linked = sum(1 for o in observations if o.identity.sport_slug)
    notes.append(
        f"{len(sections)} club sections, {len(glance.rows)} at-a-glance rows; "
        f"{len(observations)} entries, {linked} linked to an A–Z club"
    )
    return observations, notes


def known_clubs(records: Iterable[object]) -> list[KnownClub]:
    """The A–Z clubs from the latest staged ``sport_club_page`` observations."""
    clubs: dict[str, KnownClub] = {}
    for record in records:
        if not isinstance(record, Observation) or record.identity.sport_slug is None:
            continue
        identity = record.identity
        names = tuple(dict.fromkeys([identity.name, *identity.aliases]))
        clubs[identity.sport_slug] = KnownClub(
            identity.sport_slug, names, (identity.instagram_handle or "").lower() or None
        )
    return list(clubs.values())


def harvest(
    client: PoliteClient, limit: int | None = None, clubs: Sequence[KnownClub] = ()
) -> Harvest:
    out = Harvest()
    az = client.fetch(sport.AZ_URL)
    url = sport.guide_url(az.text, az.final_url) if az.ok else None
    if url is None:
        out.failed += 1
        out.notes.append(f"no guide link on the A–Z ({az.outcome}); nothing staged")
        return out
    pdf = client.fetch(url, accept="application/pdf,*/*;q=0.5")
    out.fetched += 1
    if not pdf.ok or not (pdf.content or b"").startswith(b"%PDF"):
        out.failed += 1
        out.notes.append(f"guide {url}: {pdf.outcome} ({pdf.detail or pdf.status}); nothing staged")
        return out
    layout = pdf_layout(pdf.content or b"")
    sections = parse_sections(layout)
    if limit is not None:
        sections = sections[:limit]
    observations, notes = build_observations(pdf, client, sections, parse_glance(layout), clubs)
    out.add(observations)
    out.notes.extend(notes)
    return out


__all__ = [
    "GLANCE_COLUMNS",
    "Chunk",
    "Glance",
    "GlanceRow",
    "Glyph",
    "KnownClub",
    "PageLayout",
    "Section",
    "assign_rows",
    "build_observations",
    "glance_fields",
    "harvest",
    "known_clubs",
    "link_club",
    "match_names",
    "match_tokens",
    "parse_glance",
    "parse_sections",
    "pdf_layout",
    "section_fields",
]
