"""Mapping the LLM's `OrgExtraction` onto the pages that hold its quotes.

Every value is attributed to the page whose text contains its evidence quote
(exact first, then normalised); a value without a verbatim quote goes to the
home page as ``inferred`` (`claims.llm_field`). Things that would create
rows — sessions, people, partners — are kept only with a verified quote.
Public text never names a committee member and never carries an address.

Free text the model *wrote* (a summary, a "neutral sentence") is ``inferred``
even when its quote is verbatim: the quote supports the gist, not the words.
Only text that is itself on the page is ``found`` (`FREE_TEXT_FIELDS`).

Every reading of a site restates every LLM field for every page it read: a
page that gave a value this time gets it, one that did not gets a
``not_found`` (``not_published`` where the value was withheld because it names
someone or carries an address), so an item a page dropped is retracted rather
than kept by an older reading of that page.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from typing import Any

from camsocs_pipeline.claims import llm_field, llm_items_field, missing_field
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote
from camsocs_pipeline.extract.org import DAYS, OrgCall, OrgExtraction
from camsocs_pipeline.keys import session_key
from camsocs_pipeline.models.observation import IdentityHints, Observation, RelObs
from camsocs_pipeline.sources.websites.page import Link
from camsocs_pipeline.sources.websites.site import (
    EVIDENCE,
    Fetched,
    PartnerMention,
    SiteRecords,
    Target,
    TargetResult,
)

#: Page kinds whose named people are committee members.
PEOPLE_PAGES = frozenset({"committee", "contact", "about"})

#: Fields the LLM reading may claim. Each reading claims each of them on every
#: page it read — a value, or `not_found` / `not_published` — so a page's
#: earlier reading is always replaced (`ExtractionMapper.restate`).
LLM_FIELDS = (
    "shortDescription",
    "description",
    "howToJoin",
    "timeCommitment",
    "accessibilityNote",
    "beginnerFriendly",
    "joinUrl",
    "termcardUrl",
    "membership",
    "trials",
    "categories",
    "activityTypes",
    "audiences",
    "languages",
    "tags",
)

#: Text the model may compose rather than copy: `found` only when the value
#: itself is on the page, else `inferred` (module docstring).
FREE_TEXT_FIELDS = frozenset(
    {"shortDescription", "description", "howToJoin", "timeCommitment", "accessibilityNote"}
)

#: Longest trial date kept, as written; a longer entry is dropped, never cut.
MAX_TRIAL_DATE_CHARS = 120

#: Words that state a membership period; a period the text does not state is
#: left out rather than assumed.
_PERIOD_WORDS = {
    "life": re.compile(r"\blife(time|long)?\b", re.I),
    "year": re.compile(r"\b(year|years|yearly|annual|annually|p\.?\s?a\.?)\b", re.I),
    "term": re.compile(r"\b(term|terms|termly)\b", re.I),
    "one_off": re.compile(r"\b(one[- ]off|one[- ]time|once)\b", re.I),
    "free": re.compile(r"\b(free|no (fee|charge|cost))\b", re.I),
}

_PARTNER_TYPES = {
    "company": "company",
    "ngo": "ngo",
    "public_body": "public_body",
    "uni_office": "uni_office",
    "department": "department",
    "college": "college",
    "other_university_society": "other_university_society",
}
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
#: A trial date as written: a day and month ("Sat 10 Oct", "10/10"), or ISO.
_DATE_LIKE = re.compile(
    r"\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|"
    r"jul|aug|sep|oct|nov|dec)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b",
    re.I,
)
_KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class ExtractionMapper:
    """Turns one `OrgExtraction` into field claims on the pages that hold
    their quotes."""

    def __init__(
        self,
        target: Target,
        pages: list[Fetched],
        buckets: SiteRecords,
        call: OrgCall,
        found: set[str],
        links: list[Link],
        result: TargetResult,
    ) -> None:
        self.target = target
        self.pages = pages
        self.buckets = buckets
        self.call = call
        self.found = found
        self.links = links
        self.result = result
        self.home = pages[0].url
        self.texts = {page.url: page.page.text if page.page else "" for page in pages}
        self.kinds = {page.url: page.kind for page in pages}
        self.people: set[str] = set()
        #: Fields the deterministic reading already claimed (the LLM never does).
        self.deterministic = frozenset(found)
        #: field → page whose value was withheld (names someone / an address).
        self.withheld: dict[str, str] = {}

    # -- attribution ---------------------------------------------------------------------

    def locate(self, quote: str | None) -> tuple[str, EvidenceMatch]:
        """The page holding `quote` (exact first), else the home page / ABSENT."""
        best: tuple[str, EvidenceMatch] | None = None
        for url, text in self.texts.items():
            match = check_quote(quote, text)
            if match is EvidenceMatch.EXACT:
                return url, match
            if match is EvidenceMatch.NORMALISED and best is None:
                best = (url, match)
        return best or (self.home, EvidenceMatch.ABSENT)

    def put(self, name: str, value: Any, quote: str | None) -> None:
        if value is None or name in self.found:
            return
        url, _match = self.locate(quote)
        obs = llm_field(
            name,
            value,
            quote=quote,
            source_text=self.texts[url],
            source_type="society_website",
            model=self.call.model,
            prompt_version=self.call.prompt_version,
            evidence=EVIDENCE,
        )
        if name in FREE_TEXT_FIELDS and not _on_page(value, self.texts[url]):
            # The quote is there; these words are the model's. A summary is
            # never "read from a published source".
            obs.status = "inferred"
        self.buckets.add(url, obs)
        self.found.add(name)

    def put_text(self, name: str, item: Any, limit: int) -> None:
        """A free-text field: withheld (never stored, recorded as such) when
        it names a committee member or carries an address."""
        if item is None or name in self.found:
            return
        value = self.public_text(item.value, limit)
        if value is None:
            if item.value and item.value.strip():
                self.withheld.setdefault(name, self.locate(item.evidence_quote)[0])
            return
        self.put(name, value, item.evidence_quote)

    def put_items(self, name: str, items: list[tuple[Any, str]]) -> None:
        if not items or name in self.found:
            return
        votes = Counter(self.locate(quote)[0] for _value, quote in items)
        url = votes.most_common(1)[0][0]
        obs = llm_items_field(
            name,
            items,
            source_texts=list(self.texts.values()),
            source_type="society_website",
            model=self.call.model,
            prompt_version=self.call.prompt_version,
            evidence=EVIDENCE,
        )
        self.buckets.add(url, obs)
        self.found.add(name)

    def public_text(self, text: str | None, limit: int) -> str | None:
        """Text for a public field: trimmed to `limit`, and refused if it names
        a committee member or carries an email address."""
        if not text or not text.strip():
            return None
        value = " ".join(text.split()) if limit <= 500 else text.strip()
        if "@" in value or any(_names(name, value) for name in self.people):
            return None
        if len(value) > limit:
            cut = value[: limit - 1].rsplit(" ", 1)[0]
            value = cut.rstrip(",;:") + "…"
        return value

    # -- the fields ----------------------------------------------------------------------

    def map(self, x: OrgExtraction) -> None:
        self.people = {person.name.strip() for person in x.committee if person.name.strip()}
        self.committee(x)
        for name, item, limit in (
            ("shortDescription", x.short_description, 200),
            ("description", x.description, 3_000),
            ("howToJoin", x.how_to_join, 2_000),
            ("timeCommitment", x.time_commitment, 500),
            ("accessibilityNote", x.accessibility_note, 2_000),
        ):
            self.put_text(name, item, limit)
        if x.beginner_friendly is not None:
            self.put(
                "beginnerFriendly", x.beginner_friendly.value, x.beginner_friendly.evidence_quote
            )
        for name, item in (("joinUrl", x.join_url), ("termcardUrl", x.termcard_url)):
            if item is not None and (url := self.known_link(item.value)):
                self.put(name, url, item.evidence_quote)
        if x.membership is not None:
            self.put(
                "membership",
                _membership_value(x.membership, self.public_text),
                x.membership.evidence_quote,
            )
        if x.trials is not None:
            trials: dict[str, Any] = {"required": x.trials.required}
            # As written, or not at all: a date cut mid-phrase would be stored
            # as words the source never wrote.
            dates = [
                " ".join(d.split())
                for d in x.trials.dates
                if _DATE_LIKE.search(d) and len(" ".join(d.split())) <= MAX_TRIAL_DATE_CHARS
            ][:10]
            if dates:
                trials["dates"] = dates
            if note := self.public_text(x.trials.note, 300):
                trials["note"] = note
            self.put("trials", trials, x.trials.evidence_quote)
        self.put_items("categories", [(c.value, c.evidence_quote) for c in x.categories])
        self.put_items("activityTypes", [(a.value, a.evidence_quote) for a in x.activity_types])
        self.put_items("audiences", [(a.value, a.evidence_quote) for a in x.audiences])
        self.put_items(
            "languages",
            [
                (lang.value.lower(), lang.evidence_quote)
                for lang in x.languages
                if re.fullmatch(r"[a-zA-Z]{2}", lang.value)
            ],
        )
        tags = [
            tag.strip().lower()
            for tag in x.tags
            if _KEBAB.match(tag.strip().lower()) and len(tag) <= 40
        ]
        if tags and "tags" not in self.found:
            self.buckets.add(
                self.home,
                llm_field(
                    "tags",
                    tags[:6],
                    quote=None,
                    source_text="",
                    source_type="society_website",
                    model=self.call.model,
                    prompt_version=self.call.prompt_version,
                    evidence=EVIDENCE,
                ),
            )
            self.found.add("tags")
        self.sessions(x)
        self.needs_offers(x)
        self.partners(x)
        self.restate()

    def restate(self) -> None:
        """Every LLM field on every page read: the value it gave, else a
        negative claim — `not_published` where a value was withheld, else
        `not_found` — so this reading replaces each page's previous one."""
        for name in LLM_FIELDS:
            if name in self.deterministic:
                continue
            for url in self.texts:
                record = self.buckets.by_url[url]
                if any(obs.field == name for obs in record.fields):
                    continue
                reason = "not_published" if self.withheld.get(name) == url else "not_found"
                absent = missing_field(
                    name, reason, extractor=self.call.model, evidence=EVIDENCE, method="llm"
                )
                absent.prompt_version = self.call.prompt_version
                self.buckets.add(url, absent)

    def known_link(self, url: str | None) -> str | None:
        """`url` only if it is one of the links the model was shown."""
        if not url:
            return None
        wanted = url.strip().rstrip("/")
        for link in self.links:
            if link.url.rstrip("/") == wanted:
                return link.url
        return None

    def committee(self, x: OrgExtraction) -> None:
        for person in x.committee:
            name, role = person.name.strip(), person.role.strip()
            if not _plausible_name(name) or not role or len(role) > 80:
                continue
            url, match = self.locate(person.evidence_quote)
            if (
                match is EvidenceMatch.ABSENT
                or check_quote(name, self.texts[url]) is EvidenceMatch.ABSENT
            ):
                continue
            kind = self.kinds.get(url, "home")
            lists_committee = re.search(r"committee|exec|our team|meet the", self.texts[url], re.I)
            if kind not in PEOPLE_PAGES and not (kind == "home" and lists_committee):
                continue
            record = self.buckets.by_url[url]
            people = record.broker.setdefault("people", [])
            if all(p["name"] != name for p in people):
                people.append({"name": name, "role": role, "method": "llm"})
                self.result.stats.people += 1

    def sessions(self, x: OrgExtraction) -> None:
        seen: set[str] = set()
        for session in x.sessions:
            title = self.public_text(session.title, 300)
            if not title:
                continue
            url, match = self.locate(session.evidence_quote)
            if match is EvidenceMatch.ABSENT:
                continue
            day = DAYS.index(session.day) if session.day else None
            start = (
                session.start_time
                if session.start_time and _HHMM.match(session.start_time)
                else None
            )
            end = session.end_time if session.end_time and _HHMM.match(session.end_time) else None
            try:
                key = session_key(self.target.key, title, day, start)
            except ValueError:
                continue
            if key in seen:
                continue
            seen.add(key)
            values: dict[str, Any] = {
                "title": title,
                "dayOfWeek": day,
                "startTime": start,
                "endTime": end,
            }
            values["venueText"] = self.public_text(session.venue, 300)
            values["termScope"] = session.term_scope
            values["note"] = self.public_text(session.note, 500)
            page = self.buckets.by_url[url]
            fields = [
                llm_field(
                    name,
                    value,
                    quote=session.evidence_quote,
                    source_text=self.texts[url],
                    source_type="society_website",
                    model=self.call.model,
                    prompt_version=self.call.prompt_version,
                    evidence=EVIDENCE,
                )
                for name, value in values.items()
                if value is not None
            ]
            self.buckets.records.append(
                Observation(
                    source_type="society_website",
                    source_key=f"{url}#session:{key}",
                    source_url=url,
                    retrieved_at=page.retrieved_at,
                    content_sha256=page.content_sha256,
                    entity_type="session",
                    identity=IdentityHints(name=title, known_key=key),
                    parent=IdentityHints(name=self.target.name, known_key=self.target.key),
                    entity_key=key,
                    fields=fields,
                )
            )
            self.result.stats.sessions += 1

    def needs_offers(self, x: OrgExtraction) -> None:
        for kind, items in (("needs", x.needs), ("offers", x.offers)):
            seen: set[str] = set()
            for item in items:
                url, match = self.locate(item.evidence_quote)
                if match is EvidenceMatch.ABSENT or item.item in seen:
                    continue
                seen.add(item.item)
                entries = self.buckets.by_url[url].broker.setdefault(kind, [])
                if all(entry["item"] != item.item for entry in entries):
                    entries.append(
                        {
                            "item": item.item,
                            "evidence_quote": item.evidence_quote[:1_000],
                            "method": "llm",
                        }
                    )

    def partners(self, x: OrgExtraction) -> None:
        seen: set[str] = set()
        for partner in x.sponsors_partners:
            name = " ".join(partner.name.split())
            if not name or len(name) > 120 or name.lower() in seen:
                continue
            if any(word in name.lower() for word in ("university of cambridge", "cambridge su")):
                continue
            url, match = self.locate(partner.evidence_quote)
            if (
                match is EvidenceMatch.ABSENT
                or check_quote(name, self.texts[url]) is EvidenceMatch.ABSENT
            ):
                continue
            seen.add(name.lower())
            sponsor = partner.relation == "sponsor"
            relationship = RelObs(
                type="sponsors" if sponsor else "partner_of",
                to_identity=IdentityHints(name=name, org_type=_PARTNER_TYPES.get(partner.kind)),
                evidence_url=url,
                note=partner.evidence_quote[:300],
                direction="incoming" if sponsor else "outgoing",
                method="llm",
                evidence=EVIDENCE,
                quote_check=match.value,
                visibility="public" if sponsor else None,
            )
            record = self.buckets.by_url[url]
            self.result.partners.append(
                PartnerMention(record, relationship, partner.evidence_quote, self.texts[url])
            )
            self.result.stats.partners += 1


def _names(name: str, text: str) -> bool:
    """Whether `text` names the person `name` (a whole-word match; a single
    first name must also match its capital, so "Joy" is not "enjoy")."""
    words = name.split()
    pattern = r"(?<![\w])" + r"\s+".join(map(re.escape, words)) + r"(?![\w])"
    flags = re.IGNORECASE if len(words) > 1 else 0
    return re.search(pattern, text, flags) is not None


def _on_page(value: Any, page_text: str) -> bool:
    """Whether a free-text value is itself on the page (a trailing "…" from
    our own trimming aside)."""
    if not isinstance(value, str):
        return False
    text = value.removesuffix("…").strip()
    return check_quote(text, page_text) is not EvidenceMatch.ABSENT


def _stated_period(period: str | None, *texts: str | None) -> str | None:
    """`period` only when the tier's own words or the quote state it."""
    if period is None:
        return None
    words = _PERIOD_WORDS.get(period)
    return period if words and any(t and words.search(t) for t in texts) else None


def _membership_value(
    membership: Any, public_text: Callable[[str | None, int], str | None]
) -> dict[str, Any] | None:
    """The membership value, with every text through `public_text` (a label
    that names someone drops its tier; a note or bursary note is left out) and
    a period only where the text states it."""
    tiers = []
    for tier in membership.tiers:
        label = public_text(tier.label, 120)
        if not label:
            continue
        note = public_text(tier.note, 300)
        period = _stated_period(tier.period, tier.label, tier.note, membership.evidence_quote)
        entry: dict[str, Any] = {"label": label}
        if period is not None:
            entry["period"] = period
        if tier.price_pence is not None and period != "free":
            entry["pricePence"] = int(tier.price_pence)
        if note:
            entry["note"] = note
        tiers.append(entry)
    bursary = public_text(membership.bursary_note, 500)
    if not tiers and not bursary:
        return None
    value: dict[str, Any] = {"tiers": tiers}
    if bursary:
        value["bursaryNote"] = bursary
    if membership.college_reimbursable is not None:
        value["collegeReimbursable"] = membership.college_reimbursable
    return value


_ROLE_ONLY = re.compile(
    r"^(president|chair|secretary|treasurer|officer|committee|captain|vacant|tbc|tba|n/?a)$", re.I
)


def _plausible_name(name: str) -> bool:
    """A person's name as a committee page writes it — "Jane Doe", or just
    "Jane" (many list first names only) — not a role, address or sentence."""
    words = name.split()
    return (
        1 <= len(words) <= 5
        and len(name) <= 80
        and "@" not in name
        and not any(char.isdigit() for char in name)
        and all(word[0].isupper() for word in words if word[0].isalpha())
        and not _ROLE_ONLY.match(name)
    )


__all__ = ["FREE_TEXT_FIELDS", "LLM_FIELDS", "PEOPLE_PAGES", "ExtractionMapper"]
