"""Classification (R2): type, level and the facets of every listed organisation.

After enrichment, every keyed organisation in staging is classified on what
sources have not said: ``orgType``, ``level`` and ``collegeKeys`` of a
registered society, ``categories`` (our 16, at most three),
``activityTypes``, ``audiences``, ``languages`` and ``tags``.

1. **Sources first.** A field any source claims (a register, Camdram, CUCBC,
   a college list, the website enrichment) is left alone.
2. **Rules next** (`rules.py`): deterministic, ``inferred`` parser claims on
   the record the rule read — a registered society is a University-level
   society unless its name names a college or a department; a sport, a
   religion, a country, an ensemble, drama / film / dance or a publication in
   the name gives the category; a sports club trains and competes.
3. **The model for the rest** (`llm.py`, prompt ``classify_v1``): what is
   still missing, from the organisation's own texts (its SU profile, its
   Camdram or Sport page, the registers' names), each value with a verbatim
   quote — ``found`` only when every quote is on a text, else ``inferred``.
   Names that may be something other than a society (a journal, a trust, a
   chaplaincy) are asked their type and level too; a quoted answer replaces
   the rule's.

Claims are attributed to the record they were read from (the SU directory
entry, the SU profile, the Camdram page …), as keyed observations staged in
that source's directory under the part ``classify``; `load` posts them.

**Every reading is restated.** A value this stage claimed last run and does
not claim now (a source now states it, a rule no longer applies) gets a
``missing`` / ``not_found`` claim from the same record and method, so the
older reading is superseded rather than left to conflict (data-model §1
rule 1). The model's readings are restated only for organisations it
answered (or no longer needs to): a run without a model, or a failed call,
retracts nothing it said before.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from camsocs_pipeline.claims import missing_field, parser_field
from camsocs_pipeline.classify.llm import (
    Answer,
    ClassifyStats,
    OrgRequest,
    OrgText,
    claims_for,
    classify_all,
)
from camsocs_pipeline.classify.profile import CLASSIFIED_FIELDS, OrgProfile, profiles_from
from camsocs_pipeline.classify.rules import (
    SOCIETY_REGISTERS,
    ambiguous_type,
    rule_claims,
)
from camsocs_pipeline.extract.ai_gate import AiGate
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.models.observation import FieldObs, Observation

#: The staging part the classify stage writes (and never reads back as a source).
PART = "classify"
#: Fields the model is asked for (orgType / level only for `ambiguous_type`).
LLM_FIELDS = ("categories", "activityTypes", "audiences", "languages", "tags")
#: A model call is worth making when one of these is still missing.
TRIGGER_FIELDS = ("categories", "activityTypes", "tags")
_REGISTER_LABELS = {
    "su": "Cambridge SU",
    "proctors": "the Proctors",
    "sportsService": "the Sports Service",
    "camdram": "Camdram",
    "cucbc": "CUCBC",
}
_TEXT_LABELS = {
    "su_profile": "SU profile",
    "camdram": "Camdram page",
    "sport_club_page": "Sport Cambridge page",
    "su_directory": "SU directory entry",
    "proctors_register": "Proctors' register entry",
    "sport_az": "Sport Cambridge A-Z entry",
    "cucbc": "CUCBC entry",
}

_RecordKey = tuple[str, str, str, str]


def _record_key(entity_key: str, record: Observation) -> _RecordKey:
    return (entity_key, record.source_type, record.source_key, record.source_url)


def _evidence_of(record: Observation) -> str:
    kinds = {obs.evidence for obs in record.fields}
    return "primary" if kinds == {"primary"} else "secondary"


@dataclass
class ClassifyResult:
    """What one classification pass produced."""

    #: Keyed observations to stage, one per (organisation, source record).
    records: list[Observation]
    #: Counts for the stage report.
    counts: dict[str, int] = field(default_factory=dict)
    llm: ClassifyStats | None = None


class _Output:
    def __init__(self) -> None:
        self._records: dict[_RecordKey, Observation] = {}

    def add(self, entity_key: str, record: Observation, obs: FieldObs) -> None:
        key = _record_key(entity_key, record)
        out = self._records.get(key)
        if out is None:
            out = Observation(
                source_type=record.source_type,
                source_key=record.source_key,
                source_url=record.source_url,
                retrieved_at=record.retrieved_at,
                content_sha256=record.content_sha256,
                fetch=record.fetch,
                entity_type="organisation",
                identity=record.identity.model_copy(update={"known_key": entity_key}),
                entity_key=entity_key,
            )
            self._records[key] = out
        out.fields.append(obs)

    def claimed(self, key: _RecordKey) -> set[tuple[str, str]]:
        out = self._records.get(key)
        return {(obs.field, obs.method) for obs in out.fields} if out else set()

    def records(self) -> list[Observation]:
        return [self._records[key] for key in sorted(self._records)]


@dataclass
class _Plan:
    profile: OrgProfile
    rules: list
    wanted: set[str]
    request: OrgRequest | None


def _request(
    profile: OrgProfile, wanted: set[str], ask_type: bool, gate: AiGate | None = None
) -> OrgRequest:
    texts = [
        OrgText(record, _TEXT_LABELS.get(record.source_type, record.source_type), text)
        for record, text in profile.texts()
        # A general source whose host or page keeps AI out is never sent
        # (`extract.ai_gate`); a society's own content is (D3).
        if gate is None or gate.allows(record.source_url, record.source_type)
    ]
    registers = [
        label for register, label in _REGISTER_LABELS.items() if profile.registered(register)
    ]
    names = profile.names
    return OrgRequest(
        key=profile.key,
        name=profile.name,
        other_names=[name for name in names if name != profile.name],
        su_category=profile.su_category,
        registers=registers,
        texts=texts,
        ask_type=ask_type,
    )


def classify_records(
    records: Iterable[object],
    previous: Iterable[object] = (),
    *,
    llm: LLMClient | None = None,
    memo: LLMMemo | None = None,
    workers: int = 1,
    gate: AiGate | None = None,
) -> ClassifyResult:
    """Classify every listed organisation in `records` (module docstring).
    `records`: every keyed observation in staging but this stage's own;
    `previous`: this stage's last output, for restating."""
    profiles = profiles_from(records)
    college_keys = {key for key, profile in profiles.items() if "college" in profile.org_types}
    counts: dict[str, int] = {}

    def count(name: str, by: int = 1) -> None:
        counts[name] = counts.get(name, 0) + by

    plans: list[_Plan] = []
    for profile in profiles.values():
        if profile.counterpart or profile.defunct:
            continue
        count("organisations")
        rules = rule_claims(profile, college_keys=college_keys)
        covered = {name for name in CLASSIFIED_FIELDS if profile.has(name)}
        covered |= {rule.field for rule in rules}
        wanted = set(LLM_FIELDS) - covered
        registered = any(profile.registered(r) for r in SOCIETY_REGISTERS)
        ask_type = registered and not profile.has("orgType") and ambiguous_type(profile)
        if ask_type:
            wanted.add("orgType")
            if not profile.has("level"):
                wanted.add("level")
        needs_model = ask_type or bool(wanted & set(TRIGGER_FIELDS))
        request = _request(profile, wanted, ask_type, gate) if needs_model else None
        if request is not None and not request.texts:
            request = None
        plans.append(_Plan(profile, rules, wanted, request))

    answers: dict[str, Answer] = {}
    stats: ClassifyStats | None = None
    requests = [plan.request for plan in plans if plan.request is not None]
    if llm is not None and requests:
        answers, stats = classify_all(llm, requests, memo=memo, workers=workers)
    count("model_requests", len(requests))

    out = _Output()
    #: Organisations whose model readings may be restated this run.
    model_settled: set[str] = set()
    for plan in plans:
        key = plan.profile.key
        answer = answers.get(key)
        if plan.request is None or answer is not None:
            model_settled.add(key)
        from_model = (
            claims_for(answer, plan.request, plan.wanted)
            if answer is not None and plan.request is not None
            else None
        )
        model_fields = from_model.fields() if from_model else set()
        for rule in plan.rules:
            if rule.field in ("orgType", "level") and rule.field in model_fields:
                continue  # the model's quoted answer replaces the rule's
            out.add(
                key,
                rule.record,
                parser_field(
                    rule.field,
                    rule.value,
                    extractor=rule.extractor,
                    evidence=_evidence_of(rule.record),
                    value_raw=rule.value_raw,
                    inferred=True,
                ),
            )
            count(f"rule:{rule.field}")
        if from_model is not None:
            for record, items in from_model.by_record.values():
                for obs in items:
                    out.add(key, record, obs)
                    count(f"model:{obs.field}")
    count("restated", _restate(out, previous, model_settled))
    return ClassifyResult(out.records(), dict(sorted(counts.items())), stats)


def _restate(out: _Output, previous: Iterable[object], model_settled: set[str]) -> int:
    """A ``not_found`` claim for every value the last run claimed that this
    run does not, on the same record with the same method (module
    docstring). Returns how many."""
    restated = 0
    for record in previous:
        if not isinstance(record, Observation) or not record.entity_key:
            continue
        key = _record_key(record.entity_key, record)
        claimed = out.claimed(key)
        for obs in record.fields:
            if obs.value is None or (obs.field, obs.method) in claimed:
                continue
            if obs.method == "llm" and record.entity_key not in model_settled:
                continue
            absent = missing_field(
                obs.field, "not_found", extractor=obs.extractor, evidence=obs.evidence,
                method=obs.method,
            )  # fmt: skip
            absent.prompt_version = obs.prompt_version
            out.add(record.entity_key, record, absent)
            claimed.add((obs.field, obs.method))
            restated += 1
    return restated


__all__ = ["LLM_FIELDS", "PART", "ClassifyResult", "classify_records"]
