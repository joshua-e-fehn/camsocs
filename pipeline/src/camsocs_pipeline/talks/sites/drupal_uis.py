"""University Drupal event listings (source kind ``drupal_uis``, source type
``dept_drupal``). Most departments and centres run one of the University
Information Services' Drupal platforms, and their listings come in four
shapes, tried in this order on each page:

1. **UIS ``cambridge_tailwind`` cards** (Drupal 10/11, the "Cambridge Web
   Platform"; ``/events``): an ``a.card-link`` per event whose heading
   (``data-testid="card-heading"``) is the title and whose subheading reads
   "5 November 2026 * 1:00pm to 2:00pm • Part II Lecture Theatre". The card
   gives the date, time and venue; the event's own page (``/events/<slug>``,
   at most `common.DETAIL_CAP` per run) adds schema.org ``Event`` JSON-LD
   (the exact start and end, naive London times) and its prose (the
   abstract, a "Speaker:" line, any talks.cam link).
2. **ucam_talks mirrors** (``div.ucam-talk`` or ``node-ucam-talk``; the
   UIS module that shows a department's talks.cam lists on its own site:
   Chemistry, DAMTP, DPMMS, the Statistical Laboratory). Labelled fields
   Series, Speaker, Time, Venue; the item links ``/talk/<id>``, where the id
   *is* the talks.cam talk id (the module mirrors it), recorded as
   `TalkRecord.talks_cam_id` so dedupe keeps the talks.cam record. No detail
   page is read.
3. **Drupal views rows** (``.views-row`` or ``li.campl-highlight-event-item``
   on Drupal 7–10 sites: Economics, Computer Science's seminar list, the
   Janeway Institute, English, Land Economy): one item per row with a link,
   a machine-readable time (RDFa ``dc:date``, ``<time datetime>``) or a
   written date and time ("Friday, 30 October 2026", "2:00pm – 3:00pm",
   "3 Nov 26 - 10:00"), and fields found by their label or class (title of
   talk, speaker, affiliation, series, venue/location). A row with a date but
   no time has its detail page read (within the cap) for the time.
4. **Article teasers** (``<article>`` nodes listed on a Drupal 8–10 page that
   has no views rows: colleges, PACE, the MRC Biostatistics Unit, Cambridge
   Zero): as rows, but the written date ("05 November 2026, 17:30",
   "9 Nov 19.30 - 20.45") wins over ``<time>``, which on these themes often
   holds only the day or a wrong zone. The page's own node is skipped.

**Pages.** The listing's ``rel="next"`` link, else a link to ``page=N+1``,
is followed up to `common.MAX_PAGES` pages (a note says when the cap stops
the read), stopping when a page adds no new item or lies wholly outside the
window on the side the listing runs towards: past the window's end for a
listing in date order, before its start for one listed newest first (an
archive). A listing whose order is not yet clear is read on.
The UIS theme lists the same event twice on some pages (AMES); items
are de-duplicated by URL.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from functools import partial
from itertools import pairwise
from urllib.parse import parse_qs, urlsplit

from selectolax.lexbor import LexborHTMLParser, LexborNode

from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.talks.sites import jsonld
from camsocs_pipeline.talks.sites.common import (
    MAX_PAGES,
    UCAM_TALK_PATH,
    ParsedTalk,
    SiteContext,
    canonical,
    london_day,
    mirrored_talks_cam_id,
    parse_when,
    retrieved_at,
    says_empty,
    single_line,
    speakers_from,
    talks_cam_id,
)

SOURCE_TYPE = "dept_drupal"

#: A "title of talk" field that names no title yet.
_NO_TITLE = frozenset(
    {"tbc", "tba", "tbd", "to be confirmed", "title tbc", "title to be confirmed"}
)


# --- shape 1: cambridge_tailwind cards ----------------------------------------------------


def _subheading_parts(node: LexborNode) -> tuple[str, str | None]:
    """A card subheading: the date line, then (after the dot icon) the venue."""
    for svg in node.css("svg"):
        svg.replace_with(" • ")  # type: ignore[arg-type]
    text = " ".join((node.text(separator=" ") or "").split())
    when, _, venue = text.partition(" • ")
    return when.strip(), (venue.strip(" .") or None)


def tailwind_cards(html: str, base: str, today: date | None) -> list[ParsedTalk]:
    tree = LexborHTMLParser(html)
    items: list[ParsedTalk] = []
    for card in tree.css("a.card-link"):
        href = card.attributes.get("href") or ""
        heading = card.css_first('[data-testid="card-heading"]')
        sub = card.css_first('[data-testid="card-subheading"]')
        if not href or heading is None:
            continue
        when_text, venue = _subheading_parts(sub) if sub is not None else ("", None)
        when = parse_when(when_text, today=today)
        url = canonical(href, base)
        title = single_line(heading.text()) or ""
        if when is None:
            items.append(_undated(url, base, title, venue))
            continue
        start, end, all_day = when
        items.append(
            ParsedTalk(
                external_id=url,
                url=url,
                source_url=base,
                title=title,
                starts_at=start,
                ends_at=end,
                all_day=all_day,
                venue=venue,
            )
        )
    return items


def _undated(url: str, base: str, title: str, venue: str | None) -> ParsedTalk:
    """A card whose date could not be read: its detail page must give one."""
    item = ParsedTalk(
        external_id=url, url=url, source_url=base, title=title, starts_at=datetime.min
    )
    item.venue = venue
    return item


# --- shape 2: ucam_talks mirrors ------------------------------------------------------------


def ucam_talks(html: str, base: str, today: date | None) -> list[ParsedTalk]:
    tree = LexborHTMLParser(html)
    items: list[ParsedTalk] = []
    for node in tree.css("div.ucam-talk, div.node-ucam-talk"):
        link = next(
            (
                a
                for a in node.css("a[href]")
                if UCAM_TALK_PATH.match(urlsplit(a.attributes.get("href") or "").path)
            ),
            None,
        )
        if link is None:
            continue
        href = link.attributes.get("href") or ""
        talk_id = int(UCAM_TALK_PATH.match(urlsplit(href).path).group(1))  # type: ignore[union-attr]
        fields = jsonld.labelled_fields(node)
        when = _row_when(node, fields.get("time"), today)
        if when is None:
            continue
        start, end, all_day = when
        url = canonical(href, base)
        title = (single_line(link.text()) or "").strip('"“”')
        items.append(
            ParsedTalk(
                external_id=url,
                url=url,
                source_url=base,
                title=title,
                starts_at=start,
                ends_at=end,
                all_day=all_day,
                speakers=speakers_from(fields.get("speaker") or fields.get("speakers")),
                series=fields.get("series"),
                venue=fields.get("venue"),
                talks_cam_id=talk_id,
            )
        )
    return items


# --- shape 3: views rows --------------------------------------------------------------------


def _row_when(
    node: LexborNode, text: str | None, today: date | None
) -> tuple[datetime, datetime | None, bool] | None:
    """A row's time: machine-readable first (RDFa, ``<time>``), then words."""
    times = jsonld.machine_times(node.html or "")
    if times is not None:
        return times
    return parse_when(text, today=today) if text else None


def _class_field(node: LexborNode, *needles: str) -> str | None:
    for field in node.css("[class]"):
        classes = field.attributes.get("class") or ""
        if not any(f"field-{n}" in classes or f"field--name-field-{n}" in classes for n in needles):
            continue
        value = field.css_first(".field-content, .field__item, .field-items") or field
        for label in value.css(".views-label, .field-label, .field__label"):
            label.decompose()
        text = single_line(value.text(separator=" "))
        if text:
            return text
    return None


def _row_link(node: LexborNode, base: str) -> LexborNode | None:
    host = urlsplit(base).netloc.lower()
    for selector in (
        "h2 a[href]",
        "h3 a[href]",
        ".views-field-title a[href]",
        ".campl-highlight-event-link a[href]",
        "a[href]",
    ):
        for anchor in node.css(selector):
            href = anchor.attributes.get("href") or ""
            url = canonical(href, base)
            if urlsplit(url).netloc.lower() == host and urlsplit(url).path not in ("", "/"):
                return anchor
    if node.tag == "a" and node.attributes.get("href"):
        return node
    return None


#: Elements whose class marks a type or category label ("Talk", "Seminar").
_LABEL_CLASS = re.compile(
    r"(?:^|[-_ ])(?:type|categor(?:y|ies)|tags?|label|badge|eyebrow)(?:$|[-_ ])"
)

#: An ``<article>`` that is the page itself, not an item listed on it.
_FULL_NODE = re.compile(r"view-mode-full|node-full|node--type-(?:page|land-page|listing-page)\b")


def _article_rows(root: LexborNode, base: str) -> list[LexborNode]:
    listing = urlsplit(canonical(base)).path.rstrip("/")
    rows: list[LexborNode] = []
    for article in root.css("article"):
        if _FULL_NODE.search(article.attributes.get("class") or ""):
            continue
        if len(article.css("article")) > 1:  # the match includes the node itself
            continue  # a wrapper around the listed teasers, not one of them
        anchor = _row_link(article, base)
        href = anchor.attributes.get("href") if anchor is not None else None
        if href and urlsplit(canonical(href, base)).path.rstrip("/") != listing:
            rows.append(article)
    return rows


def views_rows(
    html: str, base: str, today: date | None, *, articles: bool = False
) -> list[ParsedTalk]:
    """Shape 3 (module docstring); with `articles`, shape 4: the
    ``<article>`` teasers of a Drupal 8–10 listing (colleges, PACE, BSU),
    whose written date wins over a ``<time>`` that often carries only the day
    or a wrong zone."""
    tree = LexborHTMLParser(html)
    root = tree.css_first("main") or tree.body
    if root is None:
        return []
    if articles:
        rows = _article_rows(root, base)
    else:
        rows = root.css(".views-row, li.campl-highlight-event-item")
        if not rows:
            rows = [li for li in root.css(".item-list li") if li.css_first("time[datetime]")]
    items: list[ParsedTalk] = []
    for row in rows:
        anchor = _row_link(row, base)
        if anchor is None:
            continue
        url = canonical(anchor.attributes.get("href") or "", base)
        # Spaced: inline fields ("6 November 2026", "Room 2.14", "4pm") never run together.
        row_text = single_line(row.text(separator=" ")) or ""
        when = (parse_when(row_text, today=today) if articles else None) or _row_when(
            row, row_text, today
        )
        link_text = single_line(anchor.text(separator=" ")) or ""
        heading = row.css_first("h2, h3, h4")
        title = single_line(heading.text(separator=" ")) if heading is not None else None
        talk_title = _class_field(row, "talk-title", "seminar-talk-title")
        affiliation = _class_field(
            row, "seminar-speaker-affiliatio", "speaker-affiliatio", "affiliation"
        )
        speaker = _class_field(row, "speaker", "speakers")
        speakers = speakers_from(speaker)
        if talk_title and not speakers:
            name = link_text.split(" - ")[-1] if " - " in link_text else link_text.split("-")[0]
            name = " ".join(re.sub(r"\(.*?\)", "", name).split())
            if name and 1 <= len(name.split()) <= 5:
                speakers = [{"name": name, **({"affiliation": affiliation} if affiliation else {})}]
        elif affiliation and len(speakers) == 1 and "affiliation" not in speakers[0]:
            speakers[0]["affiliation"] = affiliation
        venue = _class_field(row, "venue", "location", "event-location")
        if venue is None:
            venue = _parenthesised_venue(row)
        if talk_title and talk_title.strip(" .").lower() in _NO_TITLE:
            talk_title = None
        item_title = talk_title or title or link_text
        labels = [
            text
            for node in row.css("[class]")
            if _LABEL_CLASS.search(node.attributes.get("class") or "")
            and (text := single_line(node.text(separator=" ")))
            and len(text) <= 40
        ]
        if when is None:
            items.append(_undated(url, base, item_title, venue))
        else:
            start, end, all_day = when
            items.append(
                ParsedTalk(
                    external_id=url,
                    url=url,
                    source_url=base,
                    title=item_title,
                    starts_at=start,
                    ends_at=end,
                    all_day=all_day,
                    speakers=speakers,
                    series=_class_field(row, "seminar-series", "series", "talk-series"),
                    categories=labels,
                    venue=venue,
                    talks_cam_id=mirrored_talks_cam_id(url) or talks_cam_id(row.html),
                )
            )
    return items


def _parenthesised_venue(row: LexborNode) -> str | None:
    """ "1:00pm - 2:00pm (Meade Room)": the room after a time range."""
    for node in row.css("time"):
        parent = node.parent
        if parent is None:
            continue
        match = re.search(r"\(([^()]{3,120})\)\s*$", parent.text(separator=" ") or "")
        if match:
            return match.group(1).strip()
    return None


# --- pages ------------------------------------------------------------------------------------


def parse_listing(html: str, base: str, today: date | None) -> tuple[str, list[ParsedTalk]]:
    """``(shape, items)`` of one listing page."""
    for shape, parser in (
        ("tailwind", tailwind_cards),
        ("ucam_talks", ucam_talks),
        ("views", views_rows),
        ("articles", partial(views_rows, articles=True)),
    ):
        items = parser(html, base, today)
        if items:
            return shape, items
    return "none", []


def next_page(html: str, base: str, page: int) -> str | None:
    """The next listing page: ``rel="next"``, else a ``page=<page+1>`` link."""
    tree = LexborHTMLParser(html)
    for anchor in tree.css('a[rel="next"][href], link[rel="next"][href]'):
        return canonical(anchor.attributes.get("href") or "", base)
    for anchor in tree.css("a[href]"):
        href = anchor.attributes.get("href") or ""
        if "page=" not in href:
            continue
        values = parse_qs(urlsplit(canonical(href, base)).query).get("page", [])
        if values == [str(page + 1)]:
            return canonical(href, base)
    return None


def _direction(starts: list[datetime]) -> int:
    """+1 when a listing runs oldest first, -1 newest first, 0 unsure: the
    steps between the starts seen so far, in listing order."""
    up = sum(1 for a, b in pairwise(starts) if b > a)
    down = sum(1 for a, b in pairwise(starts) if b < a)
    return (up > down) - (down > up)


def collect(ctx: SiteContext) -> None:
    url: str | None = ctx.source.url
    seen: set[str] = set()
    starts: list[datetime] = []
    for page in range(MAX_PAGES):
        if url is None:
            break
        result = ctx.get(url)
        base = result.final_url or url
        shape, items = parse_listing(result.text, base, london_day(retrieved_at(result)))
        fresh = [i for i in items if i.external_id not in seen]
        if not fresh:
            if page == 0:
                ctx.read.says_empty = says_empty(result.text)
            break
        ctx.read.shape = ctx.read.shape or shape
        for item in fresh:
            seen.add(item.external_id)
            _finish(ctx, shape, item, result)
        dated = [i for i in fresh if i.starts_at != datetime.min]
        starts += [i.starts_at for i in dated]
        if dated and not any(ctx.window.overlaps(i.starts_at, i.ends_at) for i in dated):
            # A page wholly outside the window ends the listing only on the
            # side it runs towards: past the end when it runs oldest first,
            # before the start when newest first (an archive). Unsure: read on.
            after = all(i.starts_at >= ctx.window.end for i in dated)
            direction = _direction(starts)
            if (after and direction > 0) or (not after and direction < 0):
                break
        url = next_page(result.text, base, page)
    else:
        if url is not None:
            ctx.read.notes.append(f"page cap reached: {MAX_PAGES} listing pages read")


def _finish(ctx: SiteContext, shape: str, item: ParsedTalk, listing: FetchResult) -> None:
    """Reads the detail page where the shape needs it, then keeps the item."""
    undated = item.starts_at == datetime.min
    if not ctx.looks_like_a_talk(item):
        ctx.read.drop("not a talk")
        return
    needs_detail = shape == "tailwind" or undated or (shape != "ucam_talks" and item.all_day)
    if needs_detail and (undated or ctx.window.overlaps(item.starts_at, item.ends_at)):
        page = ctx.detail(item.url)
        if page is not None:
            jsonld.merge(item, jsonld.read_detail(page.text, item.url))
    if item.starts_at == datetime.min:
        ctx.read.drop("no date")
        return
    ctx.keep(item, listing)
