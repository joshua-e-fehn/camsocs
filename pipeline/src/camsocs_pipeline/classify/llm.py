"""The model's pass: classifying organisations no rule or source classified,
from their own texts (prompt ``classify_v1``, bulk model).

Several organisations go in one call (`BATCH_SIZE`); each one's answer is
cached on its own (`extract.memo`, keyed by model, prompt version and that
organisation's block), so a changed description re-asks only for it. The
model reports values with verbatim quotes; nothing here decides what is
true — `claims_for` checks every quote against the organisation's texts
(`claims.llm_items_field` / `llm_field`): a list is ``found`` only when
every item's quote is there, otherwise ``inferred``; tags are never quoted,
so always ``inferred``.

Only text the organisation itself published reaches the model (its SU
profile, its Camdram or Sport page, the registers' names), never a value
another model wrote, and never content from a host that keeps AI out
(`extract.llm.assert_llm_source_allowed`: talks.cam, tbc.xyz).
"""

from __future__ import annotations

import logging
import re
import time
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from camsocs_pipeline.claims import llm_field, llm_items_field
from camsocs_pipeline.extract.evidence import EvidenceMatch, check_quote
from camsocs_pipeline.extract.llm import (
    LLMClient,
    LLMValidationError,
    assert_llm_source_allowed,
)
from camsocs_pipeline.extract.memo import LLMMemo, memo_key
from camsocs_pipeline.extract.org import SU_CATEGORY_HINTS
from camsocs_pipeline.models.observation import FieldObs, Observation
from camsocs_pipeline.models.vocab import ACTIVITY_TYPES, AUDIENCES, CATEGORIES, ORG_LEVELS

logger = logging.getLogger(__name__)

PROMPT_VERSION = "classify_v1"
PROMPT_PATH = Path(__file__).parent.parent / "extract" / "prompts" / f"{PROMPT_VERSION}.md"
#: Organisations per call.
BATCH_SIZE = 8
#: Types the model may give a registered society (never a counterpart type:
#: a group the SU registers is listed, whatever it is).
LLM_ORG_TYPES = ("society", "media", "other")
MAX_TAGS = 6
_KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _in_vocab(items: Any, values: tuple[str, ...]) -> list[Any]:
    """The items whose ``value`` is in the vocabulary; a bare string is an
    item without a quote. Anything else is dropped, item by item."""
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        if isinstance(item, str):
            item = {"value": item}
        if isinstance(item, dict) and item.get("value") in values:
            out.append(item)
    return out


class Quoted(_Model):
    value: str
    evidence_quote: str = ""

    @field_validator("evidence_quote", mode="before")
    @classmethod
    def _quote(cls, value: Any) -> Any:
        return "" if value is None else value


class Classification(_Model):
    """One organisation's answer."""

    id: str
    categories: list[Quoted] = Field(default_factory=list)

    @field_validator("id", mode="before")
    @classmethod
    def _id(cls, value: Any) -> Any:
        return str(value) if isinstance(value, int) else value

    activity_types: list[Quoted] = Field(default_factory=list)
    audiences: list[Quoted] = Field(default_factory=list)
    languages: list[Quoted] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    org_type: Quoted | None = None
    level: Quoted | None = None

    @field_validator("categories", mode="before")
    @classmethod
    def _categories(cls, value: Any) -> Any:
        return _in_vocab(value, CATEGORIES)[:3]

    @field_validator("activity_types", mode="before")
    @classmethod
    def _activity(cls, value: Any) -> Any:
        return _in_vocab(value, ACTIVITY_TYPES)

    @field_validator("audiences", mode="before")
    @classmethod
    def _audiences(cls, value: Any) -> Any:
        return _in_vocab(value, AUDIENCES)

    @field_validator("languages", mode="before")
    @classmethod
    def _languages(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        return [
            {**item, "value": item["value"].lower()}
            for item in value
            if isinstance(item, dict)
            and isinstance(item.get("value"), str)
            and re.fullmatch(r"[A-Za-z]{2}", item["value"])
        ]

    @field_validator("tags", mode="before")
    @classmethod
    def _tags(cls, value: Any) -> Any:
        if not isinstance(value, list):
            return []
        tags = [tag.strip().lower() for tag in value if isinstance(tag, str)]
        return [tag for tag in tags if _KEBAB.match(tag) and len(tag) <= 40][:MAX_TAGS]

    @field_validator("org_type", mode="before")
    @classmethod
    def _org_type(cls, value: Any) -> Any:
        return value if isinstance(value, dict) and value.get("value") in LLM_ORG_TYPES else None

    @field_validator("level", mode="before")
    @classmethod
    def _level(cls, value: Any) -> Any:
        return value if isinstance(value, dict) and value.get("value") in ORG_LEVELS else None


class ClassifyReply(_Model):
    organisations: list[Classification] = Field(default_factory=list)


# --- the request ------------------------------------------------------------------------


@dataclass(frozen=True)
class OrgText:
    """One text the model may quote, and the record it is attributed to."""

    record: Observation
    label: str
    text: str


@dataclass
class OrgRequest:
    """What the model is told about one organisation."""

    key: str
    name: str
    other_names: list[str]
    su_category: str | None
    registers: list[str]
    texts: list[OrgText]
    #: Ask for org_type and level (a registered society whose name may say
    #: it is something else: `rules.ambiguous_type`).
    ask_type: bool = False

    def block(self, ident: str) -> str:
        lines = [f"## id: {ident}", f"Name: {self.name}"]
        if self.other_names:
            lines.append(f"Also called: {', '.join(self.other_names[:5])}")
        if self.registers:
            lines.append(f"Registered with: {', '.join(self.registers)}")
        if self.su_category:
            mapped = SU_CATEGORY_HINTS.get(self.su_category.strip().lower())
            hint = f" (usually {', '.join(mapped)})" if mapped else ""
            lines.append(f"SU category: {self.su_category}{hint}")
        lines.append(f"type question: {'yes' if self.ask_type else 'no'}")
        for text in self.texts:
            lines.append(f"[{text.label}]\n{text.text}")
        return "\n".join(lines)

    def memo_key(self, model: str) -> str:
        return memo_key(model, PROMPT_VERSION, self.block("-"))


def render_prompt(requests: Sequence[tuple[str, OrgRequest]]) -> str:
    template = Template(PROMPT_PATH.read_text(encoding="utf-8"))
    blocks = [request.block(ident) for ident, request in requests]
    return template.safe_substitute(organisations="\n\n".join(blocks))


@dataclass
class ClassifyStats:
    calls: int = 0
    cached: int = 0
    failed: int = 0
    answered: int = 0
    missing: int = 0
    seconds: float = 0.0


@dataclass
class Answer:
    classification: Classification
    model: str
    cached: bool = False


def classify_all(
    client: LLMClient,
    requests: Sequence[OrgRequest],
    *,
    memo: LLMMemo | None,
    workers: int = 1,
    batch_size: int = BATCH_SIZE,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[dict[str, Answer], ClassifyStats]:
    """Each request's answer by organisation key (cached ones first, the
    rest asked in batches), and what it cost. A batch whose reply never
    validates leaves its organisations unanswered (retried next run)."""
    stats = ClassifyStats()
    model = client.model_for("bulk")
    answers: dict[str, Answer] = {}
    pending: list[OrgRequest] = []
    for request in requests:
        for text in request.texts:
            assert_llm_source_allowed(text.record.source_url)
        found = memo.get(PROMPT_VERSION, request.memo_key(model), Classification) if memo else None
        if found is not None:
            answers[request.key] = Answer(found[0], found[1], cached=True)
            stats.cached += 1
        else:
            pending.append(request)
    batches = [pending[i : i + batch_size] for i in range(0, len(pending), batch_size)]

    def ask(batch: list[OrgRequest]) -> tuple[list[OrgRequest], ClassifyReply | None, float]:
        idents = [(f"o{number}", request) for number, request in enumerate(batch, start=1)]
        started = clock()
        try:
            call = client.complete_json(
                schema=ClassifyReply,
                messages=[{"role": "user", "content": render_prompt(idents)}],
                prompt_version=PROMPT_VERSION,
                tier="bulk",
            )
        except LLMValidationError as error:
            logger.warning("Classification batch failed validation: %s", error)
            return batch, None, clock() - started
        return batch, call.value, clock() - started

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for batch, reply, seconds in pool.map(ask, batches):
            stats.calls += 1
            stats.seconds += seconds
            if reply is None:
                stats.failed += len(batch)
                continue
            by_id = {item.id.strip(): item for item in reply.organisations}
            for number, request in enumerate(batch, start=1):
                item = by_id.get(f"o{number}")
                if item is None:
                    stats.missing += 1
                    continue
                answers[request.key] = Answer(item, model)
                stats.answered += 1
                if memo is not None:
                    memo.put(PROMPT_VERSION, request.memo_key(model), item, model)
    return answers, stats


# --- the answer as claims -----------------------------------------------------------------


def _evidence_of(record: Observation) -> str:
    kinds = {obs.evidence for obs in record.fields}
    return "primary" if kinds == {"primary"} else "secondary"


@dataclass
class ClaimsFor:
    """The claims one answer yields, by the record each is attributed to."""

    by_record: dict[int, tuple[Observation, list[FieldObs]]] = field(default_factory=dict)

    def add(self, record: Observation, obs: FieldObs) -> None:
        self.by_record.setdefault(id(record), (record, []))[1].append(obs)

    def fields(self) -> set[str]:
        return {obs.field for _record, items in self.by_record.values() for obs in items}


def _locate(texts: Sequence[OrgText], quote: str | None) -> tuple[OrgText | None, EvidenceMatch]:
    best: tuple[OrgText, EvidenceMatch] | None = None
    for text in texts:
        match = check_quote(quote, text.text)
        if match is EvidenceMatch.EXACT:
            return text, match
        if match is EvidenceMatch.NORMALISED and best is None:
            best = (text, match)
    return best or (None, EvidenceMatch.ABSENT)


def claims_for(answer: Answer, request: OrgRequest, wanted: set[str]) -> ClaimsFor:
    """The `wanted` fields of one answer as LLM field claims on the records
    holding their quotes (module docstring). ``orgType`` / ``level`` only
    when their quote is on a text: the rule's value stands otherwise."""
    out = ClaimsFor()
    if not request.texts:
        return out
    primary = request.texts[0]
    every_text = [text.text for text in request.texts]
    item = answer.classification

    def common(record: Observation) -> dict[str, Any]:
        return {
            "source_type": record.source_type,
            "model": answer.model,
            "prompt_version": PROMPT_VERSION,
            "evidence": _evidence_of(record),
        }

    for name, items in (
        ("categories", item.categories),
        ("activityTypes", item.activity_types),
        ("audiences", item.audiences),
        ("languages", item.languages),
    ):
        if name not in wanted or not items:
            continue
        pairs = [(quoted.value, quoted.evidence_quote) for quoted in items]
        votes = Counter(
            located.label
            for located, _match in (_locate(request.texts, quote) for _value, quote in pairs)
            if located is not None
        )
        target = (
            next(text for text in request.texts if text.label == votes.most_common(1)[0][0])
            if votes
            else primary
        )
        out.add(
            target.record,
            llm_items_field(name, pairs, source_texts=every_text, **common(target.record)),
        )
    if "tags" in wanted and item.tags:
        out.add(
            primary.record,
            llm_field("tags", item.tags, quote=None, source_text="", **common(primary.record)),
        )
    for name, quoted in (("orgType", item.org_type), ("level", item.level)):
        if name not in wanted or quoted is None:
            continue
        located, match = _locate(request.texts, quoted.evidence_quote)
        if located is None or match is EvidenceMatch.ABSENT:
            continue
        out.add(
            located.record,
            llm_field(
                name,
                quoted.value,
                quote=quoted.evidence_quote,
                source_text=located.text,
                **common(located.record),
            ),
        )
    return out


__all__ = [
    "BATCH_SIZE",
    "LLM_ORG_TYPES",
    "PROMPT_VERSION",
    "Answer",
    "Classification",
    "ClassifyReply",
    "ClassifyStats",
    "OrgRequest",
    "OrgText",
    "claims_for",
    "classify_all",
    "render_prompt",
]
