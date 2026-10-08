"""`ExtractionMapper` (sources/websites/mapping.py): what an LLM reading of a
site may claim, and with which status — offline, no network, no model."""

from __future__ import annotations

from typing import Any

from camsocs_pipeline.extract.org import OrgCall, OrgExtraction
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.websites.mapping import ExtractionMapper
from camsocs_pipeline.sources.websites.page import parse_page
from camsocs_pipeline.sources.websites.site import Fetched, SiteRecords, Target, TargetResult

HOME = "https://chess.example.org/"
ABOUT = "https://chess.example.org/about"


def page(kind: str, url: str, text: str) -> Fetched:
    result = FetchResult(
        url=url,
        final_url=url,
        outcome="fetched",
        status=200,
        fetched_at="2026-10-07T12:00:00+00:00",
        content=f"<html><body><main>{text}</main></body></html>".encode(),
        content_type="text/html",
    )
    return Fetched(kind, result, parse_page(url, result.text))


def run(reply: dict[str, Any], pages: list[Fetched] | None = None) -> dict[str, dict[str, Any]]:
    """field → {url: obs} for every claim the mapper made."""
    pages = pages or [
        page(
            "home",
            HOME,
            "The Chess Club meets on Tuesdays in the Old Library. Beginners welcome.",
        ),
        page(
            "about",
            ABOUT,
            "Membership costs £10. Trials open on 4th October and close at "
            "various times before 17th October.",
        ),
    ]
    target = Target(key="org-chess", name="Chess Club", website=HOME)
    buckets = SiteRecords(target, "society_website")
    for fetched in pages:
        buckets.page(fetched)
    call = OrgCall(
        extraction=OrgExtraction.model_validate({"is_about_organisation": True, **reply}),
        model="bulk-model-1",
        prompt_version="org_v1",
        cached=False,
        seconds=0.0,
    )
    result = TargetResult(target)
    ExtractionMapper(target, pages, buckets, call, set(), [], result).map(call.extraction)
    out: dict[str, dict[str, Any]] = {}
    for record in buckets.records:
        for obs in record.fields:
            out.setdefault(obs.field, {})[record.source_url] = obs
    return out


def test_a_summary_the_model_wrote_is_inferred_even_with_a_verbatim_quote() -> None:
    claims = run(
        {
            "description": {
                "value": "The club runs weekly chess evenings for players of every level.",
                "evidence_quote": "The Chess Club meets on Tuesdays in the Old Library.",
            },
            "short_description": {
                "value": "The Chess Club meets on Tuesdays in the Old Library.",
                "evidence_quote": "The Chess Club meets on Tuesdays in the Old Library.",
            },
        }
    )
    description = claims["description"][HOME]
    assert description.quote_check == "exact" and description.status == "inferred"
    # Copied from the page: found.
    assert claims["shortDescription"][HOME].status is None


def test_every_llm_field_is_restated_on_every_page_read() -> None:
    claims = run(
        {
            "categories": [{"value": "hobbies_games", "evidence_quote": "The Chess Club meets"}],
        }
    )
    # The value on the page that holds its quote; not_found on the other page,
    # which replaces anything an older reading attributed there.
    assert claims["categories"][HOME].value == ["hobbies_games"]
    assert claims["categories"][ABOUT].missing_reason == "not_found"
    assert claims["audiences"][ABOUT].missing_reason == "not_found"
    assert claims["audiences"][HOME].method == "llm"


def test_a_value_withheld_for_naming_someone_is_not_published_not_absent() -> None:
    claims = run(
        {
            "committee": [
                {"name": "Jane Doe", "role": "President", "evidence_quote": "Beginners welcome."}
            ],
            "how_to_join": {
                "value": "Email Jane Doe to join.",
                "evidence_quote": "Beginners welcome.",
            },
        }
    )
    assert claims["howToJoin"][HOME].value is None
    assert claims["howToJoin"][HOME].missing_reason == "not_published"
    assert claims["howToJoin"][ABOUT].missing_reason == "not_found"


def test_membership_text_is_filtered_and_an_unstated_period_left_out() -> None:
    claims = run(
        {
            "committee": [
                {"name": "Jane Doe", "role": "Treasurer", "evidence_quote": "Beginners welcome."}
            ],
            "membership": {
                "tiers": [
                    {"label": "Membership", "price_pence": 1000, "period": "year"},
                    {"label": "Pay Jane Doe", "price_pence": 500, "period": "term"},
                    {"label": "Life", "price_pence": 3000, "period": "life", "note": "ask x@y.org"},
                ],
                "bursary_note": "Contact Jane Doe for help.",
                "evidence_quote": "Membership costs £10.",
            },
        }
    )
    membership = claims["membership"][ABOUT].value
    # "£10 membership" says no period: none is invented.
    assert membership["tiers"][0] == {"label": "Membership", "pricePence": 1000}
    # A label naming someone drops its tier; an address drops the note.
    assert [tier["label"] for tier in membership["tiers"]] == ["Membership", "Life"]
    assert membership["tiers"][1] == {"label": "Life", "period": "life", "pricePence": 3000}
    assert "bursaryNote" not in membership


def test_trial_dates_are_kept_as_written_never_cut() -> None:
    written = "open on 4th October and close at various times before 17th October"
    long_entry = "open on 4th October " + "and then again " * 10
    claims = run(
        {
            "trials": {
                "required": True,
                "dates": [written, long_entry],
                "evidence_quote": "Trials open on 4th October",
            }
        }
    )
    assert claims["trials"][ABOUT].value["dates"] == [written]
