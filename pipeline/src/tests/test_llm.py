"""The LLM client: the claude* guard, JSON validation with one corrective retry,
transport retries, the strong fallback, provenance, and the vision helper. All
offline (respx)."""

from __future__ import annotations

import json
import logging
import threading
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest
import respx
from pydantic import BaseModel, SecretStr

from camsocs_pipeline.config import ConfigError, LLMSettings
from camsocs_pipeline.extract.llm import (
    LLMClient,
    LLMValidationError,
    ModelRefused,
    assert_model_allowed,
    image_data_url,
    sniff_image_type,
    vision_message,
)

BASE = "http://llm.test/v1"
COMPLETIONS = f"{BASE}/chat/completions"


class Society(BaseModel):
    name: str
    email: str | None


def llm_settings(**overrides) -> LLMSettings:
    values = {
        "base_url": BASE,
        "api_key": SecretStr("test-llm-key"),
        "model_bulk": "bulk-model-1",
        "model_strong": "strong-model-1",
        "concurrency": 2,
    }
    values.update(overrides)
    return LLMSettings(**values)


def completion(content: str, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 0,
            "model": "bulk-model-1",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": content},
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
    )


def client(**kwargs) -> tuple[LLMClient, list[float]]:
    sleeps: list[float] = []
    return LLMClient(llm_settings(), sleep=sleeps.append, **kwargs), sleeps


# --- the guard ----------------------------------------------------------------


@pytest.mark.parametrize(
    "model",
    [
        "claude-3-5-sonnet",
        "Claude-Opus",
        " claude ",
        "anthropic/claude-x",
        "vendor/Claude-haiku",
        # Gateway spellings: Bedrock, Vertex, provider prefixes and versions.
        "us.anthropic.claude-sonnet-4",
        "anthropic.claude-opus-4",
        "vertex_ai:claude-sonnet",
        "bedrock/us.anthropic.claude-3",
        "claude-3@20240229",
        "my-claudette",
        "anthropic-proxy/some-model",
        # Disguised: a zero-width space, a Cyrillic capital Es, full-width letters.
        "\u200bclaude-3",
        "\u0421laude-3",
        "\uff43laude-3",
    ],
)
def test_claude_models_are_refused(model: str) -> None:
    with pytest.raises(ModelRefused):
        assert_model_allowed(model)


@pytest.mark.parametrize(
    "model", ["gpt-5-mini", "gemini-2.5-flash", "openai/gpt-4.1", "gpt-6-luna", "gpt-6.1-sol"]
)
def test_other_models_are_allowed(model: str) -> None:
    assert assert_model_allowed(model) == model.strip()


def test_empty_model_is_refused() -> None:
    with pytest.raises(ModelRefused):
        assert_model_allowed("  ")


@pytest.mark.parametrize("field", ["model_bulk", "model_strong"])
def test_client_refuses_a_claude_model_before_any_request(
    field: str, net: respx.MockRouter
) -> None:
    route = net.post(COMPLETIONS).mock(return_value=completion("{}"))
    with pytest.raises(ModelRefused):
        LLMClient(llm_settings(**{field: "claude-3-haiku"}))
    assert not route.called


def test_settings_require_llm_applies_the_guard(make_settings) -> None:
    settings = make_settings(
        llm_base_url=BASE,
        llm_api_key="k",
        llm_model_bulk="claude-instant",
        llm_model_strong="strong-model-1",
    )
    with pytest.raises(ModelRefused):
        settings.require_llm()


def test_settings_require_llm_names_what_is_missing(make_settings) -> None:
    with pytest.raises(ConfigError, match="LLM_BASE_URL"):
        make_settings().require_llm()


# --- structured output ----------------------------------------------------------


def test_valid_json_is_parsed_and_provenance_recorded(net: respx.MockRouter) -> None:
    route = net.post(COMPLETIONS).mock(
        return_value=completion('{"name": "Chess Society", "email": null}')
    )
    llm, _ = client()

    call = llm.complete_json(
        schema=Society,
        messages=[{"role": "user", "content": "Extract the society."}],
        prompt_version="society-v1",
    )

    assert call.value == Society(name="Chess Society", email=None)
    assert (call.model, call.prompt_version, call.validation_retried) == (
        "bulk-model-1",
        "society-v1",
        False,
    )
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "bulk-model-1"
    assert body["response_format"] == {"type": "json_object"}
    assert "JSON" in body["messages"][0]["content"]
    assert route.calls[0].request.headers["authorization"] == "Bearer test-llm-key"


def test_strong_tier_uses_the_strong_model(net: respx.MockRouter) -> None:
    route = net.post(COMPLETIONS).mock(return_value=completion('{"name": "x", "email": null}'))
    llm, _ = client()

    call = llm.complete_json(schema=Society, messages=[], prompt_version="v1", tier="strong")

    assert call.model == "strong-model-1"
    assert json.loads(route.calls[0].request.content)["model"] == "strong-model-1"


def test_invalid_reply_is_retried_once_with_the_error(net: respx.MockRouter) -> None:
    route = net.post(COMPLETIONS).mock(
        side_effect=[completion('{"name": 42}'), completion('{"name": "Chess", "email": null}')]
    )
    llm, _ = client()

    call = llm.complete_json(schema=Society, messages=[], prompt_version="v1")

    assert call.value.name == "Chess"
    assert call.validation_retried
    second = json.loads(route.calls[1].request.content)["messages"]
    assert second[-2] == {"role": "assistant", "content": '{"name": 42}'}
    assert "did not validate" in second[-1]["content"]


def test_a_second_invalid_reply_raises(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(side_effect=[completion("not json"), completion("[]")])
    llm, _ = client(fallback=False)

    with pytest.raises(LLMValidationError):
        llm.complete_json(schema=Society, messages=[], prompt_version="v1")


def test_a_fenced_json_reply_is_accepted(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(
        return_value=completion('```json\n{"name": "Chess", "email": null}\n```')
    )
    llm, _ = client()

    assert llm.complete_json(schema=Society, messages=[], prompt_version="v1").value.name == "Chess"


# --- transport retries -----------------------------------------------------------


def test_429_and_5xx_back_off_and_resume(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(
        side_effect=[
            httpx.Response(
                429, json={"error": {"message": "slow down"}}, headers={"retry-after": "3"}
            ),
            httpx.Response(502, json={"error": {"message": "bad gateway"}}),
            completion('{"name": "Chess", "email": null}'),
        ]
    )
    llm, sleeps = client()

    call = llm.complete_json(schema=Society, messages=[], prompt_version="v1")

    assert call.value.name == "Chess"
    assert len(sleeps) == 2
    assert sleeps[0] >= 3.0, "Retry-After is a floor on the wait"


def test_a_400_is_not_retried(net: respx.MockRouter) -> None:
    route = net.post(COMPLETIONS).mock(
        return_value=httpx.Response(400, json={"error": {"message": "bad request"}})
    )
    llm, sleeps = client(fallback=False)

    with pytest.raises(openai.BadRequestError):
        llm.complete_json(schema=Society, messages=[], prompt_version="v1")
    assert route.call_count == 1
    assert sleeps == []


def test_retries_stop_after_max_attempts(net: respx.MockRouter) -> None:
    route = net.post(COMPLETIONS).mock(return_value=httpx.Response(503, json={"error": {}}))
    llm, _ = client(max_attempts=3, fallback=False)

    with pytest.raises(openai.InternalServerError):
        llm.complete_json(schema=Society, messages=[], prompt_version="v1")
    assert route.call_count == 3


# --- the strong fallback (ENG-23) ---------------------------------------------------

VALID = '{"name": "Chess", "email": null}'
#: Scraped text a request carries: it must not reach the fallback's log lines.
SCRAPED = "Join the Example Society at https://example.org/join"

Reply = httpx.Response | Exception


class ByModel:
    """A respx side effect that answers each request from its model's queue
    (a reply, or an httpx exception to raise), and records the models asked."""

    def __init__(self, **replies: list[Reply]) -> None:
        self.replies = {model.replace("_", "-"): list(queue) for model, queue in replies.items()}
        self.models: list[str] = []
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.models.append(body["model"])
        self.bodies.append(body)
        reply = self.replies[body["model"]].pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def error(status: int) -> httpx.Response:
    return httpx.Response(status, json={"error": {"message": f"status {status}"}})


def ask(llm: LLMClient, **kwargs: Any) -> Any:
    return llm.complete_json(
        schema=Society,
        messages=[{"role": "user", "content": f"Extract the society from: {SCRAPED}"}],
        prompt_version="v1",
        **kwargs,
    )


def test_a_bulk_reply_that_never_validates_is_asked_of_the_strong_model(
    net: respx.MockRouter, caplog: pytest.LogCaptureFixture
) -> None:
    replies = ByModel(
        bulk_model_1=[completion("not json"), completion('{"name": 42}')],
        strong_model_1=[completion(VALID)],
    )
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client()

    with caplog.at_level(logging.WARNING, logger="camsocs_pipeline.extract.llm"):
        call = ask(llm)

    assert call.value == Society(name="Chess", email=None)
    # Provenance is the model that answered, and says what it stood in for.
    assert (call.model, call.fallback_from, call.validation_retried) == (
        "strong-model-1",
        "bulk-model-1",
        False,
    )
    assert replies.models == ["bulk-model-1", "bulk-model-1", "strong-model-1"]
    # A fresh request: the bulk model's corrective exchange is not carried over.
    assert replies.bodies[2]["messages"] == replies.bodies[0]["messages"]
    (warning,) = [r for r in caplog.records if r.levelno == logging.WARNING]
    message = warning.getMessage()
    for word in ("bulk-model-1", "strong-model-1", "LLMValidationError", "v1"):
        assert word in message
    assert "Example Society" not in message and "example.org" not in message
    assert "42" not in message


def test_a_successful_call_names_no_fallback(net: respx.MockRouter) -> None:
    net.post(COMPLETIONS).mock(return_value=completion(VALID))
    llm, _ = client()

    assert ask(llm).fallback_from is None


@pytest.mark.parametrize("status", [429, 500, 503])
def test_transient_failures_that_outlast_their_retries_fall_back(
    status: int, net: respx.MockRouter
) -> None:
    replies = ByModel(
        bulk_model_1=[error(status), error(status)],
        strong_model_1=[error(status), completion(VALID)],  # the strong request retries too
    )
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, sleeps = client(max_attempts=2)

    call = ask(llm)

    assert (call.model, call.fallback_from) == ("strong-model-1", "bulk-model-1")
    assert replies.models == ["bulk-model-1"] * 2 + ["strong-model-1"] * 2
    assert len(sleeps) == 2


@pytest.mark.parametrize("status", [400, 404, 413, 422])
def test_a_model_side_http_error_falls_back_at_once(status: int, net: respx.MockRouter) -> None:
    replies = ByModel(bulk_model_1=[error(status)], strong_model_1=[completion(VALID)])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, sleeps = client()

    call = ask(llm)

    assert (call.model, call.fallback_from) == ("strong-model-1", "bulk-model-1")
    assert replies.models == ["bulk-model-1", "strong-model-1"] and sleeps == []


def test_a_timeout_that_outlasts_its_retries_falls_back(net: respx.MockRouter) -> None:
    replies = ByModel(
        bulk_model_1=[httpx.ReadTimeout("slow"), httpx.ReadTimeout("slow")],
        strong_model_1=[completion(VALID)],
    )
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client(max_attempts=2)

    call = ask(llm)

    assert (call.model, call.fallback_from) == ("strong-model-1", "bulk-model-1")
    assert replies.models == ["bulk-model-1", "bulk-model-1", "strong-model-1"]


def test_a_connection_failure_does_not_fall_back(net: respx.MockRouter) -> None:
    """cliproxy unreachable: the strong model is behind the same proxy."""
    replies = ByModel(bulk_model_1=[httpx.ConnectError("refused")] * 2, strong_model_1=[])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client(max_attempts=2)

    with pytest.raises(openai.APIConnectionError) as raised:
        ask(llm)

    assert not isinstance(raised.value, openai.APITimeoutError)
    assert replies.models == ["bulk-model-1", "bulk-model-1"]


@pytest.mark.parametrize(
    ("status", "raised"),
    [(401, openai.AuthenticationError), (403, openai.PermissionDeniedError)],
)
def test_a_key_problem_does_not_fall_back(
    status: int, raised: type[Exception], net: respx.MockRouter
) -> None:
    replies = ByModel(bulk_model_1=[error(status)], strong_model_1=[])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client()

    with pytest.raises(raised):
        ask(llm)
    assert replies.models == ["bulk-model-1"]


def test_a_strong_request_that_fails_has_nothing_to_fall_back_to(net: respx.MockRouter) -> None:
    replies = ByModel(strong_model_1=[error(400)])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client()

    with pytest.raises(openai.BadRequestError):
        ask(llm, tier="strong")
    assert replies.models == ["strong-model-1"]


def test_fallback_false_turns_it_off(net: respx.MockRouter) -> None:
    replies = ByModel(bulk_model_1=[error(400)], strong_model_1=[completion(VALID)])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client(fallback=False)

    with pytest.raises(openai.BadRequestError):
        ask(llm)
    assert replies.models == ["bulk-model-1"]


def test_when_the_strong_model_fails_too_the_bulk_error_is_raised(
    net: respx.MockRouter, caplog: pytest.LogCaptureFixture
) -> None:
    """Callers see the failure they saw before the fallback existed (classify
    catches only `LLMValidationError`); the strong error is noted on it."""
    replies = ByModel(
        bulk_model_1=[completion("not json"), completion("[]")],
        strong_model_1=[error(503), error(503)],
    )
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm, _ = client(max_attempts=2)

    with (
        caplog.at_level(logging.WARNING, logger="camsocs_pipeline.extract.llm"),
        pytest.raises(LLMValidationError, match="bulk-model-1") as raised,
    ):
        ask(llm)

    assert raised.value.__notes__ == ["Fallback to strong-model-1 failed too: InternalServerError"]
    assert isinstance(raised.value.__context__, openai.InternalServerError)
    assert replies.models == ["bulk-model-1"] * 2 + ["strong-model-1"] * 2
    last = caplog.records[-1].getMessage()
    assert "InternalServerError" in last and "status 503" not in last


def test_an_interrupt_never_falls_back() -> None:
    calls: list[str] = []

    def interrupted(**kwargs: Any) -> Any:
        calls.append(kwargs["model"])
        raise KeyboardInterrupt

    openai_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=interrupted))
    )
    llm, _ = client(client=openai_client)

    with pytest.raises(KeyboardInterrupt):
        ask(llm)
    assert calls == ["bulk-model-1"]


def test_the_fallback_never_waits_on_its_own_semaphore_slot(net: respx.MockRouter) -> None:
    """With one slot, the strong request must still get it (no deadlock)."""
    replies = ByModel(bulk_model_1=[error(400)], strong_model_1=[completion(VALID)])
    net.post(COMPLETIONS).mock(side_effect=replies)
    llm = LLMClient(llm_settings(concurrency=1), sleep=lambda _s: None)
    result: list[Any] = []

    def run() -> None:
        result.append(ask(llm))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=10)

    assert not worker.is_alive(), "the fallback deadlocked on the semaphore"
    assert result[0].model == "strong-model-1"


# --- vision -----------------------------------------------------------------------

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


def test_image_type_is_sniffed_from_magic_bytes() -> None:
    assert sniff_image_type(PNG) == "image/png"
    assert sniff_image_type(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert sniff_image_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    with pytest.raises(ValueError):
        sniff_image_type(b"%PDF-1.7")


def test_vision_message_carries_data_urls() -> None:
    message = vision_message("Read the poster.", [PNG])
    assert message["content"][0] == {"type": "text", "text": "Read the poster."}
    url = message["content"][1]["image_url"]["url"]
    assert url == image_data_url(PNG)
    assert url.startswith("data:image/png;base64,")
