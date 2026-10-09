"""Classification (R2): sources first, deterministic rules next, the model
with quotes for the rest — and every reading restated. Every society here is
fictional."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

import pytest

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.classify import PART, classify_records
from camsocs_pipeline.classify.llm import PROMPT_VERSION
from camsocs_pipeline.classify.profile import profiles_from
from camsocs_pipeline.classify.rules import (
    activity_rules,
    audience_rules,
    category_rules,
    college_in_name,
    type_and_level,
)
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.models.observation import FieldObs, IdentityHints, Observation
from camsocs_pipeline.pipeline.coverage import coverage, format_coverage
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.staging.store import RESOLVED, StagingStore
from tests.fakes import FakeLLM, invalid_reply

AT = datetime(2026, 10, 8, 2, 0, tzinfo=UTC)
COLLEGES = {"org-pembroke-college", "org-fitzwilliam-college"}
SU_DIRECTORY = "https://www.cambridgesu.co.uk/opportunities/societies/"


def record(
    source_type: str,
    key: str,
    name: str,
    *fields: FieldObs,
    source_key: str | None = None,
    url: str | None = None,
    **hints: Any,
) -> Observation:
    return Observation(
        source_type=source_type,
        source_key=source_key or key,
        source_url=url or f"https://{source_type.replace('_', '-')}.example/{key}",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name=name, known_key=key, **hints),
        entity_key=key,
        fields=[parser_field("name", name, extractor="test", evidence="primary"), *fields],
    )


def su_society(key: str, name: str, *, description: str | None = None) -> list[Observation]:
    """A society as the SU harvest stages it: directory entry and profile."""
    directory = record(
        "su_directory",
        key,
        name,
        parser_field(
            "registrations.su", {"registered": True}, extractor="test", evidence="primary"
        ),
        parser_field("suCategory", "Cultural & Faith", extractor="test", evidence="primary"),
        url=SU_DIRECTORY,
    )
    profile_fields = []
    if description:
        profile_fields.append(
            parser_field("description", description, extractor="test", evidence="primary")
        )
    profile = record("su_profile", key, name, *profile_fields)
    return [directory, profile]


def values(result, key: str) -> dict[str, list[FieldObs]]:
    out: dict[str, list[FieldObs]] = {}
    for staged in result.records:
        if staged.entity_key == key:
            for obs in staged.fields:
                out.setdefault(obs.field, []).append(obs)
    return out


# --- rules ---------------------------------------------------------------------------------


def test_a_registered_society_is_a_university_society_by_rule() -> None:
    result = classify_records(su_society("org-german-society", "German Society"))
    claims = values(result, "org-german-society")
    (org_type,) = claims["orgType"]
    (level,) = claims["level"]
    assert (org_type.value, org_type.status, org_type.method) == ("society", "inferred", "parser")
    assert (level.value, level.extractor) == ("university", "classify.registered_society")
    staged = next(r for r in result.records if r.entity_key == "org-german-society")
    assert (staged.source_type, staged.source_url) == ("su_directory", SU_DIRECTORY)
    assert claims["categories"][0].value == ["cultural_international"]


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Pembroke Art Society", ("college_club", "college", ["org-pembroke-college"])),
        ("Fitz Swing Band", ("college_club", "college", ["org-fitzwilliam-college"])),
        ("Fitzwilliam Museum Society", ("society", "university", None)),
        ("Faculty of Education Research Students' Association", ("society", "department", None)),
        ("Journal of Political Affairs (Cambridge)", ("media", "university", None)),
    ],
)
def test_type_and_level_from_the_name(name: str, expected: tuple) -> None:
    (profile,) = profiles_from(su_society("org-x", name)).values()
    claims = {claim.field: claim.value for claim in type_and_level(profile, college_keys=COLLEGES)}
    assert (claims["orgType"], claims["level"], claims.get("collegeKeys")) == expected
    assert college_in_name("Fitzwilliam Museum Society") is None


def test_a_source_that_states_a_field_is_never_overruled() -> None:
    club = [
        *su_society("org-hockey-club", "Hockey Club"),
        record(
            "sport_az",
            "org-hockey-club",
            "Cambridge University Hockey Club",
            parser_field("orgType", "sports_club", extractor="test", evidence="primary"),
            parser_field("level", "university", extractor="test", evidence="primary"),
            parser_field("categories", ["sport"], extractor="test", evidence="primary"),
            parser_field(
                "registrations.sportsService", {"registered": True}, extractor="t",
                evidence="primary",
            ),
        ),
    ]  # fmt: skip
    claims = values(classify_records(club), "org-hockey-club")
    assert "orgType" not in claims and "level" not in claims and "categories" not in claims
    (activity,) = claims["activityTypes"]
    assert activity.value == ["training", "competitions"]


@pytest.mark.parametrize(
    ("name", "categories"),
    [
        ("Cambridge University Islamic Society", ["faith"]),
        ("Kazakh Society", ["cultural_international"]),
        ("Muay Thai Society", ["sport"]),
        ("Indian Classical Music Society", ["cultural_international", "music"]),
        ("Cuban Salsa Society", ["theatre_film_dance"]),
        ("Quokka Appreciation Society", None),
    ],
)
def test_categories_a_name_states(name: str, categories: list[str] | None) -> None:
    (profile,) = profiles_from(su_society("org-x", name)).values()
    claims = category_rules(profile)
    assert (claims[0].value if claims else None) == categories


@pytest.mark.parametrize(
    ("name", "audiences"),
    [
        ("Black Postgraduate Society", ["postgraduates"]),
        ("Graduate Course in Medicine Society", None),
        ("Women in Law Society", None),
        ("Black Girls' Space", ["women"]),
        ("LGBT+ Society", ["lgbtq"]),
        ("Watersprite: The Cambridge International Student Film Festival", None),
    ],
)
def test_audiences_only_as_the_name_says(name: str, audiences: list[str] | None) -> None:
    (profile,) = profiles_from(su_society("org-x", name)).values()
    claims = audience_rules(profile)
    assert (claims[0].value if claims else None) == audiences


def test_a_theatre_company_performs() -> None:
    company = record(
        "camdram", "org-x", "Example Players",
        parser_field("orgType", "theatre_company", extractor="t", evidence="secondary"),
    )  # fmt: skip
    (profile,) = profiles_from([company]).values()
    (claim,) = activity_rules(profile)
    assert (claim.value, claim.record.source_type) == (["performances"], "camdram")


def test_counterparts_and_defunct_entries_are_not_classified() -> None:
    company = record(
        "society_website", "org-acme", "Acme Ltd",
        parser_field("isCounterpart", True, extractor="t", evidence="secondary"),
    )  # fmt: skip
    test_soc = [
        *su_society("org-test-soc", "Test Soc"),
        record(
            "manual", "org-test-soc", "Test Soc",
            FieldObs(field="defunct", value=True, method="manual", evidence="primary",
                     extractor="resolve-decisions"),
            url="manual:pipeline/resolve-decisions.json",
        ),
    ]  # fmt: skip
    result = classify_records([company, *test_soc])
    assert result.records == []
    assert result.counts.get("organisations", 0) == 0


# --- the model -----------------------------------------------------------------------------


def _reply(text: str, answers: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The fake model's answer: for every organisation block in the prompt
    whose name has an entry in `answers`."""
    out = []
    for ident, name in re.findall(r"## id: (o\d+)\nName: ([^\n]+)", text):
        if name in answers:
            out.append({"id": ident, **answers[name]})
    return {"organisations": out}


QUOKKA = "Quokka Appreciation Society"
QUOKKA_TEXT = "We meet weekly to watch quokka documentaries and run talks by zoologists."
ANSWERS = {
    QUOKKA: {
        "categories": [
            {"value": "hobbies_games", "evidence_quote": "watch quokka documentaries"},
            {"value": "science_tech", "evidence_quote": "talks by zoologists"},
        ],
        "activity_types": [{"value": "talks", "evidence_quote": "run talks by zoologists"}],
        "audiences": [{"value": "beginners", "evidence_quote": "absolute beginners welcome"}],
        "tags": ["quokkas", "Zoology", "not a tag!"],
        "languages": [{"value": "EN", "evidence_quote": ""}],
    },
    "Cambridge Quokka Review": {
        "org_type": {"value": "media", "evidence_quote": "a termly magazine"},
        "categories": [{"value": "media_publishing", "evidence_quote": "a termly magazine"}],
    },
}


def test_the_model_classifies_the_rest_with_checked_quotes(tmp_path) -> None:
    records = [
        *su_society("org-quokka", QUOKKA, description=QUOKKA_TEXT),
        *su_society("org-review", "Cambridge Quokka Review", description="A termly magazine."),
    ]  # fmt: skip
    llm = FakeLLM(lambda text, _tier: _reply(text, ANSWERS))
    memo = LLMMemo(tmp_path / "llm")
    result = classify_records(records, llm=llm, memo=memo)
    assert len(llm.calls) == 1 and llm.calls[0]["version"] == PROMPT_VERSION
    assert "type question: yes" in llm.calls[0]["text"]  # the review's name says "Review"

    quokka = values(result, "org-quokka")
    (categories,) = quokka["categories"]
    assert categories.value == ["hobbies_games", "science_tech"]
    assert (categories.method, categories.status, categories.quote_check) == ("llm", None, "exact")
    (audiences,) = quokka["audiences"]
    assert audiences.status == "inferred"  # its quote is on no text
    (tags,) = quokka["tags"]
    assert (tags.value, tags.status) == (["quokkas", "zoology"], "inferred")
    assert quokka["languages"][0].value == ["en"]
    profile_records = {r.source_type for r in result.records if r.entity_key == "org-quokka"}
    assert profile_records == {"su_directory", "su_profile"}

    review = values(result, "org-review")
    (org_type,) = review["orgType"]  # the model's quoted answer replaces the rule's
    assert (org_type.value, org_type.method, org_type.status) == ("media", "llm", None)

    # Cached per organisation: the next run asks nothing.
    again = FakeLLM(lambda text, _tier: _reply(text, ANSWERS))
    classify_records(records, llm=again, memo=memo)
    assert again.calls == []


def test_a_failed_call_claims_nothing_and_retracts_nothing() -> None:
    records = su_society("org-quokka", QUOKKA, description=QUOKKA_TEXT)
    first = classify_records(records, llm=FakeLLM(lambda text, _: _reply(text, ANSWERS)))
    assert "categories" in values(first, "org-quokka")

    failed = classify_records(records, first.records, llm=FakeLLM(lambda *_: invalid_reply()))
    assert failed.llm is not None and failed.llm.failed == 1
    assert "categories" not in values(failed, "org-quokka")
    offline = classify_records(records, first.records, llm=None)
    assert "categories" not in values(offline, "org-quokka")


def test_a_reading_no_longer_made_is_restated_as_not_found() -> None:
    records = su_society("org-german-society", "German Society")
    first = classify_records(records)
    (rule,) = values(first, "org-german-society")["categories"]
    assert rule.value == ["cultural_international"]

    # A website now categorises the society: the rule no longer claims, and
    # its earlier reading is superseded from the same record and method.
    enriched = record(
        "society_website", "org-german-society", "German Society",
        parser_field("categories", ["cultural_international", "academic"], extractor="t",
                     evidence="primary"),
    )  # fmt: skip
    second = classify_records([*records, enriched], first.records)
    (restated,) = values(second, "org-german-society")["categories"]
    assert (restated.value, restated.status, restated.missing_reason) == (
        None,
        "missing",
        "not_found",
    )
    assert (restated.method, restated.extractor) == ("parser", "classify.name_category")
    assert second.counts["restated"] == 1


# --- the stage -------------------------------------------------------------------------------


def test_the_stage_stages_claims_beside_their_sources_and_ignores_its_own(make_settings) -> None:
    settings = make_settings()
    store = StagingStore(settings.staging_dir)
    store.write(RESOLVED, "20261008T000000Z-aaaaaa", su_society("org-chess", "Chess Club"))
    report = run_sync(settings=settings, stages=["classify"], dry_run=True)
    assert report.ok, report.summary()
    (staged,) = store.read_latest_part("su_directory", PART)
    assert staged.entity_key == "org-chess" and staged.is_keyed
    assert {f.field for f in staged.fields} == {"orgType", "level"}
    assert any("LLM not configured" in note for note in report.stages[0].notes)

    # Its own output is not a source: a second run claims the same, restates nothing.
    again = run_sync(settings=settings, stages=["classify"], dry_run=True)
    assert again.ok
    assert not any("restated" in note for note in again.stages[0].notes)
    assert {f.field for f in store.read_latest_part("su_directory", PART)[0].fields} == {
        "orgType",
        "level",
    }


# --- the offline coverage report ----------------------------------------------------------


def test_coverage_counts_listed_organisations_and_found_values() -> None:
    records = [
        *su_society("org-german-society", "German Society"),
        record(
            "society_website", "org-acme", "Acme Ltd",
            parser_field("isCounterpart", True, extractor="t", evidence="secondary"),
        ),
    ]  # fmt: skip
    before = coverage(records)
    assert (before.listed, before.counterparts, before.untyped) == (1, 1, 1)
    after = coverage([*records, *classify_records(records).records])
    assert (after.untyped, after.with_value["orgType"], after.found["orgType"]) == (0, 1, 0)
    assert after.with_value["categories"] == 1
    table = format_coverage(after, before)
    assert table[0].split() == ["before", "now"]
    assert any(line.startswith("orgType") for line in table)
