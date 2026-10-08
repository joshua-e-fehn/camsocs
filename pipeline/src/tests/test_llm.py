"""The LLM client: the claude* guard, JSON validation with one corrective retry,
transport retries, provenance, and the vision helper. All offline (respx)."""

from __future__ import annotations

import json

import httpx
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
    llm, _ = client()

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
    import openai

    route = net.post(COMPLETIONS).mock(
        return_value=httpx.Response(400, json={"error": {"message": "bad request"}})
    )
    llm, sleeps = client()

    with pytest.raises(openai.BadRequestError):
        llm.complete_json(schema=Society, messages=[], prompt_version="v1")
    assert route.call_count == 1
    assert sleeps == []


def test_retries_stop_after_max_attempts(net: respx.MockRouter) -> None:
    import openai

    route = net.post(COMPLETIONS).mock(return_value=httpx.Response(503, json={"error": {}}))
    llm, _ = client(max_attempts=3)

    with pytest.raises(openai.InternalServerError):
        llm.complete_json(schema=Society, messages=[], prompt_version="v1")
    assert route.call_count == 3


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
