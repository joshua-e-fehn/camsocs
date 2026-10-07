"""The org_v1 extraction model and prompt: tolerant of vocabulary slips,
budgeted text, and a loaded-merge of the broker profiles it produces."""

from __future__ import annotations

from camsocs_pipeline.extract.org import (
    PROMPT_VERSION,
    TEXT_BUDGET,
    OrgExtraction,
    PromptPage,
    budget_pages,
    render_prompt,
)
from camsocs_pipeline.models.wire import BrokerProfileInput, InferredItem
from camsocs_pipeline.pipeline.load import _merge_profiles


def test_items_outside_our_vocabularies_are_dropped_not_fatal() -> None:
    extraction = OrgExtraction.model_validate(
        {
            "categories": [
                {"value": "sport"},
                {"value": "technology"},
                {"value": "music"},
                {"value": "faith"},
                {"value": "academic"},
            ],
            "activity_types": [{"value": "talks"}, {"value": "parties"}],
            "needs": [{"item": "sponsorship"}, {"item": "money"}],
            "sessions": [{"title": "Training", "day": "Wednesday", "term_scope": "always"}],
            "membership": {"tiers": [{"label": "Annual", "price_pence": 1500, "period": "yearly"}]},
            "sponsors_partners": [{"name": "Acme", "relation": "funder", "kind": "bank"}],
            "something_new": True,
        }
    )
    assert [c.value for c in extraction.categories] == ["sport", "music", "faith"]
    assert [a.value for a in extraction.activity_types] == ["talks"]
    assert [n.item for n in extraction.needs] == ["sponsorship"]
    assert extraction.sessions[0].day == "wednesday"
    assert extraction.sessions[0].term_scope is None
    assert extraction.membership.tiers[0].period == "year"
    assert (extraction.sponsors_partners[0].relation, extraction.sponsors_partners[0].kind) == (
        "partner",
        "other",
    )


def test_page_text_is_budgeted_and_short_pages_give_way() -> None:
    pages = [
        PromptPage("home", "https://x.org/", "h" * 20_000),
        PromptPage("about", "https://x.org/about", "a" * 300),
        PromptPage("join", "https://x.org/join", "j" * 20_000),
    ]
    cut = budget_pages(pages)
    assert sum(len(page.text) for page in cut) <= TEXT_BUDGET + 10
    assert cut[1].text == "a" * 300
    assert len(cut[0].text) > len(cut[2].text) > 1_000


def test_the_prompt_carries_pages_links_and_the_su_hint() -> None:
    prompt = render_prompt(
        name="CU German Society",
        context=["Level: university"],
        pages=[PromptPage("home", "https://cugs.org/", "Wir sprechen Deutsch. $notavariable")],
        links=[("Join us", "https://forms.gle/x")],
        su_category="Cultural & Faith",
    )
    assert "=== PAGE 1: home | https://cugs.org/ ===" in prompt
    assert "$notavariable" in prompt
    assert "- [Join us](https://forms.gle/x)" in prompt
    assert 'The Cambridge SU files it under "Cultural & Faith"' in prompt
    assert PROMPT_VERSION == "org_v1"


def test_one_broker_profile_per_organisation_reaches_the_server() -> None:
    def item(name: str, url: str) -> InferredItem:
        return InferredItem(item=name, source_url=url, method="llm")

    merged = _merge_profiles(
        [
            BrokerProfileInput(org_key="org-a", needs=[item("sponsorship", "https://a.org/")]),
            BrokerProfileInput(
                org_key="org-a",
                needs=[item("sponsorship", "https://a.org/s"), item("speakers", "https://a.org/s")],
                offers=[item("co_hosting", "https://a.org/p")],
            ),
            BrokerProfileInput(org_key="org-b", offers=[item("venue", "https://b.org/")]),
        ]
    )
    assert [p.org_key for p in merged] == ["org-a", "org-b"]
    a = merged[0]
    assert [(n.item, n.source_url) for n in a.needs] == [
        ("sponsorship", "https://a.org/"),
        ("speakers", "https://a.org/s"),
    ]
    assert [o.item for o in a.offers] == ["co_hosting"]
