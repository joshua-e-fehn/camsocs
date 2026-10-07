"""The `resolve` stage end to end over a staging directory: `_resolved`
output, the quarantine report, the crosswalk (local and from Convex)."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import IdentityHints, Observation
from camsocs_pipeline.pipeline.context import Stage
from camsocs_pipeline.pipeline.load import ConvexLoader, ConvexNotFound
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.resolve.crosswalk import Crosswalk, crosswalk_path, quarantine_path
from camsocs_pipeline.staging.store import RESOLVED, StagingStore

SITE = "https://happy-otter-123.convex.site"
AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def org(source_type: str, source_key: str, name: str, **hints) -> Observation:
    return Observation(
        source_type=source_type,
        source_key=source_key,
        source_url=f"https://example.org/{source_key}",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name=name, **hints),
        fields=[parser_field("name", name, extractor="test", evidence="secondary")],
    )


def stage(settings) -> None:
    store = StagingStore(settings.staging_dir)
    store.write(
        "su_directory",
        "20261007T000000Z-aaaaaa",
        [
            org("su_directory", "6789", "German Society", su_id="6789"),
            org("su_directory", "8391", "Entrepreneurs Society", su_id="8391"),
        ],
    )
    store.write(
        "sport_az",
        "20261007T000000Z-aaaaaa",
        [org("sport_az", "boat", "Cambridge University Boat Club", level="university",
             website_domain="cubc.org.uk")],
    )  # fmt: skip
    store.write(
        "cucbc",
        "20261007T000000Z-aaaaaa",
        [org("cucbc", "cubc", "Cambridge University Boat Club", level="intercollegiate",
             website_domain="cubc.org.uk")],
    )  # fmt: skip


def resolve_only() -> list[Stage]:
    return [Stage("resolve")]


def test_a_dry_run_writes_resolved_and_the_quarantine_but_no_crosswalk(make_settings) -> None:
    settings = make_settings()
    stage(settings)
    report = run_sync(settings=settings, dry_run=True, registry=resolve_only())
    assert report.ok, report.summary()

    store = StagingStore(settings.staging_dir)
    resolved = store.read_latest(RESOLVED)
    assert {r.entity_key for r in resolved} == {
        "org-german-society",
        "org-entrepreneurs-society",
        "org-cambridge-university-boat-club",
    }
    assert all(r.is_keyed for r in resolved)

    quarantine = json.loads(quarantine_path(settings.staging_dir).read_text())
    assert [item["refs"] for item in quarantine["held"]] == [["cucbc:cubc"]]
    assert not crosswalk_path(settings.staging_dir).exists()
    (resolve_report,) = report.stages
    assert resolve_report.skipped == 1
    assert any("1 held" in note for note in resolve_report.notes)


def test_a_real_run_merges_the_convex_crosswalk_and_saves_it(
    make_settings, net: respx.MockRouter
) -> None:
    settings = make_settings(convex_http_url=SITE, pipeline_api_key="k")
    stage(settings)
    net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True})
    net.post(f"{SITE}/api/pipeline/runs/start").respond(200, json={"created": True})
    net.post(f"{SITE}/api/pipeline/runs/finish").respond(200, json={"status": "success"})
    net.post(f"{SITE}/api/pipeline/crosswalk").respond(
        200,
        json={
            "rows": [
                {
                    "orgKey": "org-cu-german-society",
                    "name": "CU German Society",
                    "aliases": [],
                    "collegeKeys": [],
                    "isCounterpart": False,
                    "suOrgId": "6789",
                }
            ],
            "isDone": True,
            "continueCursor": "",
        },
    )
    report = run_sync(settings=settings, registry=resolve_only())
    assert report.ok, report.summary()
    resolved = StagingStore(settings.staging_dir).read_latest(RESOLVED)
    assert "org-cu-german-society" in {r.entity_key for r in resolved}

    saved = Crosswalk.load(crosswalk_path(settings.staging_dir))
    assert {"org-cu-german-society", "org-entrepreneurs-society"} <= set(saved.entries)
    assert "ref:su_directory:8391" in saved.entries["org-entrepreneurs-society"].ids


def test_the_crosswalk_route_pages_and_a_404_says_not_deployed(net: respx.MockRouter) -> None:
    route = net.post(f"{SITE}/api/pipeline/crosswalk")
    route.side_effect = [
        respx.MockResponse(
            200,
            json={
                "rows": [{"orgKey": "org-a", "name": "A"}],
                "isDone": False,
                "continueCursor": "c1",
            },
        ),
        respx.MockResponse(200, json={"rows": [{"orgKey": "org-b", "name": "B"}], "isDone": True}),
    ]
    loader = ConvexLoader(SITE, "k", max_retries=0)
    rows = loader.crosswalk(page_size=1)
    assert [row.org_key for row in rows] == ["org-a", "org-b"]
    assert json.loads(route.calls[1].request.content) == {"cursor": "c1", "limit": 1}

    net.post(f"{SITE}/api/pipeline/crosswalk").respond(404, text="No matching routes found")
    with pytest.raises(ConvexNotFound):
        ConvexLoader(SITE, "k", max_retries=0).crosswalk()
