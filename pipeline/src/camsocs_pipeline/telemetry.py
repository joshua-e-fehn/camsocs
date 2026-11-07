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
attempt count, whether it was the strong fallback after a failed bulk request
(`fallback`, ENG-23) and, on failure, the exception's class name. **Never** the
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

**Campus, pillars, fetches and traces (L6, decision D8).** Every event
carries `campus` (the process's campus, `campuses.active()`, only an id the
registry knows). `harvest_stage_completed` adds the stage's `pillar`, its
`phase` and its `yield` (inserted + updated + unchanged); `harvest_run_started`
adds `timeLimitS` when the runner states it (`CAMSOCS_TIME_LIMIT_S`). After
each stage, one `harvest_source_fetched` per host class the stage fetched
from (`fetch_stats.HOST_CLASSES`: a class, never a host or URL) carries the
fetch counters. The run is one PostHog trace: `$ai_trace` at its end (the
run key as `$ai_trace_id`, the group as `$ai_span_name`), one `$ai_span` per
stage (``<runKey>.<stage>``, parent the run) and each generation's
`$ai_parent_id` its stage's span. `$ai_input`, `$ai_output_choices`,
`$ai_input_state` and `$ai_output_state` are never allowed
(`FORBIDDEN_AI_KEYS`, asserted at import and by the tests): spans carry
names, ids, latencies and flags only.

The SDK uses `requests`, which respx does not intercept: tests inject a fake
client (`HarvestTelemetry(client=…)`) and never build a real one, and
conftest refuses any `requests` transport (tests/conftest.py).
"""

from __future__ import annotations

import functools
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, Protocol

from camsocs_pipeline import __version__
from camsocs_pipeline.config import (
    DEFAULT_POSTHOG_ENV,
    DEFAULT_POSTHOG_HOST,
    REPO_ROOT,
    Settings,
)
from camsocs_pipeline.fetch_stats import CLASS_COUNTERS, HOST_CLASSES
from camsocs_pipeline.pipeline.report import RunReport, StageReport, mint_run_key

logger = logging.getLogger(__name__)

#: The one distinct id every harvester event is sent as: no person, no device.
DISTINCT_ID = "camsocs-harvester"

RUN_STARTED = "harvest_run_started"
STAGE_COMPLETED = "harvest_stage_completed"
RUN_FINISHED = "harvest_run_finished"
SOURCE_FETCHED = "harvest_source_fetched"
AI_GENERATION = "$ai_generation"
AI_SPAN = "$ai_span"
AI_TRACE = "$ai_trace"

#: PostHog's content properties: never sent, by any event (L6).
FORBIDDEN_AI_KEYS = frozenset(
    {"$ai_input", "$ai_output_choices", "$ai_input_state", "$ai_output_state"}
)

#: The runner's time limit for the run, in seconds (camsocs-harvest.sh).
TIME_LIMIT_ENV = "CAMSOCS_TIME_LIMIT_S"

#: Mirrors `pipeline.context.PHASES` / `PILLARS` (asserted by the tests;
#: not imported, to keep this module free of the runner's imports).
_PHASES = frozenset(
    {
        "seed",
        "harvest",
        "resolve",
        "enrich",
        "classify",
        "events",
        "inbox",
        "load",
        "talks",
        "report",
    }
)
_PILLARS = frozenset({"societies", "events", "talks", "shared"})

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
_COMMON = frozenset(
    {"environment", "campus", "runKey", "group", "dryRun", "$process_person_profile"}
)

#: The only properties each event may send; anything else is dropped (and
#: logged at debug). Tests assert against this, so widening it is a reviewed
#: change. Never add `error`, `notes`, `warnings`, titles or URLs.
ALLOWED: Mapping[str, frozenset[str]] = {
    RUN_STARTED: _COMMON
    | {
        "command",
        "requestedStages",
        "stageCount",
        "limit",
        "pipelineVersion",
        "revision",
        "timeLimitS",
    },
    STAGE_COMPLETED: _COMMON
    | {
        "stage",
        "status",
        "pillar",
        "phase",
        "durationS",
        "inserted",
        "updated",
        "unchanged",
        "skipped",
        "yield",
        "metrics",
        "errorType",
    },
    SOURCE_FETCHED: _COMMON | {"stage", "pillar", "hostClass", "durationS", *CLASS_COUNTERS},
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
        "$ai_span_id",
        "$ai_parent_id",
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
        "fallback",
        "errorType",
    },
    # A stage: names, ids, a latency and a flag — never inputs or outputs.
    AI_SPAN: _COMMON
    | {
        "$ai_trace_id",
        "$ai_span_id",
        "$ai_parent_id",
        "$ai_span_name",
        "$ai_latency",
        "$ai_is_error",
        "pillar",
    },
    # The run.
    AI_TRACE: _COMMON | {"$ai_trace_id", "$ai_span_name", "$ai_latency", "$ai_is_error"},
}
for _event, _keys in ALLOWED.items():
    if _keys & FORBIDDEN_AI_KEYS:  # pragma: no cover - a reviewed widening never does this
        raise AssertionError(f"{_event} allow-lists a forbidden $ai_* property")

_STAGE = re.compile(r"[a-z][a-z0-9_]{0,63}")
#: A metric or coverage name: camelCase, as the stages write them.
_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_REVISION = re.compile(r"[0-9a-f]{7,40}")
_RUN_KEY_PATTERN = r"\d{8}T\d{6}Z-[0-9a-f]{6}"  # report.mint_run_key
_RUN_KEY = re.compile(_RUN_KEY_PATTERN)
#: A stage span ``<runKey>.<stage>``.
_SPAN_PATTERN = rf"{_RUN_KEY_PATTERN}\.[a-z][a-z0-9_]{{0,63}}"

#: The shape each string property must have; a string under any other key, or
#: one that does not match, is dropped. No shape allows a space (beyond the
#: fixed `sync --group` form) or a quote, and none but `$ai_model` a slash, so
#: titles, names, URLs and server messages cannot pass. `$ai_model` admits a
#: single slash for gateway ids (``openai/gpt-…``) but never ``//``, so it
#: cannot hold a URL either; its value only ever comes from config.
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
    "campus": re.compile(r"[a-z]{2,8}"),
    "hostClass": re.compile("|".join(HOST_CLASSES)),
    "$ai_trace_id": _RUN_KEY,
    "$ai_span_name": _STAGE,
    # A stage span, or a generation's own id (uuid4 hex).
    "$ai_span_id": re.compile(rf"{_SPAN_PATTERN}|[0-9a-f]{{32}}"),
    # The run (a span's parent) or a stage span (a generation's parent).
    "$ai_parent_id": re.compile(rf"{_RUN_KEY_PATTERN}|{_SPAN_PATTERN}"),
    # A model id as `extract.llm.assert_model_allowed` admits it, from config.
    "$ai_model": re.compile(r"(?!.*//)[A-Za-z0-9][A-Za-z0-9._:@/\-]{0,99}"),
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
    if key == "pillar":
        return value in _PILLARS
    if key == "phase":
        return value in _PHASES
    shape = _SHAPES.get(key)
    if shape is None or shape.fullmatch(value) is None:
        return False
    return key != "campus" or value in _known_campuses()


def _known_campuses() -> tuple[str, ...]:
    # Imported here: campuses imports the stage registry, which this module
    # must not pull in at import time.
    from camsocs_pipeline import campuses

    return campuses.known_ids()


def _campus() -> str | None:
    """The process's campus id (`campuses.active()`), or None if unknown."""
    from camsocs_pipeline import campuses

    campus_id = campuses.active().id
    return campus_id if campus_id in campuses.known_ids() else None


def _time_limit() -> int | None:
    """`CAMSOCS_TIME_LIMIT_S` as whole seconds, when the runner sets it."""
    value = os.environ.get(TIME_LIMIT_ENV, "").strip()
    return int(value) if value.isdigit() and 0 < int(value) < 10**7 else None


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
        if key not in allowed or key in FORBIDDEN_AI_KEYS:
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
            event,
            {"environment": self._environment, "campus": _campus(), **self._common, **properties},
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
                "timeLimitS": _time_limit(),
            },
        )

    @_quiet
    def stage_started(self, name: str) -> None:
        """Name the stage that the generations from now on belong to."""
        self._stage = name

    def _run_trace_id(self) -> str:
        return str(self._common.get("runKey") or self._trace_id)

    @_quiet
    def stage_completed(
        self,
        stage: StageReport,
        *,
        duration_s: float,
        error_type: str | None = None,
        pillar: str | None = None,
        phase: str | None = None,
    ) -> None:
        """The stage's `harvest_stage_completed` and its `$ai_span` (a child
        of the run's trace). `pillar` and `phase` come from the registry."""
        self._stage = None
        duration = round(duration_s, 3)
        self._capture(
            STAGE_COMPLETED,
            {
                "stage": stage.name,
                "status": stage.status,
                "pillar": pillar,
                "phase": phase,
                "durationS": duration,
                "inserted": stage.inserted,
                "updated": stage.updated,
                "unchanged": stage.unchanged,
                "skipped": stage.skipped,
                "yield": stage.inserted + stage.updated + stage.unchanged,
                "metrics": dict(stage.metrics) or None,
                "errorType": error_type if stage.status == "failed" else None,
            },
        )
        trace_id = self._run_trace_id()
        self._capture(
            AI_SPAN,
            {
                "$ai_trace_id": trace_id,
                "$ai_span_id": f"{trace_id}.{stage.name}",
                "$ai_parent_id": trace_id,
                "$ai_span_name": stage.name,
                "$ai_latency": duration,
                "$ai_is_error": stage.status == "failed",
                "pillar": pillar,
            },
        )

    @_quiet
    def sources_fetched(
        self,
        stage: str,
        by_host_class: Mapping[str, Mapping[str, int | float]],
        *,
        duration_s: float,
        pillar: str | None = None,
    ) -> None:
        """One `harvest_source_fetched` per host class the stage fetched from
        (`fetch_stats.StageStats.by_host_class`): counts only, the class
        never a host. `duration_s` is the stage's."""
        for host_class, counters in by_host_class.items():
            self._capture(
                SOURCE_FETCHED,
                {
                    "stage": stage,
                    "pillar": pillar,
                    "hostClass": host_class,
                    "durationS": round(duration_s, 3),
                    **{name: value for name, value in counters.items() if name in CLASS_COUNTERS},
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
        status = _run_status(report, error_type)
        elapsed = self._elapsed()
        self._capture(
            RUN_FINISHED,
            {
                "command": report.command,
                "status": status,
                "durationS": elapsed,
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
        self._capture(
            AI_TRACE,
            {
                "$ai_trace_id": report.run_key,
                "$ai_span_name": self._common.get("group") or "sync",
                "$ai_latency": elapsed,
                "$ai_is_error": status != "success",
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
        fallback: bool = False,
    ) -> None:
        """One `$ai_generation`: an `LLMClient` request, retries included.
        `latency_s` is the final attempt's; `error_type` the class name of the
        exception that ended it (never its message); `fallback` marks a strong
        request made because the bulk one failed (ENG-23). Takes no messages,
        reply or error text, so it cannot send them."""
        trace_id = self._run_trace_id()
        self._capture(
            AI_GENERATION,
            {
                "$ai_trace_id": trace_id,
                "$ai_span_id": uuid.uuid4().hex,
                # The stage's span (`stage_completed`), when inside one.
                "$ai_parent_id": f"{trace_id}.{self._stage}" if self._stage else None,
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
                "fallback": fallback,
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
    "AI_SPAN",
    "AI_TRACE",
    "ALLOWED",
    "CLOSE_TIMEOUT",
    "DISTINCT_ID",
    "FLUSH_TIMEOUT",
    "FORBIDDEN_AI_KEYS",
    "RUN_FINISHED",
    "RUN_STARTED",
    "SOURCE_FETCHED",
    "STAGE_COMPLETED",
    "TIME_LIMIT_ENV",
    "HarvestTelemetry",
    "active_telemetry",
    "clean_properties",
]
