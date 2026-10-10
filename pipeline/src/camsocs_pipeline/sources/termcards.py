"""Termcards: a society's term programme as a PDF or image (source-research §21).

`fetch_termcard` fetches a `termcardUrl` through the polite client (robots.txt,
per-host pacing, cache) with a society purpose (`sources/policy.py`, D3: the
society published the card). The URL may be the file itself, or a page that
shows it — then the first linked or embedded PDF/image that looks like a
termcard is followed, one level deep and robots-checked like any other fetch.

- **Cambridge SU** (source-research §1, §21): profile resources are
  ``/file/<id>/<name>/`` links. They are fetched now (D3), but on 2026-10-08
  they redirected to the SU login page, which is never followed: such a card
  is recorded ``access_restricted``. A file under the robots-disallowed
  ``/asset/`` is read under the society override (``robots_override:society``).
- Hosts never fetched for a termcard (`never_fetched`), recorded as skipped
  with the reason before any request: **talks.cam** and tbc.xyz (§6: their
  content never reaches the LLM), and **Instagram, Facebook, LinkedIn**, the
  other networks and Meta's media CDNs (links only; an Instagram feed a site
  embeds is Instagram's content).

A fetched card reaches the vision model only when every host it came from
lets AI read it (§14): `PoliteClient.ai_input_allowed` for the page's and the
file's final URLs (no AI crawler disallowed by name, no
``Content-Signal: ai-input=no``), and no ``noai`` robots meta on a page that
embeds it — or the D3 society override lifts that opt-out
(`TermcardFile.ai_override`), which never happens for talks.cam or tbc.xyz.

`term_hint` reads the term a card is for from its URL or file name
("CUHCS-Michaelmas-Term-Card", "termcard-LT27.pdf").

**Old cards** (`stale_reason`): a card whose URL or link names a term of an
earlier academic year ("lent-2024-term-card", "Easter 2026 Termcard.pdf" in
2026-27) or only earlier years ("2024 Lent.pdf", "speakers_event_2025.jpg"),
or that a dated path (WordPress ``/uploads/2021/04/``, a blog's ``/2021/04/``,
Drupal's ``/files/2024-10/``) dates more than four months before the
academic year began, is not read: it can only hold past events, and the
vision model is the expensive one. A page linking several cards follows the
newest-named first (`_file_links`). Image files are recognised by their
name, by Wix's media paths (``…~mv2.png/v1/fill/…``) and by lazy-loaded
``data-src`` / ``srcset``. `published_on` dates a card by the same path or
its server's ``Last-Modified`` (the vision model's reference date, and a
sign its yearless dates are this year's).

**Cards a page shows** (`page_files`, `card_images`; §14 "Events pages"): the
images and files a society's events page links or embeds, each with its alt
text, title, link text, file name, the headings above it and its displayed
size. `card_images` keeps those that look like a term card or an event
poster — a word for one in the label (term card, the term's name, poster,
flyer, programme, schedule, calendar, events) or a heading above it that
announces a programme — and leaves out logos, icons, sponsor strips,
social-network buttons, anything in the page's navigation, header or footer,
images shown smaller than `MIN_CARD_SIDE` and strips longer than
`MAX_CARD_ASPECT` to one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit, urlunsplit

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.extract.images import vision_image
from camsocs_pipeline.extract.llm import NO_LLM_HOSTS
from camsocs_pipeline.sources.base import FetchResult, PoliteClient
from camsocs_pipeline.sources.links import host_of
from camsocs_pipeline.sources.policy import SOCIETY, FetchPurpose, ai_optout_override
from camsocs_pipeline.sources.websites.page import region_of, robots_directives

#: A termcard changes at most once a term; re-download weekly at most.
FRESH_FOR = timedelta(days=7)
ACCEPT = "application/pdf,image/*;q=0.9,text/html;q=0.5,*/*;q=0.1"
_FILE_SUFFIXES = (".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif")
_TERM_WORDS = re.compile(r"term[\s_-]?card|termcard|programme|program|schedule|poster", re.I)
#: A term's name and its year: "Michaelmas Term 2026", "lent-2027", and the
#: short years cards and files write: "Lent 26'", "easter-25", "lent '23".
_TERM_NAME = re.compile(
    r"(michaelmas|lent|easter)(?:\D{0,12}?(20\d\d)(?!\d)|[\s_'’-]{0,2}(\d\d)(?![\d:.]))?", re.I
)
_TERM_CODE = re.compile(r"(?<![a-z])(mt|lt|et)[\s_-]?(?:20)?(\d\d)(?!\d)", re.I)
_CODES = {"mt": "michaelmas", "lt": "lent", "et": "easter"}
#: A dated path: WordPress ``/uploads/2026/09/…``, a blog's ``/2026/09/…``,
#: Drupal's ``/files/2026-09/…``.
_DATED_PATH = re.compile(r"/(20\d\d)[/-](0[1-9]|1[0-2])/")
#: A year as file names write it ("2024 Lent", "speakers_event_2025"), not
#: four digits inside an id ("a36b2019c…").
_YEAR = re.compile(r"(?<![A-Za-z\d])(20\d\d)(?!\d)")
_HOST = re.compile(r"https?://[^/\s]+", re.I)
#: Wix media: ``static.wixstatic.com/media/…~mv2.png/v1/fill/…``.
_WIX_MEDIA = re.compile(r"~mv2\.(?:png|jpe?g|webp|gif)(?:/|$)")
_WIX_ORIGINAL = re.compile(r"^(.*~mv2\.(?:png|jpe?g|webp|gif))/v1/.*$", re.I)
_WIX_SIZE = re.compile(r"/v1/\w+/w_(\d+),h_(\d+)")
#: WordPress's resized copies: ``card-1024x726.png`` of ``card.png``.
_WP_SIZE = re.compile(r"-(\d{2,4})x(\d{2,4})(\.(?:png|jpe?g|webp|gif))$", re.I)
#: Query parameters that only resize an image (WordPress.com, Squarespace, CDNs).
_SIZING_PARAMS = frozenset(
    {"w", "h", "width", "height", "resize", "fit", "format", "fm", "quality", "q", "auto", "blur"}
    | {"dpr", "crop", "ssl", "zoom", "strip"}
)

#: Hosts a termcard is never fetched from, with the reason the stage records.
NEVER_FETCHED: tuple[tuple[tuple[str, ...], str], ...] = (
    (NO_LLM_HOSTS, "host keeps AI out (source-research §6)"),
    (
        (
            "instagram.com",
            "facebook.com",
            "fb.com",
            "linkedin.com",
            "x.com",
            "twitter.com",
            "tiktok.com",
            "threads.net",
            # Meta's media CDNs: an Instagram feed a site embeds (§17: Meta
            # data only through the official API).
            "cdninstagram.com",
            "fbcdn.net",
        ),
        "a social network: links only",
    ),
)
#: Robots meta directives that keep a page's content from a model.
_NOAI = frozenset({"noai", "noimageai"})
HOST_KEEPS_AI_OUT = "host keeps AI out"
#: The termcard URL is a page that links or embeds no card file: the stage
#: then reads the page's own text (`stages.termcards.page_events`).
NO_CARD_FILE = "a page without a readable termcard file"
NOT_A_CARD_FILE = "not a PDF or image"

#: An image shown smaller than this (its longer side, in pixels) is an icon,
#: an avatar or a thumbnail of something else, not a card to read.
MIN_CARD_SIDE = 300
#: An image this many times wider than high (or higher than wide) is a strip:
#: a sponsors' banner, a divider.
MAX_CARD_ASPECT = 4.0
#: Words in a file's label that say it is a term card or an event poster.
_CARD_WORDS = re.compile(
    r"(?<![a-z])(?:term[\s_-]?cards?|termcard|term|michaelmas|lent|easter|"
    # A term and a slide's number or year: "MT26", "MT - 2" (review 2026-10-10).
    r"(?:mt|lt|et)\s*[_-]?\s*\d{1,2}(?!\d)|posters?|flyers?|programmes?|program|schedule|calendar|"
    r"what'?s[\s_-]?on|events?|line[\s_-]?up)(?![a-z])",
    re.I,
)
#: A month or a weekday in a file's label: a dated poster ("saturday-10-october").
_SHORT_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)"
_DATE_WORDS = re.compile(
    r"(?<![a-z])(?:january|february|march|april|june|july|august|september|october|"
    r"november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?![a-z])"
    rf"|\d(?:st|nd|rd|th)?[\s_-]?{_SHORT_MONTH}(?![a-z])|(?<![a-z]){_SHORT_MONTH}[\s_-]?\d",
    re.I,
)
#: Alt text longer than this is a caption describing a photo, not a label.
MAX_LABEL_ALT = 80
#: A heading that announces a programme, so the images right under it are cards.
_CARD_HEADING = re.compile(
    r"term[\s-]?card|termcard|programme|upcoming|this term|what'?s on|michaelmas|"
    r"(?<![a-z])lent(?![a-z])|easter|posters?|calendar|schedule|line[\s-]?up",
    re.I,
)
#: A camera's or a stock library's file name: a photo, not a card.
_PHOTO_NAME = re.compile(
    r"^(?:dsc|dscn|dscf|img|pxl|photo|fullsizeoutput)[\s_-]?\d|unsplash|pexels|shutterstock|"
    r"istock|getty",
    re.I,
)
#: What is never a card: logos, icons, sponsors, people, buttons.
_NOT_A_CARD = re.compile(
    r"(?<![a-z])(?:logos?|icons?|favicon|sponsors?|partners?|avatars?|emoji|badges?|crest|"
    r"spinner|placeholder|loader|loading|headshots?|portraits?|profile|signature|"
    r"qr[\s_-]?codes?|navbar|buttons?|arrows?|instagram|facebook|twitter|linkedin|"
    r"whatsapp|tiktok|youtube|discord|telegram|slack|github|spotify|e?mail|background|"
    r"divider|pixel|spacer|blank|forms?|insurance|constitution|minutes|policy|privacy|"
    r"risk[\s_-]?assessment)(?![a-z])",
    re.I,
)
#: A page that is itself a term card (its URL or title): the images in its
#: main content are its slides, labelled or not (the Scandinavian Society's
#: "termcard" page: a gallery without a heading). Not "programme" or "what's
#: on": such pages show photos and show posters as often as cards (survey of
#: the cached pages, 2026-10-10).
_CARD_PAGE = re.compile(r"(?<![a-z])(?:term[\s_-]?cards?|termcards?)(?![a-z])", re.I)
#: Alt text that names an organisation and nothing a card would: its logo.
_ORGANISATION_ALT = re.compile(
    r"(?<![a-z])(?:society|club|association|union|college|university|soc)(?![a-z])", re.I
)
#: A heading over sponsors' logos or the committee's photos.
_NOT_A_CARD_HEADING = re.compile(r"sponsor|partner|supporter|committee|our team|meet the", re.I)
#: A heading over what is over: past cards, a photo gallery.
_PAST_HEADING = re.compile(r"(?<![a-z])(?:past|previous|archive|gallery|photos)(?![a-z])", re.I)


@dataclass(frozen=True)
class TermcardFile:
    url: str
    #: `pdf` or `image`.
    kind: str
    data: bytes
    content_sha256: str
    fetch: FetchResult
    #: The card reaches the model only because the D3 society override lifted
    #: an AI opt-out on a host it came through (`policy.AI_OVERRIDE_NOTE`).
    ai_override: bool = False


@dataclass(frozen=True)
class Skipped:
    url: str
    reason: str


def term_hint(text: str) -> tuple[str | None, int | None]:
    """`("michaelmas", 2026)` from "Michaelmas-Term-Card-2026" or "MT26"."""
    named = _TERM_NAME.search(text)
    if named:
        return named.group(1).lower(), _term_year(named)
    coded = _TERM_CODE.search(text)
    if coded:
        return _CODES[coded.group(1).lower()], 2000 + int(coded.group(2))
    return None, None


def _term_year(match: re.Match[str]) -> int | None:
    if match.group(2):
        return int(match.group(2))
    return 2000 + int(match.group(3)) if match.group(3) else None


def _kind(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "pdf"
    return "image" if vision_image(data) is not None else None


def academic_start_year(today: date) -> int:
    """2026 for any day of 2026-27 (1 July turnover)."""
    return today.year if today.month >= 7 else today.year - 1


def _readable(text: str) -> str:
    """A URL or file name as words: percent-escapes decoded, ``+`` a space."""
    return unquote(text).replace("+", " ")


def stale_reason(text: str, today: date) -> str | None:
    """Why a card that `text` (its URL, file name or link label) describes is
    last year's or older, or None (module docstring)."""
    current = academic_start_year(today)
    text = _readable(text)
    terms = [
        (match.group(1).lower(), year)
        for match in _TERM_NAME.finditer(text)
        if (year := _term_year(match)) is not None
    ] + [(_CODES[m.group(1).lower()], 2000 + int(m.group(2))) for m in _TERM_CODE.finditer(text)]
    # The newest term it names ("Term Card Easter 2026 … term-card-easter-1.png").
    if terms and max(year if name == "michaelmas" else year - 1 for name, year in terms) < current:
        return "names a past term"
    dated = _DATED_PATH.search(text)
    if dated:
        uploaded = date(int(dated.group(1)), int(dated.group(2)), 1)
        if uploaded < date(current, 3, 1):
            return "uploaded before this academic year"
    # A host name is no date ("cambridge-2012-society.org").
    years = {int(year) for year in _YEAR.findall(_HOST.sub(" ", text))}
    if years and max(years) < current:
        return "names only earlier years"
    return None


def modified_reason(last_modified: str | None, today: date) -> str | None:
    """Why a card file whose server says it was last modified on
    `last_modified` (an HTTP date) is last year's, or None: a card not
    touched since before 1 March of this academic year's first calendar
    year cannot be this year's (a Belgian Society card served as "Thu, 09 Jan
    2025" gave the 2024 Freshers' Fair as this October's)."""
    modified = _http_date(last_modified)
    if modified is not None and modified < date(academic_start_year(today), 3, 1):
        return "last modified before this academic year"
    return None


def _http_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date()
    except (TypeError, ValueError, IndexError):
        return None


def published_on(url: str, last_modified: str | None, fetched_at: str) -> date | None:
    """When a card file was published, as far as its URL or its server says:
    a dated path (``/uploads/2026/10/``: the first of that month), else a
    ``Last-Modified`` at least a day before the fetch — a server that stamps
    every answer with the time of the request says nothing about the file."""
    dated = _DATED_PATH.search(url)
    if dated:
        return date(int(dated.group(1)), int(dated.group(2)), 1)
    modified = _http_date(last_modified)
    try:
        fetched = datetime.fromisoformat(fetched_at)
    except ValueError:
        return None
    fetched = fetched if fetched.tzinfo else fetched.replace(tzinfo=UTC)
    if modified is not None and modified < fetched.date() - timedelta(days=1):
        return modified
    return None


def published_this_year(published: date | None, today: date) -> bool:
    """A card published since this academic year began (1 July)."""
    return published is not None and date(academic_start_year(today), 7, 1) <= published <= today


def _is_file(path: str) -> bool:
    return path.endswith(_FILE_SUFFIXES) or bool(_WIX_MEDIA.search(path))


_TERM_ORDER = {"michaelmas": 0, "lent": 1, "easter": 2}


def _recency(text: str) -> tuple[int, int] | None:
    """(academic year, term) a link names, for putting the newest first."""
    name, year = term_hint(text)
    if name is None or year is None:
        return None
    return (year if name == "michaelmas" else year - 1, _TERM_ORDER[name])


# --- the files a page links or embeds -----------------------------------------------------


@dataclass(frozen=True)
class PageFile:
    """A PDF or image a page links or embeds, with what the page says about it."""

    #: As the page gives it (the largest copy a ``srcset`` offers).
    url: str
    #: Its title, link text and file name.
    label: str
    alt: str = ""
    #: The nearest headings above it, the nearest last ("– Michaelmas Term
    #: 2026 Events – / Term Card").
    headings: tuple[str, ...] = ()
    #: ``main``, or the ``nav`` / ``header`` / ``footer`` it sits in.
    region: str = "main"
    #: (width, height) as shown, where the page or the URL says.
    size: tuple[int, int] | None = None
    position: int = 0

    @property
    def heading(self) -> str:
        return " / ".join(self.headings)

    @property
    def words(self) -> str:
        """What the page calls it: the label and a short alt text (a longer
        one is a caption describing a photo, `MAX_LABEL_ALT`)."""
        alt = self.alt if len(self.alt) <= MAX_LABEL_ALT else ""
        return " ".join(filter(None, [alt, self.label]))

    @property
    def key(self) -> str:
        """One file in all its resized copies (`original_url`, lower case)."""
        return original_url(self.url).lower()


def original_url(url: str) -> str:
    """The file itself rather than a resized copy: WordPress's ``-1024x726``
    copies (under ``/wp-content/``), Wix's ``/v1/fill/w_287,h_407…``
    renditions and sizing queries (``?w=727``, ``?format=750w``) lead back
    to the uploaded original."""
    parts = urlsplit(url)
    path = parts.path
    wix = _WIX_ORIGINAL.match(path)
    if wix:
        path = wix.group(1)
    if "/wp-content/" in path:
        path = _WP_SIZE.sub(r"\3", path)
    params = parse_qsl(parts.query, keep_blank_values=True)
    query = parts.query if any(k.lower() not in _SIZING_PARAMS for k, _v in params) else ""
    return urlunsplit((parts.scheme, parts.netloc, path, query, ""))


def _pixels(value: str | None) -> int | None:
    match = re.fullmatch(r"\s*(\d{1,5})(?:px)?\s*", value or "")
    return int(match.group(1)) if match else None


def _shown_size(attrs: dict[str, str | None], url: str) -> tuple[int, int] | None:
    width, height = _pixels(attrs.get("width")), _pixels(attrs.get("height"))
    if width and height:
        return width, height
    path = urlsplit(url).path
    for pattern in (_WP_SIZE, _WIX_SIZE):
        match = pattern.search(path)
        if match:
            return int(match.group(1)), int(match.group(2))
    return None


def _largest_in_srcset(srcset: str | None) -> str | None:
    """The widest candidate of a ``srcset`` (HTML's parsing: a URL is a run
    of non-space characters — Wix's contain commas — ended by a comma or
    followed by its descriptors up to the next comma)."""
    text, position, best = srcset or "", 0, None
    while position < len(text):
        while position < len(text) and (text[position].isspace() or text[position] == ","):
            position += 1
        start = position
        while position < len(text) and not text[position].isspace():
            position += 1
        url, descriptor = text[start:position], ""
        if url.endswith(","):
            url = url.rstrip(",")
        else:
            end = text.find(",", position)
            end = len(text) if end < 0 else end
            descriptor, position = text[position:end].strip(), end
        if re.fullmatch(r"\d+w", descriptor):
            width = int(descriptor[:-1])
        elif re.fullmatch(r"\d+(?:\.\d+)?x", descriptor):
            width = int(float(descriptor[:-1]) * 1000)  # a density: 2x beats 1x
        else:
            width = 0
        if url and (best is None or width > best[0]):
            best = (width, url)
    return best[1] if best else None


def _target(node_tag: str, attrs: dict[str, str | None]) -> str:
    if node_tag == "img":
        return (
            _largest_in_srcset(attrs.get("data-srcset") or attrs.get("srcset"))
            or attrs.get("data-src")
            or attrs.get("data-lazy-src")
            or attrs.get("src")
            or ""
        )
    return attrs.get("href") or attrs.get("src") or attrs.get("data") or ""


def page_files(html: str, base: str) -> list[PageFile]:
    """Every PDF or image `html` links or embeds, in page order, each once."""
    tree = LexborHTMLParser(html)
    files: list[PageFile] = []
    seen: set[str] = set()
    headings: list[str] = []
    selector = "h1, h2, h3, h4, h5, h6, a[href], img, embed[src], iframe[src], object[data]"
    for position, node in enumerate(tree.css(selector)):
        if node.tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = " ".join(node.text(separator=" ", strip=True).split())[:120]
            if text:
                headings = [*headings[-1:], text]
            continue
        attrs = node.attributes
        target = _target(node.tag, attrs).strip()
        absolute = urljoin(base, target)
        if not absolute.startswith(("http://", "https://")):
            continue
        path = absolute.split("?", 1)[0].split("#", 1)[0].lower()
        if not _is_file(path) or absolute in seen:
            continue
        seen.add(absolute)
        name = _readable(path.rsplit("/", 1)[-1])
        text = " ".join(node.text(separator=" ", strip=True).split()) if node.tag == "a" else ""
        label = " ".join(filter(None, [attrs.get("title"), text, name]))
        files.append(
            PageFile(
                url=absolute,
                label=label,
                alt=" ".join((attrs.get("alt") or "").split()),
                headings=tuple(headings),
                region=region_of(node),
                size=_shown_size(attrs, absolute),
                position=position,
            )
        )
    return files


def _newest_first(files: list[PageFile]) -> list[PageFile]:
    """Files naming a term newest first, then the others in page order."""
    named: list[tuple[tuple[int, int], int, PageFile]] = []
    unnamed: list[PageFile] = []
    for item in files:
        recency = _recency(_readable(f"{item.alt} {item.label} {item.url}"))
        if recency is None:
            unnamed.append(item)
        else:
            named.append(((-recency[0], -recency[1]), item.position, item))
    return [item for _r, _p, item in sorted(named, key=lambda n: (n[0], n[1]))] + unnamed


def _file_links(html: str, base: str) -> list[str]:
    """Linked or embedded PDFs/images whose name, label or alt text says
    termcard / programme / poster: those naming a term newest first (a page
    listing this term's card beside last year's), then the others in page
    order."""
    files = [
        item
        for item in page_files(html, base)
        if _TERM_WORDS.search(f"{item.alt} {item.label} {item.url.split('?', 1)[0].lower()}")
    ]
    return [item.url for item in _newest_first(files)]


def card_page(html: str, base: str) -> bool:
    """Whether a page is itself a term card, by its URL's path or its title
    (`_CARD_PAGE`)."""
    title = LexborHTMLParser(html).css_first("title")
    words = " ".join(
        [_readable(urlsplit(base).path), title.text(strip=True) if title is not None else ""]
    )
    return _CARD_PAGE.search(words) is not None


def card_images(html: str, base: str) -> list[PageFile]:
    """The files a society's events page shows that look like term cards or
    event posters (module docstring), newest-named first, each file once
    however many resized copies the page shows. On a page that is itself a
    term card (`card_page`), its main content's images are its slides."""
    chosen: list[PageFile] = []
    seen: set[str] = set()
    on_card_page = card_page(html, base)
    for item in page_files(html, base):
        if item.region != "main" or never_fetched(item.url) or item.key in seen:
            continue
        if _is_card(item, on_card_page=on_card_page):
            seen.add(item.key)
            chosen.append(item)
    return _newest_first(chosen)


def _is_card(item: PageFile, *, on_card_page: bool = False) -> bool:
    """Whether a file a page shows looks like a term card or an event poster:
    a word for one (or a date) in what the page calls it, else the heading
    right above it announces a programme, else the page is a term card itself
    (and its alt text is no organisation's name: its logo) — and it is no
    camera's photo — never a logo, an icon, a sponsor's or a social network's
    image, nothing under a heading of past events or photos, nothing shown as
    an icon or a strip."""
    parts = urlsplit(item.url)
    name = _readable(parts.path.rsplit("/", 1)[-1])
    if _NOT_A_CARD.search(f"{item.words} {parts.hostname or ''} {_readable(parts.path)}"):
        return False
    if item.url.lower().split("?", 1)[0].endswith(".gif"):
        return False  # an animation or an icon
    if any(_PAST_HEADING.search(heading) for heading in item.headings):
        return False
    nearest = item.headings[-1] if item.headings else ""
    named = bool(_CARD_WORDS.search(item.words) or _DATE_WORDS.search(item.words))
    if not named and on_card_page and not _ORGANISATION_ALT.search(item.alt):
        named = True
    if _PHOTO_NAME.search(name):
        return False
    if not named and not _CARD_HEADING.search(nearest):
        return False
    if not named and _NOT_A_CARD_HEADING.search(nearest):
        return False
    if item.size is not None:
        longer, shorter = max(item.size), min(item.size)
        if longer < MIN_CARD_SIDE or (shorter and longer / shorter > MAX_CARD_ASPECT):
            return False
    return True


def card_stale_reason(item: PageFile, today: date) -> str | None:
    """Why a card a page shows is last year's or older (`stale_reason`): by
    its own URL, alt text and label, else — when those name no term, year or
    dated path — by the heading right above it ("Lent Term 2025")."""
    own = " ".join(filter(None, [item.url, item.alt, item.label]))
    reason = stale_reason(own, today)
    readable = _readable(own)
    if reason is not None or _DATED_PATH.search(readable) or _YEAR.search(_HOST.sub(" ", readable)):
        return reason
    if any(_term_year(match) for match in _TERM_NAME.finditer(readable)):
        return reason
    return stale_reason(item.headings[-1], today) if item.headings else None


def dated_this_year(item: PageFile, today: date) -> bool:
    """Whether a card's own URL, alt text or label dates it to this academic
    year: a term of it with its year ("Michaelmas 2026", "MT26"), the year
    itself or a later one, or a dated path since 1 March of its first year."""
    current = academic_start_year(today)
    text = _readable(" ".join(filter(None, [item.url, item.alt, item.label])))
    # A term's year is its academic year's ("Lent 2027" is 2026-27's).
    terms = [
        year if match.group(1).lower() == "michaelmas" else year - 1
        for match in _TERM_NAME.finditer(text)
        if (year := _term_year(match)) is not None
    ]
    years = terms or [int(year) for year in _YEAR.findall(_HOST.sub(" ", text))]
    dated = _DATED_PATH.search(text)
    uploaded = date(int(dated.group(1)), int(dated.group(2)), 1) if dated else None
    return any(year >= current for year in years) or (
        uploaded is not None and uploaded >= date(current, 3, 1)
    )


def never_fetched(url: str) -> str | None:
    """Why a termcard at `url` is never fetched, or None."""
    host = host_of(url)
    for hosts, reason in NEVER_FETCHED:
        if any(host == domain or host.endswith("." + domain) for domain in hosts):
            return reason
    return None


@dataclass(frozen=True)
class _AiCheck:
    #: Why the content must not reach the model, or None.
    refusal: str | None = None
    #: An opt-out was lifted by the D3 society override.
    override: bool = False


def _ai_check(
    client: PoliteClient, purpose: FetchPurpose, *urls: str, page_noai: bool = False
) -> _AiCheck:
    """Whether content fetched through `urls` may reach the model. An AI
    opt-out (robots.txt, or `page_noai` on the page) is lifted where the D3
    society override applies; talks.cam and tbc.xyz never are."""
    override = False
    # A declared class covers the first URL's site only, not a redirect's.
    purpose = purpose.bound_to(urls[0]) if urls else purpose
    for url in urls:
        reason = never_fetched(url)
        if reason is not None:
            return _AiCheck(reason)
        if client.ai_input_allowed(url) and not page_noai:
            continue
        if ai_optout_override(url, purpose):
            override = True
            continue
        return _AiCheck(HOST_KEEPS_AI_OUT)
    return _AiCheck(None, override)


def _card(
    client: PoliteClient, purpose: FetchPurpose, url: str, result: FetchResult
) -> TermcardFile | Skipped | None:
    """`result` as a card file, `Skipped` when a host it came through keeps
    AI out, None when it is no PDF or image."""
    assert result.content is not None
    kind = _kind(result.content)
    if kind is None:
        return None
    check = _ai_check(client, purpose, url, result.final_url)
    if check.refusal is not None:
        return Skipped(url, check.refusal)
    return TermcardFile(
        url, kind, result.content, result.content_sha256 or "", result, check.override
    )


def _fetch(client: PoliteClient, url: str, purpose: FetchPurpose) -> FetchResult | Skipped:
    reason = never_fetched(url)
    if reason is not None:
        return Skipped(url, reason)
    result = client.fetch(url, fresh_for=FRESH_FOR, accept=ACCEPT, purpose=purpose)
    if not result.ok or result.content is None:
        return Skipped(url, result.outcome + (f" ({result.detail})" if result.detail else ""))
    return result


def fetch_card_file(
    client: PoliteClient, url: str, purpose: FetchPurpose = SOCIETY
) -> TermcardFile | Skipped:
    """The PDF or image at `url` (a file a page shows), fetched and returned
    as `fetch_termcard` returns a card — but never followed as a page."""
    result = _fetch(client, url, purpose)
    if isinstance(result, Skipped):
        return result
    return _card(client, purpose, url, result) or Skipped(url, NOT_A_CARD_FILE)


def fetch_termcard(
    client: PoliteClient, url: str, purpose: FetchPurpose = SOCIETY
) -> TermcardFile | Skipped:
    """The termcard file at `url` (or the first one the page at `url` links),
    fetched only from a host it may come from and returned only when every
    host it passed through lets AI read it, or the D3 society override lifts
    the opt-out — else `Skipped` with the reason. `purpose`: the society
    purpose, declaring ``society_website`` when the card is on the society's
    own domain."""
    result = _fetch(client, url, purpose)
    if isinstance(result, Skipped):
        return result
    card = _card(client, purpose, url, result)
    if card is not None:
        return card
    if "html" not in (result.content_type or "").lower():
        return Skipped(url, NOT_A_CARD_FILE)
    page = _ai_check(
        client,
        purpose,
        url,
        result.final_url,
        page_noai=bool(robots_directives(result.text) & _NOAI),
    )
    if page.refusal is not None:
        return Skipped(url, page.refusal)
    # A file the page links is the page's site's only on that site: a card
    # on a shop's CDN keeps the CDN's robots.txt (the declared class does not
    # carry over, `FetchPurpose.bound_to`).
    linked_purpose = purpose.bound_to(result.final_url or url)
    for link in _file_links(result.text, result.final_url)[:2]:
        if never_fetched(link) is not None:
            continue
        linked = client.fetch(link, fresh_for=FRESH_FOR, accept=ACCEPT, purpose=linked_purpose)
        if not linked.ok or linked.content is None:
            continue
        linked_card = _card(client, linked_purpose, link, linked)
        if linked_card is None:
            continue
        if isinstance(linked_card, Skipped):
            return Skipped(url, linked_card.reason)
        return TermcardFile(
            link,
            linked_card.kind,
            linked_card.data,
            linked_card.content_sha256,
            linked,
            page.override or linked_card.ai_override,
        )
    return Skipped(url, NO_CARD_FILE)


__all__ = [
    "MAX_CARD_ASPECT",
    "MIN_CARD_SIDE",
    "NOT_A_CARD_FILE",
    "NO_CARD_FILE",
    "PageFile",
    "Skipped",
    "TermcardFile",
    "academic_start_year",
    "card_images",
    "card_stale_reason",
    "dated_this_year",
    "fetch_card_file",
    "fetch_termcard",
    "modified_reason",
    "never_fetched",
    "original_url",
    "page_files",
    "published_on",
    "published_this_year",
    "stale_reason",
    "term_hint",
]
