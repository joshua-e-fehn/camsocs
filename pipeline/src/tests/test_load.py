"""Writing to Convex: batching, the Bearer key, and what must not be retried.
The pipeline's half of the contract in webapp/convex/http.ts and lib/ingest.ts."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.models.wire import ClaimInput
from camsocs_pipeline.pipeline.load import (
    MAX_BATCH,
    ConvexAuthError,
    ConvexError,
    ConvexLoader,
    chunked,
    entity_batches,
)

SITE = "https://happy-otter-123.convex.site"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def loader(**kwargs) -> ConvexLoader:
    return ConvexLoader(SITE, "test-key", max_retries=2, **kwargs)


def test_chunks_match_the_ceiling_convex_enforces() -> None:
    assert MAX_BATCH == 500, "must equal MAX_BATCH in webapp/convex/lib/ingest.ts"
    assert [len(batch) for batch in chunked(list(range(1_200)))] == [500, 500, 200]
    assert list(chunked([])) == []


def claim(entity_key: str, field: str = "name") -> ClaimInput:
    return ClaimInput(
        entity_type="organisation",
        entity_key=entity_key,
        field=field,
        value="x",
        evidence="primary",
        method="parser",
        extractor="t",
        source_key="src-1",
        source_url="https://example.org/",
        source_type="su_directory",
        retrieved_at=0,
    )


def test_claim_batches_never_split_an_entity() -> None:
    # A name-less part of an organisation staged first, its name later: they
    # travel together, so the server can create the row from the name.
    claims = [
        *(claim(f"org-{i}") for i in range(3)),
        claim("org-late", "registrations.su"),
        *(claim(f"org-{i}", "website") for i in range(3)),
        claim("org-late"),
    ]
    batches = entity_batches(claims, size=4)
    assert [[(c.entity_key, c.field) for c in batch] for batch in batches] == [
        [("org-0", "name"), ("org-0", "website"), ("org-1", "name"), ("org-1", "website")],
        [
            ("org-2", "name"),
            ("org-2", "website"),
            ("org-late", "registrations.su"),
            ("org-late", "name"),
        ],
    ]
    # An entity larger than a batch is split, earliest claims first.
    big = entity_batches([claim("org-big", f"f{i}") for i in range(5)], size=2)
    assert [len(batch) for batch in big] == [2, 2, 1]
    assert entity_batches([]) == []


def test_large_inputs_are_split_and_counted(net: respx.MockRouter) -> None:
    route = net.post(f"{SITE}/api/pipeline/societies").mock(
        return_value=httpx.Response(200, json={"inserted": 1, "updated": 2, "unchanged": 3})
    )

    result = loader().post_batches("societies", "rows", [{"k": i} for i in range(MAX_BATCH + 1)])

    assert route.call_count == 2
    assert len(json.loads(route.calls[0].request.content)["rows"]) == MAX_BATCH
    assert (result.inserted, result.updated, result.unchanged, result.requests) == (2, 4, 6, 2)


def test_requests_carry_the_bearer_key(net: respx.MockRouter) -> None:
    route = net.get(f"{SITE}/api/pipeline/health").respond(200, json={"ok": True})

    assert loader().health() is True
    assert route.calls[0].request.headers["authorization"] == "Bearer test-key"


def test_a_401_is_an_auth_error_and_not_retried(net: respx.MockRouter) -> None:
    route = net.get(f"{SITE}/api/pipeline/health").respond(401, json={"error": "Unauthorized"})

    with pytest.raises(ConvexAuthError):
        loader().health()
    assert route.call_count == 1


def test_a_400_is_not_retried_and_passes_the_message_through(net: respx.MockRouter) -> None:
    route = net.post(f"{SITE}/api/pipeline/runs/start").respond(
        400, json={"error": "Object contains extra field `unexpected`"}
    )

    with pytest.raises(ConvexError, match="unexpected"):
        loader().start_run("r1", command="sync", stages=["fetch"], pipeline_version="0.1.0")
    assert route.call_count == 1


def test_5xx_and_transport_errors_are_retried(net: respx.MockRouter) -> None:
    route = net.post(f"{SITE}/api/pipeline/runs/finish").mock(
        side_effect=[
            httpx.Response(503),
            httpx.ConnectError("reset"),
            httpx.Response(200, json={"runKey": "r1", "status": "success", "unchanged": False}),
        ]
    )

    response = loader().finish_run({"runKey": "r1", "stages": [], "warnings": [], "error": None})

    assert response["status"] == "success"
    assert route.call_count == 3


def test_retries_give_up(net: respx.MockRouter) -> None:
    net.get(f"{SITE}/api/pipeline/health").respond(502)
    with pytest.raises(ConvexError, match="after 3 attempts"):
        loader().health()


def test_start_run_payload_matches_runs_start(net: respx.MockRouter) -> None:
    route = net.post(f"{SITE}/api/pipeline/runs/start").respond(
        200, json={"runKey": "r1", "created": True}
    )

    loader().start_run("r1", command="sync", stages=("discover", "fetch"), pipeline_version="0.1.0")

    assert json.loads(route.calls[0].request.content) == {
        "runKey": "r1",
        "command": "sync",
        "requestedStages": ["discover", "fetch"],
        "pipelineVersion": "0.1.0",
    }


def test_dry_run_touches_no_network_but_still_serialises() -> None:
    # The suite-wide respx mock has no routes here: any request would raise.
    dry = ConvexLoader("", "", dry_run=True)
    assert dry.health() is True
    assert dry.post("anything", {"rows": [1, 2]})["dryRun"] is True
    with pytest.raises(TypeError):
        dry.post("anything", {"bad": {1, 2}})  # a set is not JSON


def test_repr_never_shows_the_key() -> None:
    assert "test-key" not in repr(loader())
