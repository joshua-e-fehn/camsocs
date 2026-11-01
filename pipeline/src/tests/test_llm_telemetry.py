"""LLM analytics (ENG-9): one `$ai_generation` per `LLMClient` request, with
allow-listed numbers and ids only, never message content or error text; off
without a key; never in the way of the call. All offline (respx, fake
PostHog client).

The hard rule that talks stages never reach a model is proven where those
stages are tested (`test_the_stage_never_reaches_a_model` in test_talks.py and
test_events_sources.py, through conftest's `llm_tripwire`); the tripwire
itself is checked here.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
import respx
from pydantic import BaseModel

from camsocs_pipeline import telemetry as telemetry_module
from camsocs_pipeline.extract.event_noise import classifier_for
from camsocs_pipeline.extract.llm import LLMClient, LLMValidationError
from camsocs_pipeline.extract.redact import redactor_for
from camsocs_pipeline.pipeline.context import Stage, StageContext
from camsocs_pipeline.pipeline.report import RunReport
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.telemetry import (
    AI_GENERATION,
    ALLOWED,
    DISTINCT_ID,
    HarvestTelemetry,
    active_telemetry,
)
from tests.conftest import ModelReached
from tests.test_llm import BASE, COMPLETIONS, completion, llm_settings
from tests.test_telemetry import FakeClient

RUN_KEY = "20261101T120000Z-abc123"
#: Scraped text a prompt carries, and what a model or server might answer:
#: none of it may reach PostHog.
SCRAPED = "Join the Example Society, contact ada@example.org at https://example.org/join"
REPLY_SECRET = "Widget Gazette"
SERVER_TEXT = "context length exceeded for Example Society page"
#: What a generation must never carry (PostHog's content and URL properties).
CONTENT_KEYS = {
    "$ai_input",
    "$ai_output_choices",
    "$ai_error",
    "$ai_base_url",
    "$ai_request_url",
    "$ai_instructions",
    "$ai_tools",
    "$ai_model_parameters",
}


class Society(BaseModel):
    name: str


def messages() -> list[dict[str, Any]]:
    return [{"role": "user", "content": f"Extract the society from: {SCRAPED}"}]


def enabled(client: FakeClient, *, run_key: str = RUN_KEY) -> HarvestTelemetry:
    telemetry = HarvestTelemetry(client, environment="production", revision="0123456789ab")
    telemetry.run_started(RunReport(run_key, "sync --group events"), group="events", stages=[])
    telemetry.stage_started("enrich")
    return telemetry


def llm(**kwargs: Any) -> LLMClient:
    return LLMClient(llm_settings(), sleep=lambda _s: None, **kwargs)


def generations(client: FakeClient) -> list[dict[str, Any]]:
    return client.named(AI_GENERATION)


def assert_private(client: FakeClient) -> None:
    """Every generation: the personless id, allow-listed keys, no content."""
    for event, kwargs in client.events:
        assert set(kwargs) == {"distinct_id", "properties"}
        assert kwargs["distinct_id"] == DISTINCT_ID
        properties = kwargs["properties"]
        assert properties["$process_person_profile"] is False
        assert set(properties) <= ALLOWED[event], set(properties) - ALLOWED[event]
        assert not CONTENT_KEYS & set(properties)
        values = json.dumps(list(properties.values()))
        for text in (SCRAPED, "example.org", REPLY_SECRET, SERVER_TEXT, BASE, "test-llm-key"):
            assert text not in values
        assert "http" not in values and "llm.test" not in values


# --- what a generation carries ------------------------------------------------


def test_the_allow_list_leaves_out_every_content_property() -> None:
    assert not CONTENT_KEYS & ALLOWED[AI_GENERATION]


def test_a_call_sends_one_generation_with_numbers_and_ids_only(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(return_value=completion(json.dumps({"name": REPLY_SECRET})))
    client = FakeClient()

    call = llm(telemetry=enabled(client)).complete_json(
        schema=Society, messages=messages(), prompt_version="org_v1"
    )

    assert call.value.name == REPLY_SECRET
    (generation,) = generations(client)
    assert generation == {
        "environment": "production",
        "runKey": RUN_KEY,
        "group": "events",
        "dryRun": False,
        "$ai_trace_id": RUN_KEY,
        "$ai_span_name": "enrich",
        "stage": "enrich",
        "$ai_model": "bulk-model-1",
        "$ai_provider": "cliproxy",
        "$ai_input_tokens": 10,
        "$ai_output_tokens": 5,
        "$ai_latency": generation["$ai_latency"],
        "$ai_http_status": 200,
        "$ai_is_error": False,
        "tier": "bulk",
        "promptVersion": "org_v1",
        "attempts": 1,
        "validationRetry": False,
        "$process_person_profile": False,
    }
    assert isinstance(generation["$ai_latency"], float) and generation["$ai_latency"] >= 0
    assert_private(client)


def test_transient_failures_are_one_generation_with_the_attempts(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(
        side_effect=[
            httpx.Response(429, json={"error": {"message": SERVER_TEXT}}),
            httpx.Response(502, text=SERVER_TEXT),
            completion(json.dumps({"name": "ok"})),
        ]
    )
    client = FakeClient()

    llm(telemetry=enabled(client)).complete_json(
        schema=Society, messages=messages(), prompt_version="org_v1", tier="strong"
    )

    (generation,) = generations(client)
    assert generation["attempts"] == 3 and generation["$ai_http_status"] == 200
    assert generation["$ai_model"] == "strong-model-1" and generation["tier"] == "strong"
    assert generation["$ai_is_error"] is False and "errorType" not in generation
    assert_private(client)


def test_the_corrective_retry_is_a_second_generation(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(
        side_effect=[
            completion(json.dumps({"title": REPLY_SECRET})),
            completion(json.dumps({"also": REPLY_SECRET})),
        ]
    )
    client = FakeClient()

    with pytest.raises(LLMValidationError):
        llm(telemetry=enabled(client)).complete_json(
            schema=Society, messages=messages(), prompt_version="org_v1"
        )

    first, retry = generations(client)
    assert (first["validationRetry"], retry["validationRetry"]) == (False, True)
    assert first["$ai_is_error"] is False and retry["$ai_is_error"] is False
    assert_private(client)


def test_an_error_sends_the_status_and_class_but_no_error_text(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(
        return_value=httpx.Response(400, json={"error": {"message": SERVER_TEXT}})
    )
    client = FakeClient()

    with pytest.raises(openai.BadRequestError, match="context length"):
        llm(telemetry=enabled(client)).complete_json(
            schema=Society, messages=messages(), prompt_version="org_v1"
        )

    (generation,) = generations(client)
    assert generation["$ai_http_status"] == 400 and generation["$ai_is_error"] is True
    assert generation["errorType"] == "BadRequestError" and generation["attempts"] == 1
    assert "$ai_input_tokens" not in generation
    assert_private(client)


def test_a_transport_failure_has_no_status(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(side_effect=httpx.ConnectError(SERVER_TEXT))
    client = FakeClient()

    with pytest.raises(openai.APIConnectionError):
        LLMClient(
            llm_settings(), sleep=lambda _s: None, max_attempts=2, telemetry=enabled(client)
        ).complete_json(schema=Society, messages=messages(), prompt_version="org_v1")

    (generation,) = generations(client)
    assert "$ai_http_status" not in generation and generation["$ai_is_error"] is True
    assert generation["errorType"] == "APIConnectionError" and generation["attempts"] == 2
    assert_private(client)


def test_an_interrupted_call_is_an_error_not_a_success() -> None:
    def interrupted(**_kwargs: Any) -> Any:
        raise KeyboardInterrupt

    openai_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=interrupted))
    )
    client = FakeClient()

    with pytest.raises(KeyboardInterrupt):
        llm(client=openai_client, telemetry=enabled(client)).complete_json(
            schema=Society, messages=messages(), prompt_version="org_v1"
        )

    (generation,) = generations(client)
    assert generation["$ai_is_error"] is True and generation["errorType"] == "KeyboardInterrupt"
    assert "$ai_http_status" not in generation
    assert_private(client)


def test_only_a_model_id_of_the_allowed_shape_is_sent() -> None:
    client = FakeClient()
    enabled(client).generation(
        model="gpt 6 <Example Society>",
        tier="bulk",
        prompt_version="org v1",
        latency_s=0.1,
        attempts=1,
    )
    (generation,) = generations(client)
    assert "$ai_model" not in generation and "promptVersion" not in generation
    # A gateway id may carry a slash; a URL may not pass as a model id.
    for model, sent in (("openai/gpt-6-luna", True), ("https://llm.example/v1", False)):
        client = FakeClient()
        enabled(client).generation(
            model=model, tier="bulk", prompt_version="org_v1", latency_s=0.1, attempts=1
        )
        (generation,) = generations(client)
        assert ("$ai_model" in generation) is sent


# --- never in the way ----------------------------------------------------------


def test_a_telemetry_failure_never_reaches_the_call(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(return_value=completion(json.dumps({"name": "ok"})))
    broken = enabled(FakeClient(fail=True))

    call = llm(telemetry=broken).complete_json(
        schema=Society, messages=messages(), prompt_version="org_v1"
    )

    assert call.value.name == "ok"


def test_a_telemetry_failure_never_replaces_the_calls_own_error(
    net: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    net.post(COMPLETIONS).mock(return_value=httpx.Response(400, json={"error": {}}))
    telemetry = enabled(FakeClient())
    monkeypatch.setattr(telemetry, "_capture", lambda *_a, **_k: 1 / 0)

    with pytest.raises(openai.BadRequestError):
        llm(telemetry=telemetry).complete_json(
            schema=Society, messages=messages(), prompt_version="org_v1"
        )


def test_without_a_key_nothing_is_built_or_sent(make_settings, net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(return_value=completion(json.dumps({"name": "ok"})))

    def factory(_settings: Any) -> FakeClient:
        raise AssertionError("no client without POSTHOG_KEY")

    disabled = HarvestTelemetry.from_settings(make_settings(), client_factory=factory)
    disabled.run_started(RunReport(RUN_KEY, "sync"), group=None, stages=[])

    call = llm().complete_json(schema=Society, messages=messages(), prompt_version="org_v1")

    assert call.value.name == "ok" and not disabled.enabled
    disabled.close()


def test_outside_a_run_a_call_reports_nothing(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(return_value=completion(json.dumps({"name": "ok"})))
    assert active_telemetry() is None
    assert llm().complete_json(schema=Society, messages=messages(), prompt_version="org_v1")


# --- a run's generations -------------------------------------------------------


def test_a_runs_stages_report_their_generations_and_then_stop(
    make_settings, net: respx.MockRouter
) -> None:
    """No telemetry is handed to the client: the run in progress is found,
    each generation carries its stage, and after the run nothing is active."""
    net.post(COMPLETIONS).mock(return_value=completion(json.dumps({"name": "ok"})))

    def extracting(ctx: StageContext) -> None:
        client = LLMClient(llm_settings(), sleep=lambda _s: None)
        client.complete_json(schema=Society, messages=messages(), prompt_version="classify_v1")
        ctx.report.inserted += 1

    def plain(ctx: StageContext) -> None:
        ctx.report.unchanged += 1

    fake = FakeClient()
    telemetry = HarvestTelemetry(fake, environment="production")
    registry = [Stage("talks", plain), Stage("classify", extracting), Stage("report", plain)]

    report = run_sync(
        settings=make_settings(), dry_run=True, registry=registry, telemetry=telemetry
    )

    assert report.ok
    (generation,) = generations(fake)
    assert generation["stage"] == generation["$ai_span_name"] == "classify"
    assert generation["$ai_trace_id"] == report.run_key == generation["runKey"]
    assert generation["dryRun"] is True and generation["promptVersion"] == "classify_v1"
    assert active_telemetry() is None
    names = [name for name, _ in fake.events]
    assert names.index(AI_GENERATION) < len(names) - 1  # before the run finished
    assert_private(fake)


def test_close_also_ends_the_active_run() -> None:
    telemetry = enabled(FakeClient())
    assert active_telemetry() is telemetry
    telemetry.close()
    assert active_telemetry() is None


# --- the talks tripwire --------------------------------------------------------


def test_the_tripwire_catches_every_way_to_a_model(
    llm_tripwire: list[str], net: respx.MockRouter, make_settings
) -> None:
    route = net.post(COMPLETIONS).mock(return_value=completion("{}"))
    # The usual way in, `LLMClient(settings.require_llm())`, trips before the
    # unconfigured settings' `ConfigError` could reach a rules-only fallback.
    with pytest.raises(ModelReached):
        make_settings().require_llm()
    with pytest.raises(ModelReached):
        classifier_for(make_settings(), dry_run=False)
    with pytest.raises(ModelReached):
        redactor_for(make_settings(), dry_run=False)
    with pytest.raises(ModelReached):
        LLMClient(llm_settings())
    with pytest.raises(ModelReached):
        openai.OpenAI(base_url=BASE, api_key="test-llm-key")
    with pytest.raises(ModelReached):
        HarvestTelemetry().generation(
            model="m", tier="bulk", prompt_version="v", latency_s=0.0, attempts=1
        )
    with pytest.raises(ModelReached):
        LLMClient.complete_json(object(), schema=Society, messages=[], prompt_version="v")  # type: ignore[arg-type]
    assert len(llm_tripwire) == 7 and not route.called
    assert telemetry_module.active_telemetry() is None
