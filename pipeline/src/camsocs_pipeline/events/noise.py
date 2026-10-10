"""Calendar noise (decision D6, 2026-10-10), the rules: which event readings
are no events at all, and which are events a society only takes part in
(data-model §2 "Calendar noise"). Deterministic: no event text reaches a
model here. The bulk model for what the rules leave borderline, the claims a
verdict becomes and the sifting the load does live in `extract.event_noise`.

Societies' calendars carry entries that announce nothing — the Islamic
Society's prayer-room notices ("PR closed to brothers (Sisters Quran
Circle)"), a JCR's nominations deadline, "MSt students in residence" — and
other bodies' events: the Cyber Security Society's calendar imports every CTF
on CTFtime, a Sikh Society lists another university's kirtan its members go
to. Each staged event reading is one of three kinds (`Verdict.kind`):

- ``notice``: not an event (dropped by the load);
- ``external``: someone else's event the listing society takes part in
  (``hosting: takes_part``, the external event's page as ``externalUrl``);
- ``event``: the rest (``hosting: hosts``).

**The rules** (`judge`), in this order; each has an id (``Verdict.rule``,
the claim's extractor ``event_noise.<rule>``) and the words it matched are
its evidence:

1. Notices, by title: a room booking (`events.checks.is_booking`), a room or
   prayer room closed or open and opening hours (``notice.room_closure``), a
   cancellation of nothing ("No Archery at Churchill", a bare "Cancelled";
   ``notice.nothing``), a booking or admin notice (a deadline, nominations or
   sign-ups opening or closing, an office's office hours; ``notice.admin`` —
   with an event word beside it, "Beat the Deadline workshop", it is only
   borderline), a date marker ("Full Term starts", a bank holiday, "MSt
   students in residence"; ``notice.date_marker``), and a placeholder title
   ("TBC", "Busy", "Hold") with no description and no speakers, on a listing
   that does not state its events itself (``notice.placeholder``).
2. External, decisively: a title the society marks itself ("[External] CUEN
   conference"; ``external.marked``), an entry a CTFtime import wrote ("CTF
   Event from CTFTime", a ctftime.org link; ``external.ctftime``) unless its
   title names its own organiser, and a talk linked on talks.cam that is not
   on one of the listing society's own talks lists (``external.talks_cam``;
   the talks.cam stage's staged talks say whose list a talk is on — one of
   the society's own is ``event.own_talks_list``).
3. Borderline — weak signals (`Verdict.borderline`): "hosted by" /
   "organised by" an organisation that is not the listing one (Luma writes
   "Hosted by" and people's names into every description: a person is no
   signal), "we're attending", "taking part in", a link to an outside events
   platform (Devpost, MLH, Kaggle, …), a hackathon, conference, tournament,
   championship, fair or "X Open" in the title, another university, a
   placeholder title with a description, a deadline-like word. A listing that
   states its organiser itself (Camdram, talks.cam, CUCBC, Playwaze, SU What's
   On) settles it as the society's own (``event.listing``), as does a fixture
   ("vs", "Varsity"; ``event.fixture``) or a title that names its own
   organiser by name, alias, short name or acronym (`own_names`;
   ``event.own_name``) — never by a topic word of its name ("engineering"),
   which an outside event's title may share. What stays borderline is
   ``event.default`` until the model says otherwise.

`NoiseContext` reads what the staged records say about the listing
organisations (names, aliases, short names, websites, their talks.cam
talks); `candidate_links` says which links may be an external event's own
page.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Literal

from camsocs_pipeline.events.checks import is_booking
from camsocs_pipeline.models.observation import EventObservation, Observation
from camsocs_pipeline.sources.links import (
    chat_platform,
    host_of,
    is_personal_profile,
    is_social_host,
    name_tokens,
    registrable,
)

Kind = Literal["event", "notice", "external"]

#: Candidate links the model may choose the external page from.
MAX_LINKS = 8
#: A description shorter than this (links and spaces aside) says nothing.
SUBSTANTIVE_DESCRIPTION = 15

#: Listings that state the organiser themselves: what they list under a
#: society is its own (a Camdram show, a CUCBC regatta under its host club).
SELF_DESCRIBING_SOURCES = frozenset(
    {"camdram", "talks_cam", "cucbc", "playwaze", "su_whatson", "uni_events_api"}
)


# --- text helpers ---------------------------------------------------------------------------

_QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-"})


def _plain(text: str) -> str:
    """Lower case, curly quotes folded, emoji and brackets dropped, spaces collapsed."""
    text = unicodedata.normalize("NFKC", text).translate(_QUOTES)
    text = re.sub(r"[^\w\s'&/+:-]", " ", text)
    return " ".join(text.lower().split()).strip(" -:/+&")


_URL = re.compile(r"https?://[^\s<>\"'()\[\]]+", re.IGNORECASE)


def _urls(text: str) -> list[str]:
    return [match.group(0).rstrip(".,;:!?*_") for match in _URL.finditer(text)]


def _one_line(text: str, limit: int = 300) -> str:
    return " ".join(text.split())[:limit]


def _substantive(description: str) -> bool:
    return len(_URL.sub("", description).strip()) >= SUBSTANTIVE_DESCRIPTION


# --- the rules ------------------------------------------------------------------------------

#: A place whose closing or opening is a notice, not an event.
_PLACE = (
    r"(?:pr|prayer\s+rooms?|(?:[\w']+\s+)?room|bar|library|gym|buttery|kitchen|office|chapel"
    r"|building|boat\s*house|pool|range|pavilion|jcr|mcr|hall)"
)
_CLOSURE = re.compile(
    rf"\b{_PLACE}\s+(?:is\s+|will\s+be\s+|remains\s+)?(?:closed|shut|unavailable|out\s+of\s+use"
    rf"|re-?opens?|re-?opening|open\s+again)\b"
    rf"|\b(?:closure\s+of|closed:)\s+(?:the\s+)?{_PLACE}\b"
    r"|\b(?:pr|prayer\s+room|bar|library|buttery|gym)\s+(?:is\s+)?(?:now\s+)?open\b"
    r"(?!\s+(?:mic|day|evening|night|session|training|house|meeting|forum|call))"
    r"|\bopening\s+(?:hours|times)\b",
    re.IGNORECASE,
)
_OPENING = re.compile(r"\bopen|\bre-?open", re.IGNORECASE)
#: A cancellation that names no event.
_NOTHING = re.compile(
    r"^(?:cancelled|canceled|postponed|no\s+events?|nothing\s+(?:on|planned))\W*$"
    r"|^(?:no|not)\s+(?:sessions?|training|practice|rehearsals?|meetings?|class(?:es)?|circle"
    r"|services?|club\s*night|archery|shooting|outings?|choir|lessons?|swimming|rowing)\b"
    r"|^(?:no|not)\s+[\w' -]{1,40}?\b(?:this|next)\s+(?:week|weekend|term|time)\b"
    r"|^(?:no|not)\s+[\w' -]{1,40}?\btoday\b",
    re.IGNORECASE,
)
_ADMIN = re.compile(
    r"\bdeadlines?\b"
    r"|\b(?:nominations?|applications?|submissions?|registrations?|sign[- ]?ups?|bookings?"
    r"|tickets?|ticket\s+sales|voting|ballots?|entries)\s+(?:now\s+|are\s+|is\s+)?"
    r"(?:open|opens|opening|close|closes|closing|closed|due|released?|go(?:es)?\s+live"
    r"|launch(?:es)?)\b"
    r"|\b(?:last|final)\s+day\s+(?:to|for)\s+(?:apply|sign|book|register|submit|vote|nominate)\b"
    r"|\b(?:admin(?:istrative|istration)?|porters'?|accommodation|tutorial|bursary|bursar's"
    r"|finance|it)\s+office\s+hours\b",
    re.IGNORECASE,
)
#: Words that make an admin-looking title an event after all.
_EVENT_WORDS = re.compile(
    r"\b(?:workshop|talk|social|session|party|night|lecture|seminar|dinner|drinks|meeting|"
    r"lunch|brunch|formal|q&a|panel|meet|launch\s+event|celebration)\b",
    re.IGNORECASE,
)
_TERM_SUFFIX = r"(?:\s+(?:michaelmas|lent|easter|mt|lt|et|\d{2,4}(?:[/-]\d{2,4})?))*"
_DATE_MARKER = re.compile(
    r"(?:"
    r"(?:(?:michaelmas|lent|easter|full|summer)\s+)?(?:full\s+)?term\s+(?:starts|begins|ends"
    r"|start|end|finishes)"
    r"|(?:start|end|beginning|first\s+day|last\s+day)\s+of\s+(?:(?:michaelmas|lent|easter)\s+)?"
    r"(?:full\s+)?term"
    r"|division\s+of\s+term|reading\s+week|half[- ]term"
    r"|(?:(?:early|late|summer|spring|august|may)\s+)?bank\s+holiday(?:\s+monday)?"
    r"|public\s+holiday"
    r"|(?:christmas|easter|summer|long|winter)\s+(?:vacation|vac|break|holidays?)"
    r"(?:\s+(?:starts|begins|ends))?"
    r"|(?:vacation|vac)\s+(?:starts|begins|ends)"
    r"|(?:[\w']+\s+){0,3}(?:students?|freshers?|undergrads?|undergraduates|postgrads?"
    r"|postgraduates|grads?|residents)\s+(?:in\s+residence|arrive|arrival|arriving|move[- ]in"
    r"|moving\s+in|depart|departure|leave)"
    r"|(?:college|university|uni|buildings?)\s+closed"
    r"|(?:christmas|boxing|new\s+year'?s?)\s+(?:day|eve)|good\s+friday|easter\s+(?:sunday|monday)"
    r"|clocks\s+go\s+(?:back|forward)"
    rf"){_TERM_SUFFIX}"
)
_PLACEHOLDER = re.compile(
    r"(?:title\s+)?(?:tbc|tba|tbd|to\s+be\s+(?:confirmed|announced|decided|arranged))"
    r"|title\s+(?:tbc|tba|to\s+be\s+confirmed)|placeholder|hold|on\s+hold|busy|reserved|blocked"
    r"|unavailable|untitled(?:\s+event)?|new\s+event|event|no\s+title|test(?:\s+event)?"
)

_CTFTIME = re.compile(
    r"\bctf\s+event\s+from\s+ctf\s*time\b|\bctf\s*time\b|ctftime\.org", re.IGNORECASE
)
#: A title the society itself marks as someone else's: "[External] CUEN conference".
_MARKED_EXTERNAL = re.compile(
    r"^\W*[\[(]?\s*external\s*(?:event)?\s*[\])]|^\W*external\s*(?:event)?\s*:", re.IGNORECASE
)
_TALK_LINK = re.compile(r"talks\.cam\.ac\.uk/talk/(?:index/)?(\d+)", re.IGNORECASE)
_MORE_INFO = re.compile(r"more\s+info(?:rmation)?\s*:\s*(https?://\S+)", re.IGNORECASE)

#: Borderline signals: (name, pattern over the title and description).
_HOSTED_BY = re.compile(
    r"\b(?:hosted|organi[sz]ed|run|presented|put\s+on)\s+by\s+(?:the\s+)?"
    r"(?P<who>[^.\n,;!?()]{2,60})",
    re.IGNORECASE,
)
_ATTENDING = re.compile(
    r"\bwe(?:'re|’re|\s+are|\s+will\s+be|'ll\s+be|’ll\s+be)\s+(?:attending|going\s+to|heading\s+to"
    r"|competing|taking\s+part|participating|representing|visiting|joining)\b"
    r"|\bcome\s+with\s+us\s+to\b|\bjoin\s+us\s+in\s+attending\b|\btaking\s+part\s+in\b"
    r"|\bparticipat(?:e|ing)\s+in\b|\bcompet(?:e|ing)\s+(?:in|at)\b|\bexternal\s+event\b"
    r"|\bsocs?\s+go\b|\bsocieties\s+(?:go|attend)\b",
    re.IGNORECASE,
)
_GATHERING = re.compile(
    r"(?i:\b(?:hackathons?|conferences?|summit|congress|convention|expo|olympiad|championships?"
    r"|nationals|tournament|fair|festival|symposium|competitions?|qualifiers?|quals)\b)"
    r"|\b[A-Z][\w']+\s+Open\b(?!\s+(?:Mic|Day|Evening|Night|Session|Training|House|Meeting|Shoot))",
)
_OTHER_UNIVERSITY = re.compile(
    r"\b(?:oxford|ou[a-z]{2,8}soc|kcl|ucl|lse|imperial|warwick|durham|edinburgh|bristol"
    r"|manchester|nottingham|st\s+andrews|king's\s+college\s+london|anglia\s+ruskin|aru)\b",
    re.IGNORECASE,
)
_FIXTURE = re.compile(r"\b(?:vs?\.?|versus|varsity|against)\b", re.IGNORECASE)
_DEADLINE_LIKE = re.compile(r"\b(?:opens|closes|released|due)\b", re.IGNORECASE)
_WHO_IS_US = re.compile(r"^(?:us|our\b|the\s+committee|committee|members?)", re.IGNORECASE)
#: "Hosted by …" names an organisation, not a person (Luma writes "Hosted by"
#: and its hosts' names into every description): an organisation word or an
#: acronym ("USI", "BCG").
_ORGANISATION = re.compile(
    r"(?i:\b(?:societ(?:y|ies)|soc|club|association|union|college|university|department"
    r"|faculty|institute|centre|center|lab|laboratory|group|company|ltd|limited|foundation"
    r"|trust|network|council|team|school|hub|forum|initiative|programme|program|charity"
    r"|museum|gallery|conference|festival|federation|league)\b)|\b[A-Z]{2,6}\b"
)

#: Outside events platforms: a link there points at someone else's event.
_PLATFORM_HOSTS = (
    "devpost.com",
    "mlh.io",
    "hackerearth.com",
    "unstop.com",
    "dorahacks.io",
    "ethglobal.com",
    "lablab.ai",
    "codeforces.com",
    "atcoder.jp",
    "picoctf.org",
)
_PLATFORM_PATHS = (("kaggle.com", "/competitions"), ("leetcode.com", "/contest"))

#: Links that are never an event's own page.
_NOT_A_PAGE_HOSTS = (
    "calendar.google.com",
    "maps.google.com",
    "goo.gl",
    "maps.app.goo.gl",
    "forms.gle",
    "docs.google.com",
    "drive.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "teams.live.com",
    "meet.google.com",
    "cambridgesu.co.uk",
    "camdram.net",
    "talks.cam.ac.uk",
)
_IMAGE_PATH = re.compile(r"\.(?:png|jpe?g|gif|webp|avif|svg|pdf)(?:$|\?)", re.IGNORECASE)


def _host_in(host: str, domains: Iterable[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def candidate_links(urls: Iterable[str], own_hosts: Iterable[str]) -> list[str]:
    """Links that may be an external event's own page, in order, each once:
    never a chat invite, a form, a meeting or map link, a social or personal
    profile, a file, a listing we read as the society's own (the SU, Camdram,
    talks.cam) or the organiser's own site."""
    own = {registrable(host) for host in own_hosts if host}
    out: list[str] = []
    for url in urls:
        host = host_of(url)
        if not host or url in out:
            continue
        if (
            chat_platform(url)
            or is_social_host(url)
            or is_personal_profile(url)
            or _host_in(host, _NOT_A_PAGE_HOSTS)
            or (host.startswith("google.") and "/maps" in url)
            or _IMAGE_PATH.search(url)
            or registrable(host) in own
        ):
            continue
        out.append(url)
    return out[:MAX_LINKS]


def _on_platform(url: str) -> bool:
    host = host_of(url)
    if _host_in(host, _PLATFORM_HOSTS):
        return True
    return any(_host_in(host, (domain,)) and path in url for domain, path in _PLATFORM_PATHS)


@dataclass(frozen=True)
class EventText:
    """What the classifier reads of one event reading."""

    title: str
    description: str = ""
    venue: str = ""
    #: Every http(s) link the reading gives, in order (description, venue,
    #: booking page, the event's own page).
    urls: tuple[str, ...] = ()
    #: Names of the organisations whose listing it is.
    organisers: tuple[str, ...] = ()
    #: `links.name_tokens` of those names (and their aliases / short names):
    #: is "hosted by …" one of them?
    own_tokens: frozenset[str] = frozenset()
    #: The names themselves, aliases, short names and acronyms, lower case:
    #: does the title name its own organiser?
    own_names: frozenset[str] = frozenset()
    #: Their websites' hosts.
    own_hosts: frozenset[str] = frozenset()
    source_type: str = ""
    event_source: str = ""
    #: The talks.cam talks on a listing organisation's own lists (by talk id).
    own_talks: frozenset[str] = frozenset()
    #: The reading publishes speakers: a talk, whatever its title says.
    has_speakers: bool = False

    def text(self) -> str:
        """The text the model sees and its quote is checked against."""
        return "\n".join(part for part in (self.title, self.venue, self.description) if part)

    def links(self) -> list[str]:
        return candidate_links(self.urls, self.own_hosts)


@dataclass(frozen=True)
class Verdict:
    """What one reading is, and why."""

    kind: Kind
    #: ``notice.room_closure``, ``external.ctftime``, ``event.default``, … or ``model``.
    rule: str
    #: The words a rule matched, or the model's quote.
    evidence: str | None = None
    external_url: str | None = None
    #: The weak signals that make a reading borderline (module docstring).
    borderline: tuple[str, ...] = ()
    #: Set for a model verdict.
    model: str | None = None
    quote_check: str | None = None


def _match_text(match: re.Match[str] | None) -> str | None:
    return match.group(0).strip() if match else None


def own_names(names: Iterable[str]) -> frozenset[str]:
    """What a title may call its own organiser: its names, aliases and short
    names, and the acronyms `links.name_tokens` makes of them ("cuadc") —
    never a topic word of the name ("engineering"), which an outside event's
    title may share."""
    names = [name for name in names if name]
    words = {word for name in names for word in _plain(name).split()}
    out = {_plain(name) for name in names if len(_plain(name)) >= 3}
    out |= {token for token in name_tokens(*names) if token not in words and len(token) >= 3}
    return frozenset(out)


def _names_own(text: EventText) -> bool:
    title = _plain(text.title)
    return any(re.search(rf"(?<![\w']){re.escape(name)}(?![\w])", title) for name in text.own_names)


def _notice(text: EventText) -> Verdict | None:
    title = _one_line(text.title)
    plain = _plain(title)
    if is_booking(title):
        return Verdict("notice", "notice.booking", title)
    found = _CLOSURE.search(title)
    if found and not (_OPENING.search(found.group(0)) and _EVENT_WORDS.search(title)):
        # An opening with an event word is a party ("Bar Reopening Night"); a
        # closure is a notice whatever its reason names ("PR closed to
        # sisters (Brothers Social)").
        return Verdict("notice", "notice.room_closure", found.group(0))
    if found := _NOTHING.search(title):
        return Verdict("notice", "notice.nothing", found.group(0))
    if (found := _ADMIN.search(title)) and not _EVENT_WORDS.search(title):
        return Verdict("notice", "notice.admin", found.group(0))
    if _DATE_MARKER.fullmatch(plain):
        return Verdict("notice", "notice.date_marker", title)
    if (
        (_PLACEHOLDER.fullmatch(plain) or not plain)
        and not _substantive(text.description)
        and not text.has_speakers
        and text.event_source not in SELF_DESCRIBING_SOURCES
    ):
        return Verdict("notice", "notice.placeholder", title)
    return None


def _external(text: EventText) -> Verdict | None:
    body = f"{text.title}\n{text.description}\n{text.venue}"
    links = text.links()
    if found := _MARKED_EXTERNAL.search(text.title):
        return Verdict(
            "external",
            "external.marked",
            found.group(0).strip(),
            external_url=next(iter(links), None),
        )
    if (found := _CTFTIME.search(body) or _CTFTIME.search(" ".join(text.urls))) and not _names_own(
        text
    ):
        more = _MORE_INFO.search(text.description)
        preferred = more.group(1).rstrip(".,;:!?*_") if more else None
        url = (
            preferred
            if preferred in links
            else next((link for link in links if "ctftime.org" in link), None)
            or (links[0] if links else None)
        )
        return Verdict("external", "external.ctftime", found.group(0), external_url=url)
    talk = _TALK_LINK.search(f"{body}\n{' '.join(text.urls)}")
    if talk is not None and text.event_source != "talks_cam":
        if talk.group(1) in text.own_talks:
            return Verdict("event", "event.own_talks_list", talk.group(0))
        page = f"https://{talk.group(0)}"
        return Verdict("external", "external.talks_cam", talk.group(0), external_url=page)
    return None


def _signals(text: EventText) -> list[str]:
    body = f"{text.title}\n{text.description}"
    signals: list[str] = []
    for hosted in _HOSTED_BY.finditer(body):
        who = hosted.group("who").strip()
        who_tokens = name_tokens(who) | set(_plain(who).split())
        if _WHO_IS_US.match(who) or who_tokens & text.own_tokens or not _ORGANISATION.search(who):
            continue
        signals.append("hosted by another")
        break
    if _ATTENDING.search(body):
        signals.append("attending")
    if any(_on_platform(url) for url in text.urls):
        signals.append("events platform")
    if _GATHERING.search(text.title):
        signals.append("gathering")
    if _OTHER_UNIVERSITY.search(text.title):
        signals.append("another university")
    plain = _plain(text.title)
    if _PLACEHOLDER.fullmatch(plain):
        signals.append("placeholder with a description")
    if _ADMIN.search(text.title) or _DEADLINE_LIKE.search(text.title):
        signals.append("deadline-like")
    return signals


def judge(text: EventText) -> Verdict:
    """The rules' verdict on one reading (module docstring). A ``borderline``
    verdict is ``event.default`` until the model says otherwise."""
    if (verdict := _notice(text)) is not None:
        return verdict
    if (verdict := _external(text)) is not None:
        return verdict
    signals = _signals(text)
    if not signals:
        return Verdict("event", "event.default")
    if text.event_source in SELF_DESCRIBING_SOURCES:
        return Verdict("event", "event.listing")
    if _FIXTURE.search(text.title):
        return Verdict("event", "event.fixture", _match_text(_FIXTURE.search(text.title)))
    if _names_own(text):
        return Verdict("event", "event.own_name", text.title)
    return Verdict("event", "event.default", borderline=tuple(signals))


# --- the context a reading is judged in -----------------------------------------------------


@dataclass(frozen=True)
class NoiseContext:
    """What the staged records say about the listing organisations: their
    names (for `EventText.own_tokens`), their websites, and the talks on
    their own talks.cam lists."""

    names: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    hosts: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    talks: Mapping[str, frozenset[str]] = field(default_factory=dict)

    @classmethod
    def from_records(cls, records: Iterable[object]) -> NoiseContext:
        names: dict[str, list[str]] = {}
        hosts: dict[str, list[str]] = {}
        talks: dict[str, set[str]] = {}
        for record in records:
            if isinstance(record, Observation):
                key = record.entity_key
                if record.entity_type != "organisation" or key is None:
                    continue
                known = names.setdefault(key, [])
                known.extend([record.identity.name, *record.identity.aliases])
                for obs in record.fields:
                    if obs.field in ("name", "shortName") and isinstance(obs.value, str):
                        known.append(obs.value)
                    elif obs.field == "aliases" and isinstance(obs.value, list):
                        known.extend(str(alias) for alias in obs.value)
                    elif obs.field == "website" and isinstance(obs.value, str):
                        hosts.setdefault(key, []).append(host_of(obs.value))
                if record.identity.website_domain:
                    hosts.setdefault(key, []).append(record.identity.website_domain)
            elif isinstance(record, EventObservation) and record.event_source == "talks_cam":
                for organiser in record.organisers:
                    if organiser.identity.known_key:
                        talks.setdefault(organiser.identity.known_key, set()).add(
                            record.external_id
                        )

        def unique(values: list[str]) -> tuple[str, ...]:
            return tuple(dict.fromkeys(value for value in values if value))

        return cls(
            names={key: unique(value) for key, value in names.items()},
            hosts={key: unique(value) for key, value in hosts.items()},
            talks={key: frozenset(value) for key, value in talks.items()},
        )

    def text_of(self, record: EventObservation) -> EventText:
        values = {obs.field: obs.value for obs in record.fields if obs.value is not None}

        def text(name: str) -> str:
            value = values.get(name)
            return value if isinstance(value, str) else ""

        venue = record.venue.name if record.venue is not None else text("venueText")
        description = text("description")
        urls = [
            *_urls(description),
            *_urls(venue),
            *(url for name in ("bookingUrl", "sourceUrl") if (url := text(name))),
        ]
        organiser_names: list[str] = []
        own_hosts: list[str] = []
        own_talks: set[str] = set()
        for organiser in [*record.organisers, *record.unresolved_organisers]:
            organiser_names.append(organiser.identity.name)
            organiser_names.extend(organiser.identity.aliases)
            if organiser.identity.website_domain:
                own_hosts.append(organiser.identity.website_domain)
            key = organiser.identity.known_key
            if key:
                organiser_names.extend(self.names.get(key, ()))
                own_hosts.extend(self.hosts.get(key, ()))
                own_talks |= self.talks.get(key, frozenset())
        shown = tuple(dict.fromkeys(name for name in organiser_names if name))
        return EventText(
            title=text("title"),
            description=description,
            venue=venue,
            urls=tuple(dict.fromkeys(urls)),
            organisers=shown,
            own_tokens=frozenset(name_tokens(*shown)),
            own_names=own_names(shown),
            own_hosts=frozenset(own_hosts),
            source_type=record.source_type,
            event_source=record.event_source,
            own_talks=frozenset(own_talks),
            has_speakers=bool(values.get("speakers")),
        )


__all__ = [
    "SELF_DESCRIBING_SOURCES",
    "EventText",
    "Kind",
    "NoiseContext",
    "Verdict",
    "candidate_links",
    "judge",
    "own_names",
]
