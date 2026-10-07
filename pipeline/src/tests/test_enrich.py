"""Website / Linktree enrichment (T5) end to end, offline: recorded pages
behind respx, the LLM mocked with canned replies whose quotes are partly
verbatim and partly not, so every honesty rule is exercised."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import respx
from pydantic import SecretStr

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.config import LLMSettings
from camsocs_pipeline.extract.llm import LLMClient
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.pipeline.context import Stage
from camsocs_pipeline.pipeline.load import plan_observations
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.base import PoliteClient
from camsocs_pipeline.sources.websites.enrich import Enricher, Target, TargetResult, targets_from
from camsocs_pipeline.staging.store import RESOLVED, StagingStore

FIXTURES = Path(__file__).parent / "fixtures" / "websites"
LLM_BASE = "http://llm.test/v1"
UA = "camsocs-test/0.1 (+https://example.org/camsocs)"
AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
CUATS = "https://www.cuats.co.uk"


def completion(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 0,
            "model": "bulk-model-1",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": json.dumps(payload)},
                }
            ],
        },
    )


def llm_client() -> LLMClient:
    settings = LLMSettings(
        base_url=LLM_BASE,
        api_key=SecretStr("k"),
        model_bulk="bulk-model-1",
        model_strong="strong-model-1",
        concurrency=2,
    )
    return LLMClient(settings, sleep=lambda _s: None)


def polite(tmp_path: Path) -> PoliteClient:
    return PoliteClient(
        user_agent=UA,
        cache_dir=tmp_path / "cache",
        min_interval=0.0,
        max_retries=0,
        sleep=lambda _s: None,
    )


def html(body: str, status: int = 200) -> httpx.Response:
    return httpx.Response(status, text=body, headers={"content-type": "text/html; charset=utf-8"})


CUATS_REPLY: dict[str, Any] = {
    "is_about_organisation": True,
    "short_description": {
        "value": "The first student society in Cambridge to promote the understanding of "
        "algorithms and their applications in financial trading.",
        "evidence_quote": "is the first student society in Cambridge to promote the "
        "understanding of algorithms and their applications in financial trading",
    },
    # A paraphrase, not on the page: kept, but only as `inferred`.
    "how_to_join": {
        "value": "Register through the society's online form.",
        "evidence_quote": "Sign up through our online registration portal",
    },
    # Names a committee member: never stored in a public field.
    "description": {
        "value": "Led by Sam Sample, the society runs talks and coding sessions.",
        "evidence_quote": "Our weekly Sunday coding sessions",
    },
    "join_url": {
        "value": "https://www.cuats.co.uk/register/",
        "evidence_quote": "Join the society",
    },
    "termcard_url": {
        "value": "https://invented.example/termcard.pdf",
        "evidence_quote": "termcard",
    },
    "categories": [
        {"value": "science_tech", "evidence_quote": "algorithm development"},
        {
            "value": "careers_professional",
            "evidence_quote": "industry experts share their experiences",
        },
        {"value": "technology", "evidence_quote": "x"},
    ],
    "activity_types": [
        {
            "value": "talks",
            "evidence_quote": "a series of talks and seminars held throughout the academic year",
        },
        {
            "value": "workshops",
            "evidence_quote": "Our workshop events with our sponsoring companies",
        },
    ],
    "tags": ["algorithmic-trading", "Not Kebab"],
    "sessions": [
        {
            "title": "Coding sessions",
            "day": "sunday",
            "evidence_quote": "Our weekly Sunday coding sessions",
        },
        {"title": "Invented social", "day": "monday", "evidence_quote": "We meet every Monday"},
    ],
    "needs": [
        {
            "item": "sponsorship",
            "evidence_quote": "Our workshop events with our sponsoring companies",
        }
    ],
    "committee": [
        {"name": "Sam Sample", "role": "President", "evidence_quote": "Sam Sample\n\nPresident"},
        {"name": "Not On Page", "role": "Treasurer", "evidence_quote": "Not On Page, Treasurer"},
    ],
}


def cuats_target() -> Target:
    return Target(
        key="org-cambridge-university-algorithmic-trading-society",
        name="Cambridge University Algorithmic Trading Society",
        aliases=["CUATS"],
        level="university",
        website=f"{CUATS}/",
    )


def mock_cuats(net: respx.MockRouter, robots: str = "User-agent: *\nAllow: /\n") -> None:
    net.get(f"{CUATS}/robots.txt").respond(200, text=robots)
    net.get(f"{CUATS}/").mock(
        return_value=html((FIXTURES / "cuats_wordpress.html").read_text(encoding="utf-8"))
    )
    net.get(url__startswith=CUATS).mock(return_value=html("gone", 404))


def by_field(result: TargetResult) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for record in result.website:
        for obs in record.fields:
            out.setdefault(obs.field, obs)
    return out


def test_a_recorded_wordpress_site_is_read_honestly(tmp_path: Path, net: respx.MockRouter) -> None:
    mock_cuats(net)
    llm = net.post(f"{LLM_BASE}/chat/completions").mock(return_value=completion(CUATS_REPLY))
    enricher = Enricher(polite(tmp_path), llm_client(), cache_dir=tmp_path / "cache")
    result = enricher.enrich(cuats_target())
    fields = by_field(result)

    # Deterministic: final URL, sympa sign-up, role email, health and platform.
    assert fields["website"].value == "https://www.cuats.co.uk/"
    assert fields["mailingList"].value["platform"] == "sympa"
    assert fields["roleEmails"].value == [
        {"role": "president", "email": "president@cuats.co.uk"},
        {"role": "other", "email": "vice-president@cuats.co.uk"},
        {"role": "secretary", "email": "secretary@cuats.co.uk"},
        {"role": "treasurer", "email": "treasurer@cuats.co.uk"},
    ]
    home = result.website[0]
    assert home.internal["website_health"]["last_status"] == 200
    assert home.internal["website_health"]["platform"] == "wordpress"
    assert home.internal["sympa_list"] == "soc-cuats"
    assert {s["platform"] for s in fields["socials"].value} == {"facebook_group", "x"}

    # LLM: verbatim quote → found; paraphrase → inferred; named person → dropped.
    assert fields["shortDescription"].quote_check in ("exact", "normalised")
    assert fields["shortDescription"].status is None
    assert fields["howToJoin"].status == "inferred"
    assert fields["howToJoin"].quote_check == "absent"
    assert "description" not in fields or fields["description"].value is None
    assert fields["joinUrl"].value == "https://www.cuats.co.uk/register/"
    assert "termcardUrl" not in fields  # not a link on the page: never invented
    assert fields["categories"].value == ["science_tech", "careers_professional"]
    assert fields["categories"].status is None
    assert fields["tags"].value == ["algorithmic-trading"]
    assert fields["tags"].status == "inferred"
    assert all(obs.prompt_version == "org_v1" for obs in fields.values() if obs.method == "llm")

    # Sessions and people only with a verified quote; people stay private.
    sessions = [r for r in result.website if r.entity_type == "session"]
    assert [s.identity.name for s in sessions] == ["Coding sessions"]
    assert {f.field: f.value for f in sessions[0].fields}["dayOfWeek"] == 0
    people = [p for r in result.website for p in r.broker.get("people", [])]
    assert people == [{"name": "Sam Sample", "role": "President", "method": "llm"}]
    for record in result.website:
        for obs in record.fields:
            assert "Sam Sample" not in json.dumps(obs.value)
    needs = [n for r in result.website for n in r.broker.get("needs", [])]
    assert [n["item"] for n in needs] == ["sponsorship"]

    # Missing fields the model found nothing for are recorded as not_found.
    assert fields["membership"].status == "missing"
    assert fields["membership"].missing_reason == "not_found"
    assert result.stats.llm_calls == 1

    # The same site again: the LLM answer comes from the cache.
    again = enricher.enrich(cuats_target())
    assert again.stats.llm_cached == 1
    assert llm.call_count == 1


def test_sites_that_keep_ai_crawlers_out_are_read_without_the_llm(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    mock_cuats(net, robots="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n")
    llm = net.post(f"{LLM_BASE}/chat/completions").mock(return_value=completion(CUATS_REPLY))
    result = Enricher(polite(tmp_path), llm_client()).enrich(cuats_target())
    assert llm.call_count == 0
    assert result.stats.llm_skipped_robots == 1
    assert by_field(result)["roleEmails"].value  # the deterministic part still ran


def test_content_signal_ai_input_no_is_honoured(tmp_path: Path, net: respx.MockRouter) -> None:
    mock_cuats(net, robots="User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n")
    llm = net.post(f"{LLM_BASE}/chat/completions").mock(return_value=completion(CUATS_REPLY))
    Enricher(polite(tmp_path), llm_client()).enrich(cuats_target())
    assert llm.call_count == 0


def test_a_dead_or_parked_site_yields_only_its_health(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://gone.example/robots.txt").respond(404)
    net.get("https://gone.example/").respond(404)
    net.get("https://parked.example/robots.txt").respond(404)
    net.get("https://parked.example/").mock(
        return_value=html(
            "<html><body><main>This domain is for sale! Buy this domain today.</main></body></html>"
        )
    )
    enricher = Enricher(polite(tmp_path), None)
    dead = enricher.enrich(
        Target(key="org-gone", name="Gone Society", website="https://gone.example/")
    )
    (record,) = dead.website
    assert record.fetch.http_status == 404
    assert record.internal["website_health"]["last_status"] == 404
    assert record.fields == []

    parked = enricher.enrich(
        Target(key="org-parked", name="Croquet Society", website="https://parked.example/")
    )
    assert parked.stats.not_about == 1
    assert all(obs.field != "website" for r in parked.website for obs in r.fields)


def test_a_site_the_llm_disowns_keeps_only_its_health(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    mock_cuats(net)
    net.post(f"{LLM_BASE}/chat/completions").mock(
        return_value=completion({"is_about_organisation": False})
    )
    result = Enricher(polite(tmp_path), llm_client()).enrich(cuats_target())
    assert result.stats.not_about == 1
    assert all(record.fields == [] and not record.broker for record in result.website)
    assert result.website[0].internal == {
        "website_health": result.website[0].internal["website_health"]
    }


def test_robots_disallow_is_recorded_not_crawled(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://private.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    page = net.get("https://private.example/").respond(200, text="secret")
    result = Enricher(polite(tmp_path), None).enrich(
        Target(key="org-private", name="Private Society", website="https://private.example/")
    )
    assert page.call_count == 0
    (record,) = result.website
    assert record.fetch.robots_verdict == "disallowed"
    assert "website_health" not in record.internal


def test_a_linktree_is_read_deterministically(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://linktr.ee/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    net.get("https://linktr.ee/cuexamplesoc").mock(
        return_value=html((FIXTURES / "linktree_synthetic.html").read_text(encoding="utf-8"))
    )
    result = Enricher(polite(tmp_path), llm_client()).enrich(
        Target(
            key="org-example-society",
            name="Cambridge University Example Society",
            linktree="https://linktr.ee/cuexamplesoc",
        )
    )
    (record,) = result.linktree
    values = {obs.field: obs.value for obs in record.fields}
    assert record.source_type == "linktree"
    assert values["joinUrl"] == "https://forms.gle/AbCdEfGh123"
    assert values["website"] == "https://www.cuexamplesoc.org/"
    assert values["mailingList"]["platform"] == "sympa"
    assert {s["platform"] for s in values["socials"]} == {"instagram", "facebook_page"}
    assert record.internal["google_calendar_ids"] == ["cuexamplesoc@gmail.com"]
    assert record.internal["ticketing_urls"] == ["https://fixr.co/organiser/cuexamplesoc"]


# --- targets and the stage ------------------------------------------------------------------


def resolved_org(key: str, name: str, *, fields: list | None = None, **hints: Any) -> Observation:
    return Observation(
        source_type="su_profile",
        source_key=key,
        source_url=f"https://www.cambridgesu.co.uk/organisation/{key}/",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name=name, known_key=key, **hints),
        entity_key=key,
        fields=[
            parser_field("name", name, extractor="test", evidence="secondary"),
            *(fields or []),
        ],
    )


def test_targets_skip_counterparts_social_only_and_shared_sites() -> None:
    def site(url: str):
        return [parser_field("website", url, extractor="test", evidence="secondary")]

    targets, notes = targets_from(
        [
            resolved_org("org-a", "A Society", fields=site("https://a.example/")),
            resolved_org("org-b", "B Society", fields=site("https://www.facebook.com/bsoc")),
            resolved_org("org-c", "C Society", fields=site("https://shared.example/")),
            resolved_org("org-d", "D Society", fields=site("https://shared.example/")),
            resolved_org(
                "org-e",
                "E Society",
                fields=site("https://linktr.ee/esoc"),
            ),
            resolved_org(
                "org-bank", "Big Bank", org_type="company", fields=site("https://bank.example/")
            ),
        ]
    )
    assert [(t.key, t.website, t.linktree) for t in targets] == [
        ("org-a", "https://a.example/", None),
        ("org-e", None, "https://linktr.ee/esoc"),
    ]
    assert any("shared.example" in note for note in notes)


SPONSOR_PAGE = """<html><head><title>Example Robotics Society</title></head><body><main>
<h1>Example Robotics Society</h1>
<p>We build robots every Thursday evening. Our sponsors this year are Acme Robotics Ltd and
the Department of Engineering. We also work with the Robot Wranglers Society.</p>
<p><a href="mailto:hello@robots.example">hello@robots.example</a></p>
</main></body></html>"""

SPONSOR_REPLY = {
    "is_about_organisation": True,
    "sponsors_partners": [
        {
            "name": "Acme Robotics Ltd",
            "relation": "sponsor",
            "kind": "company",
            "evidence_quote": "Our sponsors this year are Acme Robotics Ltd",
        },
        {
            "name": "Department of Engineering",
            "relation": "sponsor",
            "kind": "department",
            "evidence_quote": "the Department of Engineering",
        },
        {
            "name": "Robot Wranglers Society",
            "relation": "partner",
            "kind": "student_society",
            "evidence_quote": "We also work with the Robot Wranglers Society",
        },
    ],
}


def test_the_stage_stages_pages_and_counterparts_for_load(
    make_settings, net: respx.MockRouter, tmp_path: Path
) -> None:
    settings = make_settings(
        llm_base_url=LLM_BASE,
        llm_api_key="k",
        llm_model_bulk="bulk-model-1",
        llm_model_strong="strong-model-1",
        min_host_interval=0.0,
    )
    store = StagingStore(settings.staging_dir)
    store.write(
        RESOLVED,
        "20261007T000000Z-aaaaaa",
        [
            resolved_org(
                "org-example-robotics-society",
                "Example Robotics Society",
                fields=[
                    parser_field(
                        "website", "https://robots.example/", extractor="t", evidence="secondary"
                    )
                ],
            )
        ],
    )
    net.get("https://robots.example/robots.txt").respond(404)
    net.get("https://robots.example/").mock(return_value=html(SPONSOR_PAGE))
    net.post(f"{LLM_BASE}/chat/completions").mock(return_value=completion(SPONSOR_REPLY))

    report = run_sync(settings=settings, dry_run=True, registry=[Stage("enrich")])
    assert report.ok, report.summary()

    staged = store.read_latest("society_website")
    counterparts = [
        r
        for r in staged
        if r.source_key.endswith(("org-acme-robotics-ltd", "org-department-of-engineering"))
    ]
    assert [r.entity_key for r in staged[: len(counterparts)]] == [
        r.entity_key for r in counterparts
    ]
    assert {r.entity_key for r in counterparts} == {
        "org-acme-robotics-ltd",
        "org-department-of-engineering",
    }
    acme = next(r for r in counterparts if r.entity_key == "org-acme-robotics-ltd")
    values = {obs.field: obs for obs in acme.fields}
    assert values["name"].method == "llm" and values["name"].quote_check == "exact"
    assert values["isCounterpart"].value is True
    assert values["orgType"].status == "inferred"

    page = next(r for r in staged if r.entity_key == "org-example-robotics-society")
    edges = {
        (rel.type, rel.direction, rel.to_identity.known_key, rel.visibility)
        for rel in page.relationships
    }
    assert edges == {
        ("sponsors", "incoming", "org-acme-robotics-ltd", "public"),
        ("sponsors", "incoming", "org-department-of-engineering", "public"),
    }
    plan = plan_observations(staged)
    assert {(r.from_key, r.to_key) for r in plan.relationships} == {
        ("org-acme-robotics-ltd", "org-example-robotics-society"),
        ("org-department-of-engineering", "org-example-robotics-society"),
    }
    # The page's organisation owns the page's sources row, not a counterpart.
    (source,) = [s for s in plan.sources if s.url.startswith("https://robots.example/")]
    assert source.org_key == "org-example-robotics-society"
    (enrich_report,) = report.stages
    assert any("1 unmatched" in note for note in enrich_report.notes)
