"""Harvester run telemetry: counts and durations to PostHog EU (ENG-8).

Three events per run, sent as one fixed, personless distinct id
(`camsocs-harvester`, `$process_person_profile: false`) and tagged with
`environment` (POSTHOG_ENV: `production` on the VPS, else `development`):

- `harvest_run_started` — group, command, the requested stage names, the
  pipeline version and the checkout's commit;
- `harvest_stage_completed` — one per stage, `not_run` included: its status,
  wall-clock seconds, the four counts of `StageReport` and its named
  `metrics` (code-defined counts such as `quarantineHeld`), and for a stage
  that raised, the exception's *class name*;
- `harvest_run_finished` — status (`success`/`partial`/`failed`, derived
  like `deriveRunStatus` in webapp/convex/runs.ts), seconds, stages by
  status, the summed counts and the coverage numbers the `report` stage
  measured.

**What is never sent.** A stage's `error`, `notes` and the run's `warnings`
can carry scraped titles, URLs and server messages (AGENTS.md; the Slack alert
has the same rule, ops/vps/camsocs-alert.py): only counts, durations, statuses,
stage names and exception class names leave the process. Every event's
properties are filtered against a per-event allow-list (`ALLOWED`) and every
string must match its key's own shape (`_SHAPES`: a stage name, a status, an
exception class name, a run key — none allows spaces, slashes or quotes), so a
later change that passes free text by mistake drops it instead of sending it.
talks.cam stages report like any other: counts only. The SDK adds its own
`$lib`, `$lib_version` and `$geoip_disable`; the OS and Python version it
would also merge in are removed before queueing (`_strip_sdk_context`).

**Off by default.** Without POSTHOG_KEY no client is built (the SDK is not
even imported) and every method returns at once — a laptop run, CI and the
test suite send nothing.

**Never in the way.** Every public method catches `Exception` and logs at
debug: telemetry cannot fail or change a run. The SDK queues events for a
background thread (async mode, research-python §1), so `capture` costs
nothing on the run's path. The SDK's own shutdown is not bounded (its queue
drain has no timeout, and its HTTPS adapter adds urllib3 connect retries on
top of `max_retries`), so `close()` runs flush + shutdown on a daemon thread
and waits at most `CLOSE_TIMEOUT` seconds for it: a PostHog outage, a slow
host or a 429 adds at most that to a run, and events still queued then are
dropped. `cli._run` closes the client in a
`finally`, on success and on every failure path. A run killed by `timeout(1)`
(SIGTERM/SIGKILL, exit 124/137) skips `finally`, so its finish event is lost;
the VPS status file and the Slack alert already report those runs
(docs/ops-vps.md), and are the record of truth for them.

**LLM generations (ENG-9).** Every model call made through
`extract/llm.py` is one `$ai_generation` event (PostHog LLM analytics),
captured by hand rather than through the SDK's `posthog.ai.openai` wrapper:
the wrapper would replace the pipeline's OpenAI client, sends the prompt and
reply unless privacy mode is on, and still sends `$ai_base_url`, model
parameters and an `$ai_error` object; a manual capture sends only what this
module allow-lists. A generation carries the model id, `$ai_provider`
`cliproxy`, the token counts the proxy reported, the final attempt's latency,
the HTTP status (when there was one), `$ai_is_error`, the run key as
`$ai_trace_id`, the stage as `$ai_span_name`, the tier, the prompt version, the
attempt count and, on failure, the exception's class name. **Never** the
messages (`$ai_input`), the reply (`$ai_output_choices`), error text
(`$ai_error`), the base URL or any scraped text — the messages hold scraped
pages and mail. The client has no notion of a run: `run_started` makes this
instance the process's *active* telemetry (`active_telemetry`), stages run
one after another, and `stage_started` names the stage the calls belong to;
the stages' worker threads read it from there. talks.cam stages never call the
model at all (the `llm_tripwire` tests prove it), so they report no
generations. PostHog prices a generation from `$ai_provider` + `$ai_model`;
cliproxy's models are behind a subscription and match no public price list, so
any cost PostHog shows for them is indicative at best.

The SDK uses `requests`, which respx does not intercept: tests inject a fake
client (`HarvestTelemetry(client=…)`) and never build a real one, and
conftest refuses any `requests` transport (tests/conftest.py).
"""

from __future__ import annotations

import functools
import logging
import re
import subprocess
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Protocol

from camsocs_pipeline import __version__
from camsocs_pipeline.config import (
    DEFAULT_POSTHOG_ENV,
    DEFAULT_POSTHOG_HOST,
    REPO_ROOT,
    Settings,
)
from camsocs_pipeline.pipeline.report import RunReport, StageReport, mint_run_key

logger = logging.getLogger(__name__)

#: The one distinct id every harvester event is sent as: no person, no device.
DISTINCT_ID = "camsocs-harvester"

RUN_STARTED = "harvest_run_started"
STAGE_COMPLETED = "harvest_stage_completed"
RUN_FINISHED = "harvest_run_finished"
AI_GENERATION = "$ai_generation"

#: `$ai_provider` on every generation: the OpenAI-compatible local proxy
#: (`LLM_BASE_URL`) the pipeline talks to, whatever serves it upstream.
AI_PROVIDER = "cliproxy"

#: Upload timeout (s) and retries per batch. The SDK defaults (15 s, 3
#: retries) could hold a run's exit for a minute when PostHog is unreachable.
REQUEST_TIMEOUT = 5.0
MAX_RETRIES = 1
#: How long `close()` lets the SDK's flush wait for the queue to drain.
FLUSH_TIMEOUT = 5.0
#: The hard limit on `close()` as a whole (flush + shutdown), enforced on the
#: caller's thread: the SDK's `shutdown()` has no timeout of its own.
CLOSE_TIMEOUT = FLUSH_TIMEOUT + 1.0

#: Run statuses (report.RUN_STATUSES without `running`) and stage statuses.
_STATUSES = frozenset({"success", "partial", "failed", "ok", "not_run"})
#: What the SDK merges into every event (`posthog.utils.system_context`) that
#: is not ours to send: the host's OS and Python version.
_SDK_CONTEXT = ("$os", "$os_version", "$os_distro", "$python_runtime", "$python_version")

#: Properties every event may carry.
_COMMON = frozenset({"environment", "runKey", "group", "dryRun", "$process_person_profile"})

#: The only properties each event may send; anything else is dropped (and
#: logged at debug). Tests assert against this, so widening it is a reviewed
#: change. Never add `error`, `notes`, `warnings`, titles or URLs.
ALLOWED: Mapping[str, frozenset[str]] = {
    RUN_STARTED: _COMMON
    | {"command", "requestedStages", "stageCount", "limit", "pipelineVersion", "revision"},
    STAGE_COMPLETED: _COMMON
    | {
        "stage",
        "status",
        "durationS",
        "inserted",
        "updated",
        "unchanged",
        "skipped",
        "metrics",
        "errorType",
    },
    RUN_FINISHED: _COMMON
    | {
        "command",
        "status",
        "durationS",
        "stagesOk",
        "stagesFailed",
        "stagesNotRun",
        "failedStages",
        "inserted",
        "updated",
        "unchanged",
        "skipped",
        "warningsCount",
        "runError",
        "errorType",
        "coverage",
    },
    # No `$ai_input`, `$ai_output_choices`, `$ai_error`, `$ai_base_url` or
    # `$ai_request_url`, ever: tests assert this set leaves them out.
    AI_GENERATION: _COMMON
    | {
        "$ai_trace_id",
        "$ai_span_name",
        "$ai_model",
        "$ai_provider",
        "$ai_input_tokens",
        "$ai_output_tokens",
        "$ai_latency",
        "$ai_http_status",
        "$ai_is_error",
        "stage",
        "tier",
        "promptVersion",
        "attempts",
        "validationRetry",
        "errorType",
    },
}

_STAGE = re.compile(r"[a-z][a-z0-9_]{0,63}")
#: A metric or coverage name: camelCase, as the stages write them.
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_REVISION = re.compile(r"[0-9a-f]{7,40}")
_RUN_KEY = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{6}")  # report.mint_run_key

#: The shape each string property must have; a string under any other key, or
#: one that does not match, is dropped. No shape allows a space (beyond the
#: fixed `sync --group` form), a slash or a quote, so titles, names, URLs and
#: server messages cannot pass.
_SHAPES: Mapping[str, re.Pattern[str]] = {
    "environment": re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,31}"),
    "runKey": _RUN_KEY,
    "group": _STAGE,
    "command": re.compile(r"sync(?: --group [a-z][a-z0-9_]{0,31})?"),
    "stage": _STAGE,
    "requestedStages": _STAGE,
    "failedStages": _STAGE,
    "errorType": re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,79}"),
    "pipelineVersion": re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_\-]{0,39}"),
    "revision": _REVISION,
    "$ai_trace_id": _RUN_KEY,
    "$ai_span_name": _STAGE,
    # A model id as `extract.llm.assert_model_allowed` admits it, from config.
    "$ai_model": re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,99}"),
    "$ai_provider": re.compile(r"[a-z][a-z0-9_\-]{0,31}"),
    "tier": re.compile(r"bulk|strong"),
    "promptVersion": _STAGE,  # `email_events_v1`, `redact_names_v2`
}


class _Client(Protocol):
    """The part of `posthog.Posthog` this module uses (posthog-python 7.x)."""

    def capture(self, event: str, **kwargs: Any) -> str | None: ...

    def flush(self, timeout_seconds: float | None = ...) -> None: ...

    def shutdown(self) -> None: ...


def _string_ok(key: str, value: object) -> bool:
    if not isinstance(value, str):
        return False
    if key == "status":
        return value in _STATUSES
    shape = _SHAPES.get(key)
    return shape is not None and shape.fullmatch(value) is not None


def _clean_value(key: str, value: object) -> object | None:
    """`value` if it is a count, a flag, a string of `key`'s shape (or a list
    of those), or a name→number mapping, else `None` (dropped)."""
    if isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        return value if _string_ok(key, value) else None
    if isinstance(value, list | tuple):
        items = [item for item in value if _string_ok(key, item)]
        return items if len(items) == len(value) else None
    if isinstance(value, Mapping):
        return {
            key: number
            for key, number in value.items()
            if isinstance(key, str)
            and _NAME.fullmatch(key)
            and isinstance(number, int | float)
            and not isinstance(number, bool)
        }
    return None


def clean_properties(event: str, properties: Mapping[str, object]) -> dict[str, object]:
    """`properties` restricted to `ALLOWED[event]` and to safe value shapes."""
    allowed = ALLOWED[event]
    cleaned: dict[str, object] = {}
    for key, value in properties.items():
        if value is None:
            continue
        if key not in allowed:
            logger.debug("telemetry: %s dropped property %s (not allow-listed)", event, key)
            continue
        safe = _clean_value(key, value)
        if safe is None:
            logger.debug("telemetry: %s dropped property %s (not a count or id)", event, key)
            continue
        cleaned[key] = safe
    return cleaned


def _logged(body: Callable[[], None]) -> Callable[[], None]:
    """`body` for a background thread: failures logged at debug, not printed."""

    def run() -> None:
        try:
            body()
        except Exception:
            logger.debug("telemetry: background close failed", exc_info=True)

    return run


def _quiet[**P](method: Callable[P, None]) -> Callable[P, None]:
    """Telemetry never raises into the pipeline: log at debug and carry on."""

    @functools.wraps(method)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> None:
        try:
            method(*args, **kwargs)
        except Exception:
            logger.debug("telemetry: %s failed", method.__name__, exc_info=True)

    return wrapper


def _revision() -> str | None:
    """The checkout's commit (12 hex digits), as the VPS status file records
    it (camsocs-harvest.sh `write_status`); `None` when git cannot tell."""
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short=12", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and _REVISION.fullmatch(value) else None


def _strip_sdk_context(message: dict[str, Any]) -> dict[str, Any]:
    """The SDK's `before_send` hook (runs after it merged its system context):
    drop the host's OS and Python version from the event."""
    properties = message.get("properties")
    if isinstance(properties, dict):
        for key in _SDK_CONTEXT:
            properties.pop(key, None)
    return message


def _posthog_client(settings: Settings) -> _Client:
    # Imported here: without a key the SDK (and its threads) never load.
    from posthog import Posthog

    return Posthog(
        settings.posthog_key.get_secret_value().strip(),
        host=settings.posthog_host or DEFAULT_POSTHOG_HOST,
        timeout=REQUEST_TIMEOUT,
        max_retries=MAX_RETRIES,
        disable_geoip=True,
        before_send=_strip_sdk_context,
    )


def _count(usage: Mapping[str, object] | None, key: str) -> int | None:
    """A token count from the OpenAI-shaped `usage`, if it is one."""
    value = usage.get(key) if usage is not None else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


_active_lock = threading.Lock()
_active: HarvestTelemetry | None = None


def active_telemetry() -> HarvestTelemetry | None:
    """The telemetry of the run in progress in this process, if any — where
    `extract.llm.LLMClient` sends its generations."""
    return _active


def _activate(telemetry: HarvestTelemetry) -> None:
    global _active
    with _active_lock:
        _active = telemetry


def _deactivate(telemetry: HarvestTelemetry) -> None:
    global _active
    with _active_lock:
        if _active is telemetry:
            _active = None


def _sum(stages: Iterable[StageReport], field: str) -> int:
    return sum(getattr(stage, field) for stage in stages)


class HarvestTelemetry:
    """One run's telemetry. Built by `from_settings` (or with a fake client in
    tests); a disabled instance (no client) does nothing at all."""

    def __init__(
        self,
        client: _Client | None = None,
        *,
        environment: str = DEFAULT_POSTHOG_ENV,
        revision: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._environment = environment or DEFAULT_POSTHOG_ENV
        self._revision = revision
        self._clock = clock
        self._created = clock()
        self._started: float | None = None
        self._common: dict[str, object] = {}
        self._finished = False
        #: The stage now running (for generations), and the trace id a
        #: generation outside any run would carry.
        self._stage: str | None = None
        self._trace_id = mint_run_key()

    @classmethod
    def from_settings(
        cls,
        settings: Settings,
        *,
        client_factory: Callable[[Settings], _Client] | None = None,
    ) -> HarvestTelemetry:
        """Telemetry for `settings`: disabled without POSTHOG_KEY, and also
        when the client cannot be built (logged at debug, never raised).
        `client_factory` defaults to the real PostHog client."""
        if not settings.posthog_configured:
            return cls()
        try:
            client = (client_factory or _posthog_client)(settings)
        except Exception:
            logger.debug("telemetry: PostHog client not built; telemetry off", exc_info=True)
            return cls()
        return cls(client, environment=settings.posthog_env, revision=_revision())

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def _capture(self, event: str, properties: Mapping[str, object]) -> None:
        if self._client is None:
            return
        cleaned = clean_properties(
            event, {"environment": self._environment, **self._common, **properties}
        )
        cleaned["$process_person_profile"] = False
        self._client.capture(event, distinct_id=DISTINCT_ID, properties=cleaned)

    def _elapsed(self) -> float:
        start = self._started if self._started is not None else self._created
        return round(self._clock() - start, 3)

    @_quiet
    def run_started(
        self,
        report: RunReport,
        *,
        group: str | None,
        stages: Sequence[str],
        limit: int | None = None,
    ) -> None:
        _activate(self)
        self._started = self._clock()
        self._common = {"runKey": report.run_key, "group": group, "dryRun": report.dry_run}
        self._capture(
            RUN_STARTED,
            {
                "command": report.command,
                "requestedStages": list(stages),
                "stageCount": len(stages),
                "limit": limit,
                "pipelineVersion": __version__,
                "revision": self._revision,
            },
        )

    @_quiet
    def stage_started(self, name: str) -> None:
        """Name the stage that the generations from now on belong to."""
        self._stage = name

    @_quiet
    def stage_completed(
        self, stage: StageReport, *, duration_s: float, error_type: str | None = None
    ) -> None:
        self._stage = None
        self._capture(
            STAGE_COMPLETED,
            {
                "stage": stage.name,
                "status": stage.status,
                "durationS": round(duration_s, 3),
                "inserted": stage.inserted,
                "updated": stage.updated,
                "unchanged": stage.unchanged,
                "skipped": stage.skipped,
                "metrics": dict(stage.metrics) or None,
                "errorType": error_type if stage.status == "failed" else None,
            },
        )

    @_quiet
    def run_finished(self, report: RunReport, *, error_type: str | None = None) -> None:
        """The run's outcome. `error_type` is the class of an exception that
        ended the run early (health, `runs.start`); sent at most once. The
        instance stops being the active telemetry."""
        _deactivate(self)
        if self._finished:
            return
        self._finished = True
        stages = report.stages
        coverage = next(
            (dict(s.metrics) for s in stages if s.name == "report" and s.ok and s.metrics), None
        )
        self._capture(
            RUN_FINISHED,
            {
                "command": report.command,
                "status": _run_status(report, error_type),
                "durationS": self._elapsed(),
                "stagesOk": sum(1 for s in stages if s.status == "ok"),
                "stagesFailed": sum(1 for s in stages if s.status == "failed"),
                "stagesNotRun": sum(1 for s in stages if s.status == "not_run"),
                "failedStages": [s.name for s in stages if s.status == "failed"],
                "inserted": _sum(stages, "inserted"),
                "updated": _sum(stages, "updated"),
                "unchanged": _sum(stages, "unchanged"),
                "skipped": _sum(stages, "skipped"),
                # The runner's warnings only: one the CLI adds afterwards
                # (derive not scheduled) is in the status file, not here.
                "warningsCount": len(report.warnings),
                "runError": report.error is not None,
                "errorType": error_type,
                "coverage": coverage,
            },
        )

    @_quiet
    def run_aborted(self, error: BaseException, *, group: str | None, command: str) -> None:
        """A failed `harvest_run_finished` for a run that ended before
        `run_finished` could be sent — a bad `--stages`, a group's missing
        inputs, missing credentials. A no-op once the run reported itself."""
        _deactivate(self)
        if self._finished:
            return
        self._finished = True
        self._capture(
            RUN_FINISHED,
            {
                "group": group,
                "command": command,
                "status": "failed",
                "durationS": self._elapsed(),
                "errorType": type(error).__name__,
            },
        )

    @_quiet
    def generation(
        self,
        *,
        model: str,
        tier: str,
        prompt_version: str,
        latency_s: float,
        attempts: int,
        usage: Mapping[str, object] | None = None,
        http_status: int | None = None,
        error_type: str | None = None,
        validation_retry: bool = False,
    ) -> None:
        """One `$ai_generation`: an `LLMClient` request, retries included.
        `latency_s` is the final attempt's; `error_type` the class name of the
        exception that ended it (never its message). Takes no messages, reply
        or error text, so it cannot send them."""
        self._capture(
            AI_GENERATION,
            {
                "$ai_trace_id": self._common.get("runKey") or self._trace_id,
                "$ai_span_name": self._stage,
                "stage": self._stage,
                "$ai_model": model,
                "$ai_provider": AI_PROVIDER,
                "$ai_input_tokens": _count(usage, "prompt_tokens"),
                "$ai_output_tokens": _count(usage, "completion_tokens"),
                "$ai_latency": round(latency_s, 3),
                "$ai_http_status": http_status,
                "$ai_is_error": error_type is not None,
                "tier": tier,
                "promptVersion": prompt_version,
                "attempts": attempts,
                "validationRetry": validation_retry,
                "errorType": error_type,
            },
        )

    @_quiet
    def close(self) -> None:
        """Deliver what is queued, then stop the SDK's workers — returning
        within `CLOSE_TIMEOUT` seconds whatever PostHog does. Idempotent; the
        instance is disabled afterwards.

        flush + shutdown run on a daemon thread joined with that deadline:
        `shutdown()` drains with no timeout, so a slow or rate-limiting host
        would otherwise hold the run's exit for minutes. A thread still busy
        at the deadline is abandoned; the SDK's consumers are daemon threads
        and its atexit hook returns at once while this one owns shutdown, so
        the process still exits."""
        _deactivate(self)
        client, self._client = self._client, None
        if client is None:
            return

        def drain() -> None:
            try:
                client.flush(timeout_seconds=FLUSH_TIMEOUT)
            finally:
                client.shutdown()

        worker = threading.Thread(target=_logged(drain), name="posthog-close", daemon=True)
        worker.start()
        worker.join(CLOSE_TIMEOUT)
        if worker.is_alive():
            logger.debug(
                "telemetry: close gave up after %.0fs; queued events dropped", CLOSE_TIMEOUT
            )


def _run_status(report: RunReport, error_type: str | None) -> str:
    """`success`, `partial` or `failed`, as `deriveRunStatus` derives a run's
    status server-side (webapp/convex/runs.ts), so PostHog and harvestRuns
    agree."""
    if error_type is not None or report.error is not None:
        return "failed"
    not_ok = sum(1 for stage in report.stages if stage.status != "ok")
    if not_ok == 0:
        return "success"
    return "failed" if not_ok == len(report.stages) else "partial"


__all__ = [
    "AI_GENERATION",
    "AI_PROVIDER",
    "ALLOWED",
    "CLOSE_TIMEOUT",
    "DISTINCT_ID",
    "FLUSH_TIMEOUT",
    "RUN_FINISHED",
    "RUN_STARTED",
    "STAGE_COMPLETED",
    "HarvestTelemetry",
    "active_telemetry",
    "clean_properties",
]
