"""A second identical load writes nothing: one orgInternal patch per
organisation, and images the deployment already stores are not uploaded
again (`StoredFileCache`)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import FetchInfo, IdentityHints, Observation
from camsocs_pipeline.models.wire import OrgInternalPatch, PlaywazeIds
from camsocs_pipeline.pipeline.load import (
    STALE_FILE_REASON,
    ConvexLoader,
    StoredFileCache,
    attach_stored_files,
    merge_org_internal,
    plan_observations,
    stored_files_path,
)

SITE = "https://happy-otter-123.convex.site"
AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def org(source: str, internal: dict, *fields) -> Observation:
    return Observation(
        source_type="society_website",
        source_key=source,
        source_url=source,
        retrieved_at=AT,
        fetch=FetchInfo(http_status=200),
        entity_type="organisation",
        identity=IdentityHints(name="CU Chess Club"),
        entity_key="org-chess",
        fields=[parser_field("name", "CU Chess Club", extractor="h1", evidence="primary"), *fields],
        internal=internal,
    )


class TestOrgInternal:
    def test_one_patch_per_organisation_folded_like_the_server(self) -> None:
        merged = merge_org_internal(
            [
                OrgInternalPatch(
                    org_key="org-chess",
                    su_org_id="1",
                    website_domain="chess.example",
                    ics_urls=["https://a.example/cal.ics"],
                    playwaze=PlaywazeIds(community_id="c1", league_ids=["l1"]),
                ),
                OrgInternalPatch(org_key="org-go", instagram_handle="cugo"),
                OrgInternalPatch(
                    org_key="org-chess",
                    website_domain="www.chess.example",
                    ics_urls=["https://b.example/cal.ics", "https://a.example/cal.ics"],
                    playwaze=PlaywazeIds(league_ids=["l2"], team_ids=["t1"]),
                ),
            ]
        )
        assert [patch.org_key for patch in merged] == ["org-chess", "org-go"]
        chess = merged[0]
        assert chess.su_org_id == "1"
        assert chess.website_domain == "www.chess.example"  # the later reading, as before
        assert chess.ics_urls == ["https://a.example/cal.ics", "https://b.example/cal.ics"]
        assert chess.playwaze == PlaywazeIds(
            community_id="c1", league_ids=["l1", "l2"], team_ids=["t1"]
        )

    def test_the_plan_posts_one_patch_for_conflicting_sources(self) -> None:
        plan = plan_observations(
            [
                org("https://su.example/chess", {"instagram_handle": "cuchess"}),
                org("https://chess.example/", {"instagram_handle": "cuchessclub"}),
            ]
        )
        assert len(plan.org_internal) == 1
        assert plan.org_internal[0].instagram_handle == "cuchessclub"


class TestStoredFileCache:
    def claims(self, *urls: str):
        return [
            claim
            for n, url in enumerate(urls)
            for claim in plan_observations(
                [
                    org(
                        f"https://chess{n}.example/",
                        {},
                        parser_field(
                            "logo", {"sourceUrl": url}, extractor="og", evidence="primary"
                        ),
                    )
                ]
            ).claims
            if claim.field == "logo"
        ]

    def test_known_bytes_are_not_uploaded_again(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        upload = net.post(f"{SITE}/api/pipeline/files").mock(
            return_value=httpx.Response(200, json={"storageId": "kg2abc", "sha256": "x"})
        )
        path = stored_files_path(tmp_path / "staging")
        media = {"https://img.example/a.png": (PNG, "image/png")}.get

        loader = ConvexLoader(SITE, "k")
        loader.file_cache = StoredFileCache.load(path, SITE)
        kept, stored, dropped = attach_stored_files(
            self.claims("https://img.example/a.png"), loader, media
        )
        assert (stored, dropped, upload.call_count) == (1, 0, 1)
        loader.file_cache.save()

        second = ConvexLoader(SITE, "k")
        second.file_cache = StoredFileCache.load(path, SITE)
        kept, stored, _ = attach_stored_files(
            self.claims("https://img.example/a.png"), second, media
        )
        assert upload.call_count == 1
        assert kept[0].value["storageId"] == "kg2abc"
        assert second.file_cache.reused == 1

        # Another deployment knows nothing of these ids.
        assert StoredFileCache.load(path, "https://other-1.convex.site").entries == {}
        assert set(json.loads(path.read_text())) == {SITE}

    def test_a_refused_cached_id_is_forgotten(self, tmp_path: Path, net: respx.MockRouter) -> None:
        net.post(f"{SITE}/api/pipeline/suppressions").respond(200, json={})
        net.post(f"{SITE}/api/pipeline/sources").respond(200, json={"inserted": 1})
        net.post(f"{SITE}/api/pipeline/claims").respond(
            200,
            json={
                "inserted": 1,
                "rejected": [
                    {
                        "index": 1,
                        "entityKey": "org-chess",
                        "field": "logo",
                        "reason": STALE_FILE_REASON,
                    }
                ],
            },
        )
        path = stored_files_path(tmp_path / "staging")
        cache = StoredFileCache(path, SITE)
        cache.put(load.hashlib.sha256(PNG).hexdigest(), "kg2gone")
        loader = ConvexLoader(SITE, "k")
        loader.file_cache = cache
        report = loader.post_observations(
            [
                org(
                    "https://chess.example/",
                    {},
                    parser_field(
                        "logo",
                        {"sourceUrl": "https://img.example/a.png"},
                        extractor="og",
                        evidence="primary",
                    ),
                )
            ],
            media={"https://img.example/a.png": (PNG, "image/png")}.get,
        )
        assert report.files_reused == 1
        assert report.files_stale == 1
        assert cache.entries == {}
