"""Structured extraction through an OpenAI-compatible endpoint.

The client talks to `LLM_BASE_URL` (a local OpenAI-compatible proxy) with model
ids from config — `LLM_MODEL_BULK` for the many cheap calls, `LLM_MODEL_STRONG`
for hard pages and vision. There is no LLM precedent in the reference repos;
the shape here follows the pipeline's own rules:

- **Hard guard on the model id.** Any model id whose name (or any `/`-separated
  segment of it) starts with `claude` is refused with `ModelRefused` — at
  config time, at client construction, and again on every call — so no code
  path can send a request to one.
- **Structured output, validated.** Requests ask for a JSON object
  (`response_format={"type": "json_object"}`) and the reply is validated with a
  pydantic model. On a decode/validation failure the call is retried **once**
  with the error appended to the conversation; a second failure raises
  `LLMValidationError`.
- **Retries for the transport, not the content.** 429, 5xx, timeouts and
  connection errors back off exponentially with full jitter (honouring
  `Retry-After`, capped) and resume; 4xx other than 429 is raised at once. No
  proactive throttling: concurrency is bounded by a semaphore
  (`LLM_CONCURRENCY`, default 8) and the server's 429s do the rest. The SDK's
  own retries are disabled so there is exactly one retry policy.
- **Provenance per call.** Every `LLMCall` records the `model` and the
  `prompt_version` it was made with, for storing beside each extracted claim.

LLM output is never trusted on its own: `extract.evidence` checks that each
claim's quoted evidence actually appears in the source text and downgrades
unsupported claims to `inferred`.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
import openai
from pydantic import BaseModel, ValidationError
from tenacity import (
    RetryCallState,
    Retrying,
    retry_if_exception,
    stop_after_attempt,
    wait_random_exponential,
)

from camsocs_pipeline.config import LLMSettings
from camsocs_pipeline.sources.policy import NEVER_OVERRIDE_HOSTS

logger = logging.getLogger(__name__)

Tier = Literal["bulk", "strong"]

#: Attempts per request for transient failures (429/5xx/transport).
DEFAULT_MAX_ATTEMPTS = 6
#: Ceiling on any single backoff wait, including a server's `Retry-After`.
MAX_WAIT = 300.0
DEFAULT_TIMEOUT = 180.0


class ModelRefused(ValueError):
    """The configured model id is not allowed for this pipeline."""


class NoLLMHost(ValueError):
    """Content from a host that keeps AI out was about to reach the model."""


#: Hosts whose content never reaches a language model, whatever the stage:
#: their robots.txt blocks AI agents by name (source-research "Global rules",
#: §6), and no fetch purpose overrides that (`sources.policy`, D3). A stage
#: checks each page's own host with `PoliteClient.ai_input_allowed` as well;
#: this list holds even when that check is missed.
NO_LLM_HOSTS = NEVER_OVERRIDE_HOSTS


def assert_llm_source_allowed(url: str) -> None:
    """Raise `NoLLMHost` when `url` is on a host whose content never reaches
    the model. Called by every stage before it sends fetched content."""
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    if any(host == blocked or host.endswith("." + blocked) for blocked in NO_LLM_HOSTS):
        raise NoLLMHost(f"{host} content is never passed to the LLM (source-research §6)")


class LLMValidationError(RuntimeError):
    """The model's reply did not validate, even after one corrective retry."""


#: Words that mark an Anthropic model however a gateway spells its id
#: (`claude-…`, `anthropic/claude-…`, Bedrock `us.anthropic.claude-…`,
#: Vertex `vertex_ai:claude-…`).
_REFUSED_MODEL_WORDS = ("claude", "anthropic")


def assert_model_allowed(model: str) -> str:
    """Return the stripped model id, or raise `ModelRefused`.

    Refuses an empty id, any id that is not plain printable ASCII after NFKC
    normalisation (a zero-width space or a Cyrillic capital Es would otherwise slip
    a `claude` id past the check), and any id that contains `claude` or
    `anthropic` anywhere, case-insensitively — whatever the provider prefix or
    separator (`/`, `:`, `.`, `@`).
    """
    stripped = model.strip()
    if not stripped:
        raise ModelRefused("No model id configured.")
    normalised = unicodedata.normalize("NFKC", stripped)
    if not (normalised.isascii() and normalised.isprintable()) or normalised != stripped:
        raise ModelRefused(
            f"Model {stripped!r} is refused: a model id must be plain printable ASCII."
        )
    lowered = normalised.lower()
    if any(word in lowered for word in _REFUSED_MODEL_WORDS):
        raise ModelRefused(
            f"Model {stripped!r} is refused: this pipeline must not call claude* models. "
            "Set LLM_MODEL_BULK / LLM_MODEL_STRONG to another model."
        )
    return stripped


@dataclass(frozen=True)
class LLMCall[T: BaseModel]:
    """One validated extraction and how it was made."""

    value: T
    model: str
    prompt_version: str
    #: True when the first reply failed validation and the corrective retry succeeded.
    validation_retried: bool
    raw: str
    usage: dict[str, Any] | None = None


@dataclass(frozen=True)
class _RawReply:
    text: str
    usage: dict[str, Any] | None


def _is_transient(error: BaseException) -> bool:
    if isinstance(error, openai.APIConnectionError):  # includes APITimeoutError
        return True
    if isinstance(error, openai.APIStatusError):
        return error.status_code == 429 or error.status_code >= 500
    return False


def _retry_after(error: BaseException | None) -> float | None:
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    value = headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


_exponential = wait_random_exponential(multiplier=1, max=60)


def _wait(state: RetryCallState) -> float:
    """Full-jitter exponential backoff, raised to the server's `Retry-After`."""
    error = state.outcome.exception() if state.outcome else None
    wait = _exponential(state)
    retry_after = _retry_after(error)
    if retry_after is not None:
        wait = max(wait, retry_after)
    return min(wait, MAX_WAIT)


class LLMClient:
    """A thread-safe extraction client. Share one per run across worker threads."""

    def __init__(
        self,
        settings: LLMSettings,
        *,
        client: openai.OpenAI | None = None,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._models: dict[Tier, str] = {
            "bulk": assert_model_allowed(settings.model_bulk),
            "strong": assert_model_allowed(settings.model_strong),
        }
        # An explicit `httpx.Client`: the SDK (3.x) defaults to its own `httpx2`
        # fork, and passing ours keeps the whole pipeline on one HTTP stack — the
        # one the test suite's network guard (respx) intercepts.
        self._client = client or openai.OpenAI(
            base_url=settings.base_url,
            api_key=settings.api_key.get_secret_value(),
            max_retries=0,
            http_client=httpx.Client(timeout=DEFAULT_TIMEOUT),
        )
        self._semaphore = threading.BoundedSemaphore(settings.concurrency)
        self._max_attempts = max_attempts
        self._sleep = sleep

    def model_for(self, tier: Tier) -> str:
        return self._models[tier]

    def complete_json[T: BaseModel](
        self,
        *,
        schema: type[T],
        messages: Sequence[dict[str, Any]],
        prompt_version: str,
        tier: Tier = "bulk",
        temperature: float = 0.0,
    ) -> LLMCall[T]:
        """Ask for a JSON object matching `schema`, validate it, retry once on failure."""
        model = assert_model_allowed(self.model_for(tier))
        conversation: list[dict[str, Any]] = [_schema_instruction(schema), *messages]

        raw = self._complete(model, conversation, temperature)
        try:
            value = _parse(schema, raw.text)
            return LLMCall(value, model, prompt_version, False, raw.text, raw.usage)
        except (ValidationError, ValueError) as first_error:
            logger.info("Reply failed validation (%s); retrying once with the error", model)
            conversation += [
                {"role": "assistant", "content": raw.text},
                {
                    "role": "user",
                    "content": (
                        "Your reply did not validate against the required JSON schema:\n"
                        f"{_short(first_error)}\n"
                        "Reply again with only the corrected JSON object."
                    ),
                },
            ]

        retry = self._complete(model, conversation, temperature)
        try:
            value = _parse(schema, retry.text)
        except (ValidationError, ValueError) as second_error:
            raise LLMValidationError(
                f"{model} reply did not validate after one corrective retry "
                f"(prompt {prompt_version}): {_short(second_error)}"
            ) from second_error
        return LLMCall(value, model, prompt_version, True, retry.text, retry.usage)

    # -- transport -------------------------------------------------------------

    def _complete(
        self, model: str, messages: list[dict[str, Any]], temperature: float
    ) -> _RawReply:
        retrying = Retrying(
            retry=retry_if_exception(_is_transient),
            wait=_wait,
            stop=stop_after_attempt(self._max_attempts),
            sleep=self._sleep,
            reraise=True,
            before_sleep=lambda state: logger.warning(
                "LLM %s transient failure (%s), attempt %d — backing off %.1fs",
                model,
                type(state.outcome.exception()).__name__ if state.outcome else "?",
                state.attempt_number,
                state.next_action.sleep if state.next_action else 0.0,
            ),
        )
        with self._semaphore:
            response = retrying(
                self._client.chat.completions.create,
                model=model,
                messages=messages,
                response_format={"type": "json_object"},
                temperature=temperature,
            )
        text = response.choices[0].message.content or ""
        usage = response.usage.model_dump() if response.usage is not None else None
        return _RawReply(text, usage)


def _schema_instruction(schema: type[BaseModel]) -> dict[str, Any]:
    """The system message that asks for JSON (json_object mode requires the word)
    and states the exact schema."""
    return {
        "role": "system",
        "content": (
            "Respond with a single JSON object and nothing else. It must validate against "
            "this JSON Schema:\n" + json.dumps(schema.model_json_schema(), separators=(",", ":"))
        ),
    }


def _parse[T: BaseModel](schema: type[T], text: str) -> T:
    return schema.model_validate_json(_strip_fences(text))


def _strip_fences(text: str) -> str:
    """Tolerate a ```json fence around the object; nothing more lenient."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def _short(error: Exception, limit: int = 1500) -> str:
    text = str(error)
    return text if len(text) <= limit else text[:limit] + " …"


# --- vision -------------------------------------------------------------------

_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff_image_type(data: bytes) -> str:
    """The image MIME type from magic bytes. Raises for anything unrecognised."""
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Unrecognised image format (expected PNG, JPEG, GIF or WebP).")


def image_data_url(data: bytes, mime_type: str | None = None) -> str:
    """`data:<mime>;base64,…` for an image, for the strong model's vision input."""
    mime = mime_type or sniff_image_type(data)
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def vision_message(prompt: str, images: Sequence[bytes]) -> dict[str, Any]:
    """A user message carrying text plus images (OpenAI content-part format).
    Send it with `complete_json(..., tier="strong")`."""
    parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    parts.extend(
        {"type": "image_url", "image_url": {"url": image_data_url(image)}} for image in images
    )
    return {"role": "user", "content": parts}


__all__ = [
    "LLMCall",
    "LLMClient",
    "LLMValidationError",
    "ModelRefused",
    "assert_model_allowed",
    "image_data_url",
    "sniff_image_type",
    "vision_message",
]
