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
transform, and that is otherwise invisible. Refusals the server reports
item by item (rejected claims, unknown events, unknown messages) are
collected on the `BatchResult` rather than raised: the rest of the batch
landed, and the stage reports them as notes.

There is one method per route (`post_claims`, `upsert_sources`, …; the route
table is in `models/wire.py`), and `post_observations` posts keyed staged
observations as all of them, in dependency order.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import random
import time
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any, Self

import httpx

from camsocs_pipeline import __version__
from camsocs_pipeline.claims import claims_for_event, claims_for_observation, epoch_ms
from camsocs_pipeline.keys import event_key, person_key, source_key
from camsocs_pipeline.models.observation import EventObservation, Observation
from camsocs_pipeline.models.wire import (
    BrokerProfileInput,
    ClaimInput,
    CrosswalkRequest,
    CrosswalkRow,
    EventOrganiser,
    EventOrganiserSet,
    FileResult,
    FileUpload,
    InboundMark,
    InferredItem,
    OrgInternalPatch,
    PendingMail,
    PersonInput,
    PersonLink,
    PurgeRequest,
    RelationshipEvidence,
    RelationshipInput,
    SourceInput,
    TermDate,
    WireModel,
)

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


class ConvexNotFound(ConvexError):
    """404: the route is not deployed, or the function said "not found"."""


@dataclass
class BatchResult:
    """What a sequence of ingestion requests wrote, accumulated across chunks."""

    unit: str = "records"
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    requests: int = 0
    #: Items the server refused one by one (claims: `{index, entityKey, field,
    #: reason}`; the index is within its own request), or keys it did not find.
    rejected: list[Any] = field(default_factory=list)
    #: `claims` only: entity rows created / updated / unchanged.
    entities: dict[str, int] = field(default_factory=dict)

    def record(self, response: dict[str, Any]) -> None:
        self.inserted += int(response.get("inserted", 0))
        self.updated += int(response.get("updated", 0))
        self.unchanged += int(response.get("unchanged", 0))
        self.requests += 1
        for name in ("rejected", "missingEvents", "missing"):
            self.rejected.extend(response.get(name) or [])
        for name, count in (response.get("entities") or {}).items():
            self.entities[name] = self.entities.get(name, 0) + int(count)

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
            if response.status_code == 404:
                raise ConvexNotFound(f"404 from {url}: {_detail(response)}")
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
        records: Sequence[dict[str, Any] | WireModel],
        *,
        unit: str | None = None,
        batch_size: int = MAX_BATCH,
        extra: dict[str, Any] | None = None,
    ) -> BatchResult:
        """Post `records` in chunks under the argument name `key` the mutation
        expects, with `extra` arguments (e.g. `runKey`) on every request."""
        result = BatchResult(unit or key)
        rows = [record.to_wire() if isinstance(record, WireModel) else record for record in records]
        for batch in chunked(rows, batch_size):
            result.record(self.post(path, {**(extra or {}), key: list(batch)}))
        if result.requests:
            logger.info("%s → %s", path, result)
        return result

    # -- one method per route (models/wire.py) -----------------------------------

    def post_claims(
        self, claims: Sequence[ClaimInput], *, run_key: str | None = None
    ) -> BatchResult:
        """`claims`: append to the claim log and re-resolve the touched entities."""
        extra = {"runKey": run_key} if run_key else None
        return self.post_batches("claims", "claims", claims, extra=extra)

    def upsert_sources(self, sources: Sequence[SourceInput]) -> BatchResult:
        return self.post_batches("sources", "sources", sources)

    def patch_org_internal(self, patches: Sequence[OrgInternalPatch]) -> BatchResult:
        return self.post_batches("orgInternal", "patches", patches, unit="orgInternal")

    def upsert_relationships(self, relationships: Sequence[RelationshipInput]) -> BatchResult:
        return self.post_batches("relationships", "relationships", relationships)

    def set_event_organisers(self, sets: Sequence[EventOrganiserSet]) -> BatchResult:
        """Replaces each event's organiser set; `rejected` lists unknown events."""
        return self.post_batches("eventOrganisers", "events", sets, unit="event organiser sets")

    def post_broker_inferences(
        self,
        profiles: Sequence[BrokerProfileInput] = (),
        people: Sequence[PersonInput] = (),
    ) -> BatchResult:
        result = self.post_batches("brokerInferences", "profiles", profiles, unit="broker rows")
        people_result = self.post_batches("brokerInferences", "people", people)
        for name in ("inserted", "updated", "unchanged", "requests"):
            setattr(result, name, getattr(result, name) + getattr(people_result, name))
        return result

    def upload_file(self, data: bytes, content_type: str) -> FileResult:
        """Stores our own copy of an image or PDF (≤ 2 MB) and returns its
        storage id; identical bytes are stored once."""
        sha256 = hashlib.sha256(data).hexdigest()
        body = FileUpload(data=base64.b64encode(data).decode("ascii"), content_type=content_type)
        if self.dry_run:
            json.dumps(body.to_wire())
            return FileResult(storage_id="dry-run", sha256=sha256)
        return FileResult.model_validate(self.post("files", body.to_wire()))

    def inbound_pending(self, limit: int = 50) -> list[PendingMail]:
        """The oldest forwarded list mails awaiting extraction."""
        if self.dry_run:
            return []
        response = self.post("inbound/pending", {"limit": limit})
        return [PendingMail.model_validate(mail) for mail in response.get("result", [])]

    def crosswalk(self, *, page_size: int = 200, max_pages: int = 100) -> list[CrosswalkRow]:
        """Every organisation key with its names and source identifiers, for
        the resolver (`resolve/crosswalk.py`). Raises `ConvexNotFound` while
        the route is not deployed; empty in a dry run."""
        if self.dry_run:
            return []
        rows: list[CrosswalkRow] = []
        cursor: str | None = None
        for _ in range(max_pages):
            body = CrosswalkRequest(cursor=cursor, limit=page_size).to_wire()
            response = self.post("crosswalk", body)
            rows += [CrosswalkRow.model_validate(row) for row in response.get("rows", [])]
            if response.get("isDone", True):
                return rows
            cursor = response.get("continueCursor")
        raise ConvexError(f"crosswalk did not finish in {max_pages} pages")

    def mark_inbound(self, items: Sequence[InboundMark]) -> BatchResult:
        return self.post_batches("inbound/mark", "items", items, unit="inbound marks")

    def upsert_term_dates(self, terms: Sequence[TermDate]) -> BatchResult:
        return self.post_batches("termDates", "terms", terms, unit="terms")

    def derive(self) -> dict[str, Any]:
        """Re-derive every organisation, event label and stale flag now."""
        return self.post("derive", {})

    def purge_dev(self, *, max_rounds: int = 200) -> dict[str, int]:
        """Empties every pipeline-owned table on the **dev** deployment (the
        server refuses anywhere else), calling until it reports done."""
        totals: dict[str, int] = {}
        for _ in range(max_rounds):
            response = self.post("purge", PurgeRequest().to_wire())
            for table, count in (response.get("deleted") or {}).items():
                totals[table] = totals.get(table, 0) + int(count)
            if self.dry_run or response.get("done"):
                return totals
        raise ConvexError(f"purge did not finish in {max_rounds} rounds")

    # -- staged observations ---------------------------------------------------------

    def post_observations(
        self, records: Iterable[Observation | EventObservation], *, run_key: str | None = None
    ) -> LoadReport:
        """Posts keyed observations as every row they imply, in dependency
        order: sources → claims → orgInternal → relationships → event
        organisers → broker inferences. Unkeyed records are skipped (they wait
        for the resolve stage) and counted."""
        plan = plan_observations(records)
        report = LoadReport(skipped=plan.skipped)
        report.sources = self.upsert_sources(plan.sources)
        report.claims = self.post_claims(plan.claims, run_key=run_key)
        report.org_internal = self.patch_org_internal(plan.org_internal)
        report.relationships = self.upsert_relationships(plan.relationships)
        report.event_organisers = self.set_event_organisers(plan.event_organisers)
        report.broker = self.post_broker_inferences(plan.broker_profiles, plan.people)
        return report

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


@dataclass
class LoadReport:
    """What `post_observations` wrote, per route."""

    skipped: int = 0
    sources: BatchResult = field(default_factory=lambda: BatchResult("sources"))
    claims: BatchResult = field(default_factory=lambda: BatchResult("claims"))
    org_internal: BatchResult = field(default_factory=lambda: BatchResult("orgInternal"))
    relationships: BatchResult = field(default_factory=lambda: BatchResult("relationships"))
    event_organisers: BatchResult = field(default_factory=lambda: BatchResult("event organisers"))
    broker: BatchResult = field(default_factory=lambda: BatchResult("broker rows"))

    def results(self) -> list[BatchResult]:
        return [
            self.sources,
            self.claims,
            self.org_internal,
            self.relationships,
            self.event_organisers,
            self.broker,
        ]


@dataclass
class LoadPlan:
    """The wire rows a set of keyed observations implies (pure; tested offline)."""

    skipped: int = 0
    sources: list[SourceInput] = field(default_factory=list)
    claims: list[ClaimInput] = field(default_factory=list)
    org_internal: list[OrgInternalPatch] = field(default_factory=list)
    relationships: list[RelationshipInput] = field(default_factory=list)
    event_organisers: list[EventOrganiserSet] = field(default_factory=list)
    broker_profiles: list[BrokerProfileInput] = field(default_factory=list)
    people: list[PersonInput] = field(default_factory=list)


def _is_http(url: str) -> bool:
    return url.startswith(("http://", "https://"))


def plan_observations(records: Iterable[Observation | EventObservation]) -> LoadPlan:
    """Turns keyed observations into wire rows. See `ConvexLoader.post_observations`."""
    plan = LoadPlan()
    sources: dict[str, SourceInput] = {}
    for record in records:
        if not record.is_keyed:
            plan.skipped += 1
            continue
        org_key: str | None = None
        if isinstance(record, EventObservation):
            plan.claims.extend(claims_for_event(record))
            plan.event_organisers.append(
                EventOrganiserSet(
                    event_key=event_key(record.event_source, record.external_id),
                    organisers=[
                        EventOrganiser(org_key=o.identity.known_key, role=o.role)
                        for o in record.organisers
                        if o.identity.known_key
                    ],
                )
            )
        else:
            plan.claims.extend(claims_for_observation(record))
            if record.entity_type == "organisation":
                org_key = record.entity_key
                _plan_organisation(plan, record)
        if _is_http(record.source_url):
            sources[record.source_url] = _source_row(
                record, org_key, sources.get(record.source_url)
            )
    plan.sources = list(sources.values())
    return plan


def _source_row(
    record: Observation | EventObservation, org_key: str | None, previous: SourceInput | None
) -> SourceInput:
    fetched = epoch_ms(record.retrieved_at)
    fetch = record.fetch
    robots_at = epoch_ms(fetch.robots_checked_at) if fetch and fetch.robots_checked_at else fetched
    yielded = sorted(
        {*(previous.yielded or [] if previous else []), *(f.field for f in record.fields)}
    )
    return SourceInput(
        key=source_key(record.source_url),
        url=record.source_url,
        source_type=record.source_type,
        org_key=org_key or (previous.org_key if previous else None),
        http_status=fetch.http_status if fetch else None,
        access_note=fetch.access_note if fetch else None,
        content_sha256=record.content_sha256,
        last_fetched_at=max(fetched, previous.last_fetched_at if previous else 0),
        yielded=yielded,
        robots_verdict=fetch.robots_verdict if fetch else "allowed",
        robots_checked_at=robots_at,
    )


def _plan_organisation(plan: LoadPlan, record: Observation) -> None:
    key = record.entity_key
    assert key is not None  # is_keyed
    seen_at = epoch_ms(record.retrieved_at)
    if record.internal:
        plan.org_internal.append(
            OrgInternalPatch.model_validate({**record.internal, "org_key": key})
        )
    for rel in record.relationships:
        other = rel.to_identity.known_key
        assert other is not None  # is_keyed
        from_key, to_key = (key, other) if rel.direction == "outgoing" else (other, key)
        plan.relationships.append(
            RelationshipInput(
                from_key=from_key,
                to_key=to_key,
                type=rel.type,
                evidence=RelationshipEvidence(
                    source_url=rel.evidence_url, note=rel.note, seen_at=seen_at
                ),
                method=rel.method,
                evidence_kind=rel.evidence,
                quote_check=rel.quote_check,
                visibility=rel.visibility,
            )
        )
    broker = record.broker
    if not broker or not _is_http(record.source_url):
        return

    def items(kind: str) -> list[InferredItem] | None:
        if kind not in broker:
            return None
        return [
            InferredItem(
                item=entry["item"],
                evidence_quote=entry.get("evidence_quote"),
                source_url=record.source_url,
                method=entry.get("method", "llm"),
            )
            for entry in broker[kind]
        ]

    needs, offers = items("needs"), items("offers")
    if needs is not None or offers is not None:
        plan.broker_profiles.append(BrokerProfileInput(org_key=key, needs=needs, offers=offers))
    for person in broker.get("people", []):
        plan.people.append(
            PersonInput(
                key=person_key(key, person["name"]),
                org_key=key,
                name=person["name"],
                role=person["role"],
                start_date=person.get("start_date"),
                source_url=record.source_url,
                seen_at=seen_at,
                public_links=[PersonLink(**link) for link in person.get("public_links", [])]
                or None,
                method=person.get("method", "parser"),
            )
        )


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
