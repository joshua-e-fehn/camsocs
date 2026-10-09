"""The SU and Proctors harvest stages end to end against mocked hosts: robots.txt
is honoured, observations land in staging, a dry run replays the cache and
writes nothing, and a mostly-unreadable source fails the stage."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

import httpx
import pytest
import respx

from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.sources.proctors import REGISTER_URL
from camsocs_pipeline.sources.su import DIRECTORY_URL, parse_directory
from camsocs_pipeline.stages import proctors_register, su_directory
from camsocs_pipeline.staging.store import StagingStore

FIXTURES = Path(__file__).parent / "fixtures"
SU = "https://www.cambridgesu.co.uk"
#: The SU's robots.txt as checked on 2026-10-07 (the `*` group).
SU_ROBOTS = "User-agent: *\nDisallow: /photos/\nDisallow: /login/\nDisallow: /asset/\n"


def context(settings, *, dry_run: bool = False, limit: int | None = None) -> StageContext:
    run = RunReport(run_key="20261007T120000Z-abcdef", command="sync", dry_run=dry_run)
    return StageContext(
        settings=settings,
        report=run.stage("harvest"),
        run=run,
        loader=ConvexLoader("", "", dry_run=True),
        state=SyncState(),
        staging=StagingStore(settings.staging_dir),
        dry_run=dry_run,
        limit=limit,
    )


@pytest.fixture
def settings(make_settings):
    return make_settings(min_host_interval=0.0)


def mock_su(net: respx.MockRouter, profiles: dict[str, httpx.Response]) -> respx.Route:
    net.get(f"{SU}/robots.txt").respond(200, text=SU_ROBOTS)
    directory = net.get(DIRECTORY_URL).respond(
        200,
        text=(FIXTURES / "su" / "directory.html").read_text(encoding="utf-8"),
        headers={"content-type": "text/html; charset=utf-8"},
    )
    for path, response in profiles.items():
        net.get(f"{SU}{path}").mock(return_value=response)
    return directory


def html(name: str) -> httpx.Response:
    text = (FIXTURES / "su" / name).read_text(encoding="utf-8")
    return httpx.Response(200, text=text, headers={"content-type": "text/html; charset=utf-8"})


def test_the_su_stage_stages_directory_and_profile_observations(settings, net) -> None:
    entries = parse_directory((FIXTURES / "su" / "directory.html").read_text(encoding="utf-8"))
    profiles = {
        urlsplit(e.profile_url).path: html("profile_9791_cusu_termcard.html") for e in entries
    }
    profiles["/organisation/15759/"] = html("profile_15759_full.html")
    profiles["/organisation/cu3d/"] = httpx.Response(404)
    mock_su(net, profiles)
    ctx = context(settings)

    su_directory.run(ctx)

    directory = ctx.staging.read_latest("su_directory")
    staged = ctx.staging.read_latest("su_profile")
    assert [record.source_key for record in directory] == [e.su_id for e in entries]
    assert [record.source_key for record in staged] == [e.su_id for e in entries]
    # robots.txt disallows /asset/, but D3 lets a society's own logo there be
    # copied: it is staged for the load stage to store (never hotlinked, and
    # not fetched here), and the override is on the access note.
    logo = next(f for f in directory[0].fields if f.field == "logo")
    assert logo.value == {"sourceUrl": entries[0].logo_url}
    assert "/asset/" in entries[0].logo_url
    assert directory[0].fetch.access_note == "logo: robots_override:society"
    assert not any("/asset/" in str(call.request.url) for call in net.calls)
    # The 404 profile is a sources row without claims — one in eleven is tolerated.
    gone = next(record for record in staged if record.source_key == "20910")
    assert gone.fields == [] and gone.fetch.http_status == 404
    assert ctx.report.skipped == 1
    assert "11 listed; 11 directory and 11 profile observations; 1 profiles unreadable" in (
        ctx.report.notes
    )


def test_a_dry_run_replays_the_cache_and_stages_nothing(settings, net) -> None:
    mock_su(net, {"/organisation/15759/": html("profile_15759_full.html")})
    su_directory.run(context(settings, limit=1))
    calls = len(net.calls)
    staged = sorted(settings.staging_dir.rglob("*.jsonl"))

    ctx = context(settings, dry_run=True, limit=1)
    su_directory.run(ctx)

    assert len(net.calls) == calls, "a dry run touches no network"
    assert sorted(settings.staging_dir.rglob("*.jsonl")) == staged
    assert "dry run: replayed from cache, nothing staged" in ctx.report.notes
    assert ctx.report.ok


def test_a_dry_run_with_an_empty_cache_is_a_no_op(settings) -> None:
    ctx = context(settings, dry_run=True)
    su_directory.run(ctx)
    proctors_register.run(ctx)
    assert not settings.staging_dir.exists()


def test_a_directory_that_cannot_be_read_fails_the_stage(settings, net) -> None:
    net.get(f"{SU}/robots.txt").respond(200, text=SU_ROBOTS)
    net.get(DIRECTORY_URL).respond(403)

    with pytest.raises(RuntimeError, match="access_restricted"):
        su_directory.run(context(settings))


def test_mostly_unreadable_profiles_fail_the_stage_after_staging(settings, net) -> None:
    mock_su(
        net,
        {
            "/organisation/15759/": httpx.Response(404),
            "/organisation/cu3d/": httpx.Response(404),
        },
    )
    ctx = context(settings, limit=2)

    with pytest.raises(RuntimeError, match="2 of 2 SU profiles"):
        su_directory.run(ctx)
    assert len(ctx.staging.read_latest("su_directory")) == 2


def test_the_proctors_stage_stages_every_entry(settings, net) -> None:
    net.get("https://www.proctors.cam.ac.uk/robots.txt").respond(404)
    net.get(REGISTER_URL).respond(
        200,
        text=(FIXTURES / "proctors" / "register.html").read_text(encoding="utf-8"),
        headers={"content-type": "text/html; charset=utf-8"},
    )
    ctx = context(settings)

    proctors_register.run(ctx)

    records = ctx.staging.read_latest("proctors_register")
    assert len(records) == 18
    assert all(record.source_type == "proctors_register" for record in records)
    assert "18 listed; 18 observations" in ctx.report.notes
