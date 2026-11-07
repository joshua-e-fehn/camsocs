"""Golden master of what the `load` stage posts (multi-campus seam, guardrail L0a).

The `load` stage runs, as a dry run, over a synthetic staging tree
(`tests.golden_staging`: the SU, seed and website fixtures only, never talks
fixtures) with a `RecordingLoader`, and every ingestion request it would make
— route and canonical JSON payload, in order — must equal
``fixtures/golden/loader-payloads.cam.json`` byte for byte. Cambridge's keys,
claims, fingerprints and routes must not move while the campus seam lands; a
deliberate change regenerates the file and shows in review as its diff.

Regenerate with ``CAMSOCS_RECORD_GOLDEN=1 pixi run test-python
src/tests/test_loader_golden.py``, then run it again without the variable.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from camsocs_pipeline.keys import canonical_json
from camsocs_pipeline.pipeline import load as load_module
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import PAYLOAD_DIGEST_ENV, ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.stages import load as load_stage
from tests import golden_staging
from tests.recording_loader import RecordingLoader

GOLDEN = Path(__file__).parent / "fixtures" / "golden" / "loader-payloads.cam.json"
RECORD = "CAMSOCS_RECORD_GOLDEN"
SCHEMA = "camsocs.loader-payloads/1"


def record_load(make_settings) -> tuple[RecordingLoader, StageContext]:
    settings = make_settings()
    store = golden_staging.build(settings.staging_dir)
    loader = RecordingLoader()
    run = RunReport(run_key=golden_staging.RUN_KEY, command="sync --stages load", dry_run=True)
    ctx = StageContext(
        settings=settings,
        report=run.stage("load"),
        run=run,
        loader=loader,
        state=SyncState(),
        staging=store,
        dry_run=True,
        limit=None,
    )
    load_stage.run(ctx)
    return loader, ctx


def render(posts: list[tuple[str, str]]) -> str:
    """The golden file: each request's route and payload, in order, pretty
    printed (keys sorted) so a change reads as a reviewable diff."""
    document = {
        "schema": SCHEMA,
        "staging": "tests/golden_staging.py",
        "requests": [{"path": path, "payload": json.loads(payload)} for path, payload in posts],
    }
    return json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def test_the_load_stage_posts_exactly_the_golden_payloads(make_settings, llm_tripwire) -> None:
    loader, ctx = record_load(make_settings)
    assert ctx.report.ok, ctx.report.error
    assert llm_tripwire == [], "a dry-run load reaches no model"
    rendered = render(loader.posts)
    if os.environ.get(RECORD):
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(rendered, encoding="utf-8")
    assert GOLDEN.exists(), f"no golden file; record it with {RECORD}=1"
    golden = GOLDEN.read_text(encoding="utf-8")
    if rendered != golden:
        # Name the first request that differs before the byte comparison.
        mine = json.loads(rendered)["requests"]
        theirs = json.loads(golden)["requests"]
        for index, (a, b) in enumerate(zip(mine, theirs, strict=False)):
            assert canonical_json(a) == canonical_json(b), f"request {index} ({a['path']}) moved"
        assert len(mine) == len(theirs), f"{len(mine)} requests, the golden has {len(theirs)}"
    assert rendered == golden


def test_the_golden_covers_every_route_the_load_stage_posts(make_settings) -> None:
    """The synthetic tree reaches each ingestion route the load stage uses, so
    the golden master watches all of them."""
    loader, _ctx = record_load(make_settings)
    paths = {path for path, _payload in loader.posts}
    assert {
        "sources",
        "claims",
        "orgInternal",
        "relationships",
        "eventOrganisers",
    } <= paths
    entities = {
        claim["entityType"]
        for path, payload in loader.posts
        if path == "claims"
        for claim in json.loads(payload)["claims"]
    }
    assert {"organisation", "event"} <= entities


def test_nothing_posted_carries_a_null(make_settings) -> None:
    """The pipeline never sends None for a field it did not observe (upserts
    are patches); canonical JSON would hide one, so the raw payloads are read."""
    seen: list[dict[str, Any]] = []

    class Raw(RecordingLoader):
        def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
            seen.append(payload)
            return super().post(path, payload)

    settings = make_settings()
    store = golden_staging.build(settings.staging_dir)
    run = RunReport(run_key=golden_staging.RUN_KEY, command="sync", dry_run=True)
    load_stage.run(
        StageContext(
            settings=settings,
            report=run.stage("load"),
            run=run,
            loader=Raw(),
            state=SyncState(),
            staging=store,
            dry_run=True,
            limit=None,
        )
    )

    def nulls(value: Any, where: str) -> list[str]:
        if value is None:
            return [where]
        if isinstance(value, dict):
            return [n for key, item in value.items() for n in nulls(item, f"{where}.{key}")]
        if isinstance(value, list):
            return [n for i, item in enumerate(value) for n in nulls(item, f"{where}[{i}]")]
        return []

    assert seen
    assert [n for payload in seen for n in nulls(payload, "")] == []


# --- the digest hook ----------------------------------------------------------------------------


def test_the_digest_is_off_unless_asked_for(tmp_path: Path, monkeypatch) -> None:
    """Unset means no behaviour change: the hook opens no file anywhere (not
    a default path, not the working directory) and the post still succeeds."""
    monkeypatch.delenv(PAYLOAD_DIGEST_ENV, raising=False)
    monkeypatch.chdir(tmp_path)
    opened: list[object] = []

    def no_open(file: object, *args: object, **kwargs: object) -> None:
        opened.append(file)
        raise AssertionError(f"the digest hook opened {file!r} with {PAYLOAD_DIGEST_ENV} unset")

    monkeypatch.setattr(load_module, "open", no_open, raising=False)
    ConvexLoader("", "", dry_run=True).post("claims", {"claims": [{"a": 1}]})
    assert opened == []
    assert list(tmp_path.iterdir()) == []


def test_the_digest_records_route_count_and_hash_but_never_the_payload(
    tmp_path: Path, monkeypatch
) -> None:
    digest = tmp_path / "digest.jsonl"
    monkeypatch.setenv(PAYLOAD_DIGEST_ENV, str(digest))
    loader = ConvexLoader("", "", dry_run=True)
    secret = "Jane Doe chairs the society"
    loader.post("claims", {"runKey": "20261007T120000Z-aaaaaa", "claims": [{"v": secret}, {}]})
    loader.post("claims", {"runKey": "20261008T120000Z-bbbbbb", "claims": [{}, {"v": secret}]})
    loader.post("sources", {"sources": []})

    lines = [json.loads(line) for line in digest.read_text(encoding="utf-8").splitlines()]
    assert [(line["path"], line["count"]) for line in lines] == [
        ("claims", 2),
        ("claims", 2),
        ("sources", 0),
    ]
    assert all(set(line) == {"path", "count", "sha256"} for line in lines)
    assert secret not in digest.read_text(encoding="utf-8")
    # Order within the payload counts; the run key does not.
    assert lines[0]["sha256"] != lines[1]["sha256"]
    loader.post("claims", {"runKey": "20261009T120000Z-cccccc", "claims": [{"v": secret}, {}]})
    again = json.loads(digest.read_text(encoding="utf-8").splitlines()[-1])
    assert again == lines[0]


def test_two_dry_run_loads_of_one_tree_digest_identically(
    make_settings, tmp_path: Path, monkeypatch
) -> None:
    """What Joshua compares base against branch (`sync --stages load
    --dry-run`): the same staging digests the same, whatever the run key."""
    store_settings = make_settings()
    store = golden_staging.build(store_settings.staging_dir)
    digests = []
    for n, run_key in enumerate(("20261007T120000Z-aaaaaa", "20261008T090000Z-bbbbbb")):
        digest = tmp_path / f"digest-{n}.jsonl"
        monkeypatch.setenv(PAYLOAD_DIGEST_ENV, str(digest))
        run = RunReport(run_key=run_key, command="sync --stages load", dry_run=True)
        load_stage.run(
            StageContext(
                settings=store_settings,
                report=run.stage("load"),
                run=run,
                loader=ConvexLoader("", "", dry_run=True),
                state=SyncState(),
                staging=store,
                dry_run=True,
                limit=None,
            )
        )
        digests.append(digest.read_text(encoding="utf-8"))
    assert digests[0] and digests[0] == digests[1]


@pytest.fixture(autouse=True)
def _no_digest(monkeypatch) -> None:
    monkeypatch.delenv(PAYLOAD_DIGEST_ENV, raising=False)
