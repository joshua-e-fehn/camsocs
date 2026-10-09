"""LLM extraction of an organisation's practical information from its own
website (T5), prompt ``org_v1`` (`prompts/org_v1.md`).

The model returns an `OrgExtraction`: every value with an
``evidence_quote``. Nothing here decides what is true — the enrichment stage
checks every quote against the page text it came from
(`extract.evidence.check_quote`), attributes the value to that page, and
records an unverified value as ``inferred`` (or drops it, for things that
would create entities: sessions, people, partners).

Robustness over strictness: enum values outside our vocabularies are dropped
item by item (a model inventing ``"technology"`` as a category loses that
item, not the whole reply), and unknown keys are ignored.

Results are cached under ``var/cache/llm/<prompt version>/<sha256>.json``,
keyed by model, prompt version and the exact prompt, so an unchanged site
costs no call on the next run.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from string import Template
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import write_json_atomic
from camsocs_pipeline.models.vocab import (
    ACTIVITY_TYPES,
    AUDIENCES,
    CATEGORIES,
    MEMBERSHIP_PERIODS,
    NEED_OFFER_ITEMS,
    TERM_SCOPES,
)

logger = logging.getLogger(__name__)

PROMPT_VERSION = "org_v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_VERSION}.md"

#: Characters of page text the model reads per organisation (all pages together).
TEXT_BUDGET = 12_000
#: Share of the budget per page kind before redistribution.
PAGE_SHARE = {
    "home": 3_200,
    "about": 2_400,
    "join": 1_800,
    "committee": 1_500,
    "contact": 800,
    "events": 1_300,
    "sponsors": 1_000,
}
MAX_LINKS = 40

DAYS = ("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")
PARTNER_KINDS = (
    "company",
    "ngo",
    "public_body",
    "uni_office",
    "department",
    "college",
    "student_society",
    "other_university_society",
    "other",
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class QuotedText(_Model):
    value: str
    evidence_quote: str = ""


class QuotedBool(_Model):
    value: bool
    evidence_quote: str = ""


class Tier(_Model):
    label: str
    price_pence: int | None = Field(default=None, ge=0, le=1_000_000)
    #: None when the model gives none or an unknown one: never assumed.
    period: Literal[MEMBERSHIP_PERIODS] | None = None
    note: str | None = None

    @field_validator("period", mode="before")
    @classmethod
    def _period(cls, value: Any) -> Any:
        return value if value in MEMBERSHIP_PERIODS else None


class Membership(_Model):
    tiers: list[Tier] = Field(default_factory=list)
    bursary_note: str | None = None
    college_reimbursable: bool | None = None
    evidence_quote: str = ""


class Trials(_Model):
    required: bool
    dates: list[str] = Field(default_factory=list)
    note: str | None = None
    evidence_quote: str = ""


def _in_vocab(items: Any, values: tuple[str, ...]) -> list[Any]:
    """The items whose ``value`` is in the vocabulary; the rest are dropped."""
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and item.get("value") in values]


class Category(_Model):
    value: Literal[CATEGORIES]
    evidence_quote: str = ""


class ActivityType(_Model):
    value: Literal[ACTIVITY_TYPES]
    evidence_quote: str = ""


class Audience(_Model):
    value: Literal[AUDIENCES]
    evidence_quote: str = ""


class Language(_Model):
    value: str = Field(description="ISO 639-1 code, e.g. de")
    evidence_quote: str = ""


class Session(_Model):
    title: str
    day: Literal[DAYS] | None = None
    start_time: str | None = Field(default=None, description="HH:MM, 24-hour")
    end_time: str | None = Field(default=None, description="HH:MM, 24-hour")
    venue: str | None = None
    term_scope: Literal[TERM_SCOPES] | None = None
    note: str | None = None
    evidence_quote: str = ""

    @field_validator("day", mode="before")
    @classmethod
    def _day(cls, value: Any) -> Any:
        if isinstance(value, str) and value.strip().lower() in DAYS:
            return value.strip().lower()
        return None

    @field_validator("term_scope", mode="before")
    @classmethod
    def _term(cls, value: Any) -> Any:
        return value if value in TERM_SCOPES else None


class NeedOffer(_Model):
    item: Literal[NEED_OFFER_ITEMS]
    evidence_quote: str = ""


class Person(_Model):
    name: str
    role: str
    evidence_quote: str = ""


class Partner(_Model):
    name: str
    relation: Literal["sponsor", "partner"] = "partner"
    kind: Literal[PARTNER_KINDS] = "other"
    evidence_quote: str = ""

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, value: Any) -> Any:
        return value if value in PARTNER_KINDS else "other"

    @field_validator("relation", mode="before")
    @classmethod
    def _relation(cls, value: Any) -> Any:
        return value if value in ("sponsor", "partner") else "partner"


class OrgExtraction(_Model):
    """What the model may say about one organisation. Every value is quoted."""

    is_about_organisation: bool = True
    short_description: QuotedText | None = None
    description: QuotedText | None = None
    how_to_join: QuotedText | None = None
    join_url: QuotedText | None = None
    membership: Membership | None = None
    beginner_friendly: QuotedBool | None = None
    trials: Trials | None = None
    time_commitment: QuotedText | None = None
    activity_types: list[ActivityType] = Field(default_factory=list)
    audiences: list[Audience] = Field(default_factory=list)
    languages: list[Language] = Field(default_factory=list)
    categories: list[Category] = Field(default_factory=list, max_length=3)
    tags: list[str] = Field(default_factory=list, max_length=8)
    sessions: list[Session] = Field(default_factory=list)
    termcard_url: QuotedText | None = None
    accessibility_note: QuotedText | None = None
    needs: list[NeedOffer] = Field(default_factory=list)
    offers: list[NeedOffer] = Field(default_factory=list)
    committee: list[Person] = Field(default_factory=list)
    sponsors_partners: list[Partner] = Field(default_factory=list)

    @field_validator("activity_types", mode="before")
    @classmethod
    def _activity(cls, value: Any) -> Any:
        return _in_vocab(value, ACTIVITY_TYPES)

    @field_validator("audiences", mode="before")
    @classmethod
    def _audiences(cls, value: Any) -> Any:
        return _in_vocab(value, AUDIENCES)

    @field_validator("categories", mode="before")
    @classmethod
    def _categories(cls, value: Any) -> Any:
        return _in_vocab(value, CATEGORIES)[:3]

    @field_validator("needs", "offers", mode="before")
    @classmethod
    def _need_offer(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        return [v for v in value if isinstance(v, dict) and v.get("item") in NEED_OFFER_ITEMS]

    @field_validator("tags", mode="before")
    @classmethod
    def _tags(cls, value: Any) -> Any:
        return [tag for tag in value if isinstance(tag, str)][:8] if isinstance(value, list) else []


# --- the prompt -------------------------------------------------------------------------


@dataclass(frozen=True)
class PromptPage:
    kind: str
    url: str
    text: str


#: SU category (data-model §5) → our categories it maps onto.
SU_CATEGORY_HINTS: dict[str, tuple[str, ...]] = {
    "academic life": ("academic", "science_tech"),
    "skills & professional development": (
        "careers_professional",
        "entrepreneurship",
        "science_tech",
    ),
    "creative & media": ("arts_creative", "music", "theatre_film_dance", "media_publishing"),
    "cultural & faith": ("cultural_international", "faith", "identity_wellbeing"),
    "political & causes": ("politics_debate", "causes_volunteering"),
    "hobbies & interests": ("hobbies_games", "identity_wellbeing"),
    "sports & activities": ("sport", "outdoors"),
}


def budget_pages(pages: list[PromptPage], budget: int = TEXT_BUDGET) -> list[PromptPage]:
    """Cut each page's text to its share of `budget`, giving what short pages
    leave over to the longer ones."""
    shares = {i: PAGE_SHARE.get(page.kind, 1_000) for i, page in enumerate(pages)}
    total = sum(shares.values()) or 1
    allowance = {i: budget * share / total for i, share in shares.items()}
    spare = sum(max(0.0, allowance[i] - len(page.text)) for i, page in enumerate(pages))
    hungry = [i for i, page in enumerate(pages) if len(page.text) > allowance[i]]
    out: list[PromptPage] = []
    for i, page in enumerate(pages):
        limit = allowance[i] + (spare / len(hungry) if i in hungry else 0)
        out.append(PromptPage(page.kind, page.url, _cut(page.text, int(limit))))
    return out


def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind("\n")
    if space < limit * 0.8:
        space = cut.rfind(" ")
    return cut[: space if space > limit * 0.5 else limit].rstrip()


def render_prompt(
    *,
    name: str,
    context: list[str],
    pages: list[PromptPage],
    links: list[tuple[str, str]],
    su_category: str | None = None,
) -> str:
    template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
    hint = ""
    if su_category:
        mapped = SU_CATEGORY_HINTS.get(su_category.strip().lower())
        hint = f' The Cambridge SU files it under "{su_category}"'
        hint += f" (usually {', '.join(mapped)})." if mapped else "."
    blocks = [
        f"=== PAGE {number}: {page.kind} | {page.url} ===\n{page.text or '(no text)'}"
        for number, page in enumerate(budget_pages(pages), start=1)
    ]
    link_lines = [f"- [{text or 'link'}]({url})" for text, url in links[:MAX_LINKS]]
    return template.safe_substitute(
        name=name,
        context="\n".join(context) or "(nothing else is known)",
        category_hint=hint,
        pages="\n\n".join(blocks),
        links="\n".join(link_lines) or "(none)",
    )


# --- the call ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OrgCall:
    extraction: OrgExtraction
    model: str
    prompt_version: str
    cached: bool
    seconds: float


def extract_org(client: LLMClient, prompt: str, *, cache_dir: Path | None = None) -> OrgCall:
    """Run the extraction (bulk model), or return the cached result for the
    identical prompt. Raises `LLMValidationError` / transport errors as the
    client does."""
    model = client.model_for("bulk")
    digest = hashlib.sha256(f"{model}\n{PROMPT_VERSION}\n{prompt}".encode()).hexdigest()
    path = cache_dir / "llm" / PROMPT_VERSION / f"{digest}.json" if cache_dir else None
    if path is not None and path.exists():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            extraction = OrgExtraction.model_validate(cached["extraction"])
            return OrgCall(extraction, cached["model"], PROMPT_VERSION, True, 0.0)
        except (OSError, ValueError, KeyError) as error:
            logger.warning("Ignoring unreadable LLM cache %s: %s", path, error)
    started = time.monotonic()
    call = client.complete_json(
        schema=OrgExtraction,
        messages=[{"role": "user", "content": prompt}],
        prompt_version=PROMPT_VERSION,
        tier="bulk",
    )
    seconds = time.monotonic() - started
    if path is not None:
        payload = {"model": call.model, "extraction": call.value.model_dump(mode="json")}
        write_json_atomic(path, payload)
    return OrgCall(call.value, call.model, PROMPT_VERSION, False, seconds)


__all__ = [
    "DAYS",
    "PROMPT_VERSION",
    "SU_CATEGORY_HINTS",
    "TEXT_BUDGET",
    "OrgCall",
    "OrgExtraction",
    "PromptPage",
    "budget_pages",
    "extract_org",
    "render_prompt",
]
