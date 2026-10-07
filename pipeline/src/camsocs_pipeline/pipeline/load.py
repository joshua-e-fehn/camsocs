"""Writing to Convex over its HTTP ingestion API (Bundestracker pipeline/load.py).

Convex has no Python client, so the pipeline POSTs to
`<CONVEX_HTTP_URL>/api/pipeline/<path>`, routed by webapp/convex/http.ts to
`internal*` mutations that upsert on a natural key. Authentication is a shared
secret in an `Authorization: Bearer` header.

Properties that live here rather than in each caller:

1. **The URL is the `.convex.site` host.** `config.require_convex_http_url`
   converts from `.convex.cloud` if needed.
2. **Batches are chunked to `MAX_BATCH`** (500), mirroring
   webapp/convex/lib/ingest.ts, which *rejects* larger batches rather than
   truncating. The two constants must not drift.
3. **Retries are for the transport, not the payload.** 429/5xx and transport
   errors are retried with backoff; a 400 is not, because the mutations throw
   only on deterministic precondition failures and the message says what.
4. **`health()` first**, so a rotated key is one clean 401 before any work.
5. **A dry run writes nothing and touches no network**, but still serialises
   every payload, so a non-JSON value fails in a mode that cannot hurt.

Every batch reports `inserted` / `updated` / `unchanged`: a nightly sync that
"updates" everything when nothing changed upstream has a non-deterministic
transform, and that is otherwise invisible.
"""

from __future__ import annotations

import json
import logging
import random
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self

import httpx

from camsocs_pipeline import __version__

logger = logging.getLogger(__name__)

#: Rows per request. Mirrors `MAX_BATCH` in webapp/convex/lib/ingest.ts.
MAX_BATCH = 500

DEFAULT_TIMEOUT = 120.0
DEFAULT_MAX_RETRIES = 4
INITIAL_BACKOFF = 2.0
MAX_BACKOFF = 60.0
RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})

USER_AGENT = f"camsocs-pipeline/{__version__} (convex ingestion)"


class ConvexError(RuntimeError):
    """The ingestion API refused a request."""


class ConvexAuthError(ConvexError):
    """The shared key was missing, wrong, or unset on the deployment."""


@dataclass
class BatchResult:
    """What a sequence of ingestion requests wrote, accumulated across chunks."""

    unit: str = "records"
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    requests: int = 0

    def record(self, response: dict[str, Any]) -> None:
        self.inserted += int(response.get("inserted", 0))
        self.updated += int(response.get("updated", 0))
        self.unchanged += int(response.get("unchanged", 0))
        self.requests += 1

    def __str__(self) -> str:
        return (
            f"{self.inserted + self.updated} {self.unit} written "
            f"({self.inserted} new, {self.updated} updated, {self.unchanged} unchanged, "
            f"{self.requests} requests)"
        )


def chunked(items: Sequence[Any], size: int = MAX_BATCH) -> Iterator[Sequence[Any]]:
    """Batches the API will accept. Yields nothing for an empty input, so "no
    work" never becomes an empty POST that looks like a failed write."""
    if size < 1:
        raise ValueError("batch size must be positive")
    for start in range(0, len(items), size):
        yield items[start : start + size]


class ConvexLoader:
    """Posts to the Convex ingestion API. One instance per run."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        dry_run: bool = False,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.dry_run = dry_run
        self.max_retries = max_retries
        self._api_key = api_key
        self._owns_client = client is None
        self._client = client or httpx.Client(timeout=timeout, headers={"User-Agent": USER_AGENT})

    def __repr__(self) -> str:
        # Never the key.
        return f"ConvexLoader({self.base_url!r}, dry_run={self.dry_run})"

    def _headers(self) -> dict[str, str]:
        """Auth per request rather than on the client: an injected client belongs
        to the caller, and setting the key on it could silently send none."""
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    # -- lifecycle -------------------------------------------------------------

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    # -- transport -------------------------------------------------------------

    def health(self) -> bool:
        """Whether this key still opens the door (`GET /api/pipeline/health`)."""
        if self.dry_run:
            return True
        return bool(self._request("GET", "health").get("ok"))

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """One ingestion request. In a dry run the payload is serialised and discarded."""
        if self.dry_run:
            json.dumps(payload)
            return {"inserted": 0, "updated": 0, "unchanged": 0, "dryRun": True}
        return self._request("POST", path, payload)

    def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        url = f"{self.base_url}/api/pipeline/{path.lstrip('/')}"
        backoff = INITIAL_BACKOFF
        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = self._client.request(method, url, json=payload, headers=self._headers())
            except httpx.HTTPError as error:
                last_error = error
                logger.warning(
                    "%s %s failed (attempt %d/%d): %s",
                    method,
                    url,
                    attempt + 1,
                    self.max_retries + 1,
                    type(error).__name__,
                )
                if attempt < self.max_retries:
                    time.sleep(_jittered(backoff))
                    backoff = min(backoff * 2, MAX_BACKOFF)
                continue

            if response.status_code == 401:
                raise ConvexAuthError(
                    f"401 from {url}. PIPELINE_API_KEY must be set here *and* on the "
                    'deployment (`bunx convex env set PIPELINE_API_KEY "…"`).'
                )
            if response.status_code in RETRYABLE_STATUSES:
                last_error = ConvexError(f"{response.status_code} from {url}: {_detail(response)}")
                logger.warning(
                    "%s from %s (attempt %d/%d)",
                    response.status_code,
                    url,
                    attempt + 1,
                    self.max_retries + 1,
                )
                if attempt < self.max_retries:
                    time.sleep(_jittered(backoff))
                    backoff = min(backoff * 2, MAX_BACKOFF)
                continue
            if response.status_code >= 400:
                # Not retried: deterministic, and the message names the problem.
                raise ConvexError(f"{response.status_code} from {url}: {_detail(response)}")

            try:
                body = response.json()
            except ValueError as error:
                raise ConvexError(f"Expected JSON from {url}, got {response.text[:120]!r}") from (
                    error
                )
            return body if isinstance(body, dict) else {"result": body}

        raise ConvexError(f"{method} {url} failed after {self.max_retries + 1} attempts") from (
            last_error
        )

    # -- batched writes ----------------------------------------------------------

    def post_batches(
        self,
        path: str,
        key: str,
        records: Sequence[dict[str, Any]],
        *,
        unit: str | None = None,
        batch_size: int = MAX_BATCH,
    ) -> BatchResult:
        """Post `records` in chunks under the argument name `key` the mutation expects."""
        result = BatchResult(unit or key)
        for batch in chunked(records, batch_size):
            result.record(self.post(path, {key: list(batch)}))
        if result.requests:
            logger.info("%s → %s", path, result)
        return result

    # -- the run log -------------------------------------------------------------

    def start_run(
        self, run_key: str, *, command: str, stages: Sequence[str], pipeline_version: str
    ) -> dict[str, Any]:
        """`runs.start`: opens the run's row before any data is written."""
        return self.post(
            "runs/start",
            {
                "runKey": run_key,
                "command": command,
                "requestedStages": list(stages),
                "pipelineVersion": pipeline_version,
            },
        )

    def finish_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        """`runs.finish`: per-stage results; the server derives the status.
        Idempotent server-side, so a retried finish is safe."""
        return self.post("runs/finish", payload)


def _jittered(seconds: float) -> float:
    return seconds * random.uniform(0.8, 1.2)


def _detail(response: httpx.Response) -> str:
    """The deployment's own `{"error": …}` message, when it sent one."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict) and "error" in body:
        return str(body["error"])
    return str(body)[:300]
