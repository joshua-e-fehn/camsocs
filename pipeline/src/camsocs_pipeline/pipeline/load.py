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
observations as all of them, in dependency order. Before anything is posted
the plan is filtered by the suppression list (`camsocs_pipeline.suppressions`:
listings, fields, addresses and people removed on request), read once per
loader. Image fields staged as a bare ``{"sourceUrl"}``
(`camsocs_pipeline.media`) are uploaded first and posted with their
``storageId`` (`attach_stored_files`); with a `StoredFileCache` an image this
deployment already stores is not uploaded again.

`post_observations` is also where public free text is made safe to publish
(`extract.redact.redact_claims`, decision D1): personal names of private
individuals are replaced by their roles, the original text travels as the
claim's internal `valueRaw`, and a text that cannot be made safe is posted as
``not_published`` — or, for an event's or session's title, the entity is not
posted at all. No claim reaches Convex without that step: without a redactor
the deterministic rule is used.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import random
import time
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any, Self

import httpx

from camsocs_pipeline import __version__
from camsocs_pipeline.claims import claims_for_event, claims_for_observation, epoch_ms
from camsocs_pipeline.events.duplicates import (
    Duplicates,
    as_duplicate,
    find_duplicates,
    primaries_first,
)
from camsocs_pipeline.events.duplicates import identity as event_identity
from camsocs_pipeline.extract.redact import RedactionStats, Redactor, private_names, redact_claims
from camsocs_pipeline.keys import canonical_json, event_key, person_key, source_key
from camsocs_pipeline.models.observation import EventObservation, FetchInfo, Observation
from camsocs_pipeline.models.wire import (
    BrokerProfileInput,
    ClaimInput,
    CoverageCounts,
    CoveragePage,
    CoverageRequest,
    CrosswalkRequest,
    CrosswalkRow,
    EventOrganiser,
    EventOrganiserSet,
    EventsCoveragePage,
    EventsCoverageRequest,
    FileResult,
    FileUpload,
    InboundFile,
    InboundFileRequest,
    InboundMark,
    InferredItem,
    OrgInternalPatch,
    PendingMail,
    PersonInput,
    PersonLink,
    PlaywazeIds,
    PurgeRequest,
    RelationshipEvidence,
    RelationshipInput,
    SourceInput,
    SuppressionList,
    TermDate,
    WireModel,
    WorklistOrg,
    WorklistPage,
)
from camsocs_pipeline.sources.policy import GENERAL, SOCIETY, SOCIETY_WEBSITE, FetchPurpose
from camsocs_pipeline.suppressions import SuppressionReport, Suppressions, apply_suppressions

logger = logging.getLogger(__name__)

#: Rows per request. Mirrors `MAX_BATCH` in webapp/convex/lib/ingest.ts.
MAX_BATCH = 500

DEFAULT_TIMEOUT = 120.0
DEFAULT_MAX_RETRIES = 4
INITIAL_BACKOFF = 2.0
MAX_BACKOFF = 60.0
RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})

USER_AGENT = f"camsocs-pipeline/{__version__} (convex ingestion)"

#: Claim fields whose value references a stored file (`{storageId?, sourceUrl?}`).
STORED_FILE_FIELDS = frozenset({("event", "image"), ("organisation", "logo")})
#: Stored files an organisation publishes about itself: fetched with the
#: society purpose (`sources/policy.py`, D3: an SU `/asset/` logo, or a student
#: group's event poster on its SU event page). The purpose lifts robots.txt
#: only for the URL classes D3 lists; any other image keeps its robots.txt.
SOCIETY_FILE_FIELDS = frozenset({("organisation", "logo"), ("event", "image")})

#: Bytes and content type of an image URL fetched for a purpose, or None
#: (`media.CachedImages`).
MediaSource = Callable[[str, FetchPurpose], tuple[bytes, str] | None]


#: The claims route's refusal of an image claim whose `storageId` the
#: deployment no longer stores (purged, or deleted by retention).
STALE_FILE_REASON = "storageId does not name a stored file"


class ConvexError(RuntimeError):
    """The ingestion API refused a request."""


class ConvexAuthError(ConvexError):
    """The shared key was missing, wrong, or unset on the deployment."""


class ConvexNotFound(ConvexError):
    """404: the route is not deployed, or the thing it was asked about does not exist."""


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


_TOO_HEAVY = ("too many", "timed out")


def _is_too_heavy(error: ConvexError) -> bool:
    """Whether Convex refused a request for exceeding a function's limits
    (database calls, reads, time) rather than for its content."""
    message = str(error).lower()
    return any(marker in message for marker in _TOO_HEAVY)


def entity_batches(claims: Sequence[ClaimInput], size: int = MAX_BATCH) -> list[list[ClaimInput]]:
    """Claims in batches that never split one entity's claims, in first-seen
    entity order.

    The claims route creates an entity only from claims in the same request
    that carry its required fields (an organisation's `name`; an event's title,
    start, visibility, source, …). Observations of one organisation are often
    staged apart — a name-less register row, then the page that names it — so
    a plain chunk boundary could send the name-less part first, alone, and
    have it refused. Keeping each entity's claims together avoids that. An
    entity with more than `size` claims is split, its earliest-staged claims
    (which carry the creating fields) first."""
    if size < 1:
        raise ValueError("batch size must be positive")
    groups: dict[tuple[str, str], list[ClaimInput]] = {}
    for claim in claims:
        groups.setdefault((claim.entity_type, claim.entity_key), []).append(claim)
    batches: list[list[ClaimInput]] = []
    current: list[ClaimInput] = []
    for group in groups.values():
        if current and len(current) + len(group) > size:
            batches.append(current)
            current = []
        for start in range(0, len(group), size):
            piece = group[start : start + size]
            if len(current) + len(piece) > size:
                batches.append(current)
                current = []
            current.extend(piece)
    if current:
        batches.append(current)
    return batches


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
        #: sha256 → storageId of files this deployment stores (the load stage
        #: sets it; `attach_stored_files` reuses ids instead of uploading).
        self.file_cache: StoredFileCache | None = None
        self._suppressions: Suppressions | None = None
        #: Why the suppression list could not be read, when it could not.
        self.suppressions_note: str | None = None

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
                kind = ConvexNotFound if response.status_code == 404 else ConvexError
                raise kind(f"{response.status_code} from {url}: {_detail(response)}")

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
        result = BatchResult("claims")
        for batch in entity_batches(claims):
            self._post_claim_batch(batch, extra, result)
        if result.requests:
            logger.info("claims → %s", result)
        return result

    def _post_claim_batch(
        self, batch: list[ClaimInput], extra: dict[str, Any] | None, result: BatchResult
    ) -> None:
        """One claims request. A batch the server cannot finish inside one
        mutation's limits (many new entities, each resolved in full) fails as
        a whole — a mutation is atomic, so nothing was written — and is posted
        again in halves, still never splitting an entity's claims."""
        try:
            result.record(
                self.post("claims", {**(extra or {}), "claims": [c.to_wire() for c in batch]})
            )
        except ConvexError as error:
            if len(batch) < 2 or not _is_too_heavy(error):
                raise
            logger.warning("claims batch of %d too heavy for one mutation; halving", len(batch))
            for half in entity_batches(batch, size=(len(batch) + 1) // 2):
                self._post_claim_batch(half, extra, result)

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
        storage id; identical bytes are stored once (the server de-duplicates
        by content; `attach_stored_files` skips bytes the `StoredFileCache`
        knows this deployment stores)."""
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

    def inbound_file(self, message_id: str, storage_id: str) -> bytes | None:
        """One stored attachment of a forwarded mail, or None if the server
        has no such file for that mail (404)."""
        if self.dry_run:
            return None
        body = InboundFileRequest(message_id=message_id, storage_id=storage_id).to_wire()
        try:
            response = self.post("inbound/file", body)
        except ConvexNotFound:
            return None
        return base64.b64decode(InboundFile.model_validate(response).data)

    def mark_inbound(self, items: Sequence[InboundMark]) -> BatchResult:
        return self.post_batches("inbound/mark", "items", items, unit="inbound marks")

    def worklist(self, *, page_size: int = 100, max_pages: int = 100) -> list[WorklistOrg]:
        """Every non-counterpart organisation with what the mailing-list
        worklist ranks on, following the server's pagination cursor.

        The first request sends ``"cursor": null`` on purpose: that is how
        Convex's `paginationOpts` says "from the start" — a pagination token,
        not an unobserved field, so the never-send-null rule does not apply.
        """
        if self.dry_run:
            return []
        organisations: list[WorklistOrg] = []
        cursor: str | None = None
        for _ in range(max_pages):
            response = self.post(
                "worklist", {"paginationOpts": {"numItems": page_size, "cursor": cursor}}
            )
            page = WorklistPage.model_validate(response)
            organisations.extend(page.page)
            if page.is_done:
                return organisations
            cursor = page.continue_cursor
        raise ConvexError(f"worklist did not finish in {max_pages} pages")

    def suppressions(self) -> Suppressions:
        """The suppression list, read once per loader. Empty in a dry run, and
        when the route is not deployed yet (then no suppression exists there
        either); `suppressions_note` says which. A truncated list raises:
        loading against part of it could re-publish what was removed."""
        if self._suppressions is not None:
            return self._suppressions
        if self.dry_run:
            self.suppressions_note = "dry run: suppression list not read"
            self._suppressions = Suppressions()
            return self._suppressions
        try:
            body = SuppressionList.model_validate(self.post("suppressions", {}))
        except ConvexNotFound:
            self.suppressions_note = "suppressions route not deployed; nothing filtered"
            self._suppressions = Suppressions()
            return self._suppressions
        if body.truncated:
            raise ConvexError(
                "The suppression list is truncated; refusing to load against part of it"
            )
        self._suppressions = Suppressions.from_wire(body)
        return self._suppressions

    def coverage(self, *, page_size: int = 100, max_pages: int = 200) -> tuple[CoverageCounts, int]:
        """Directory coverage summed over the server's pages (`coverage`):
        the counts and how many organisation rows they cover."""
        total = CoverageCounts()
        rows = 0
        cursor: str | None = None
        for _ in range(max_pages):
            body = CoverageRequest(cursor=cursor, limit=page_size).to_wire()
            page = CoveragePage.model_validate(self.post("coverage", body))
            total = merge_coverage(total, page.counts)
            rows += page.rows
            if page.is_done:
                return total, rows
            cursor = page.continue_cursor
        raise ConvexError(f"coverage did not finish in {max_pages} pages")

    def event_coverage(
        self, from_ms: int, *, page_size: int = 500, max_pages: int = 200
    ) -> EventsCoveragePage:
        """Events starting at or after `from_ms`, counted by source and
        visibility over the server's pages (`coverage/events`)."""
        total = EventsCoveragePage(rows=0, is_done=True, continue_cursor="")
        cursor: str | None = None
        for _ in range(max_pages):
            body = EventsCoverageRequest(from_=from_ms, cursor=cursor, limit=page_size).to_wire()
            page = EventsCoveragePage.model_validate(self.post("coverage/events", body))
            for name in ("by_source", "by_visibility"):
                counts = getattr(total, name)
                for key, count in getattr(page, name).items():
                    counts[key] = counts.get(key, 0) + count
            total.cancelled += page.cancelled
            total.rows += page.rows
            if page.is_done:
                return total
            cursor = page.continue_cursor
        raise ConvexError(f"coverage/events did not finish in {max_pages} pages")

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
        self,
        records: Iterable[Observation | EventObservation],
        *,
        run_key: str | None = None,
        media: MediaSource | None = None,
        redactor: Redactor | None = None,
    ) -> LoadReport:
        """Posts keyed observations as every row they imply, in dependency
        order: sources → (files) → claims → orgInternal → relationships →
        event organisers → broker inferences — after taking out whatever the
        suppression list forbids. Unkeyed records are skipped (they wait for
        the resolve stage) and counted. With `media`, image values that name
        only a ``sourceUrl`` are uploaded first. Public free text is redacted
        (D1, `extract.redact`) with `redactor`, or with the deterministic rule
        alone when none is given, after the suppression list has cut out what
        it forbids (so a suppressed address never reaches `valueRaw`)."""
        records = list(records)
        plan = plan_observations(records)
        report = LoadReport(
            skipped=plan.skipped, collisions=plan.collisions, merged=plan.duplicates.notes()
        )
        report.suppressed = apply_suppressions(plan, self.suppressions())
        plan.claims, report.redaction = redact_claims(
            plan.claims,
            redactor or Redactor(),
            private=private_names(records, plan.duplicates.primary_of),
        )
        if report.redaction.dropped:
            # A title that cannot be made safe: the event is not posted at all.
            unsafe = set(report.redaction.dropped)
            plan.event_organisers = [s for s in plan.event_organisers if s.event_key not in unsafe]
        report.sources = self.upsert_sources(plan.sources)
        reused_before = self.file_cache.reused if self.file_cache else 0
        if media is not None and not self.dry_run:
            plan.claims, report.files_stored, report.files_dropped = attach_stored_files(
                plan.claims, self, media
            )
        report.claims = self.post_claims(plan.claims, run_key=run_key)
        if self.file_cache is not None:
            report.files_reused = self.file_cache.reused - reused_before
            if any(
                isinstance(item, dict) and item.get("reason") == STALE_FILE_REASON
                for item in report.claims.rejected
            ):
                # Some cached id is gone from the deployment: forget every id
                # reused this run, so the next run uploads them again.
                report.files_stale = self.file_cache.forget_reused()
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
    #: Fields not posted because one source gave one entity two readings.
    collisions: list[str] = field(default_factory=list)
    #: Event readings folded into another source's event (`events.duplicates`).
    merged: list[str] = field(default_factory=list)
    #: What the suppression list held back.
    suppressed: SuppressionReport = field(default_factory=SuppressionReport)
    #: Image claims given a stored copy, and those dropped for want of one.
    files_stored: int = 0
    files_dropped: int = 0
    #: Of the stored copies: ids reused from the `StoredFileCache` (no upload).
    files_reused: int = 0
    #: Cached ids forgotten because the deployment no longer had one of them.
    files_stale: int = 0
    #: What the D1 redaction of public free text did.
    redaction: RedactionStats = field(default_factory=RedactionStats)
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
    #: Fields left out because one source gave one entity two readings.
    collisions: list[str] = field(default_factory=list)
    #: Event readings folded into another source's event (`events.duplicates`).
    duplicates: Duplicates = field(default_factory=Duplicates)


class StoredFileCache:
    """sha256 → ``storageId`` of the files one deployment already stores
    (``var/state/stored-files.json``, keyed by deployment URL), so the load
    stage uploads an image only when its bytes are new to that deployment.

    Ids are trusted until the deployment says otherwise: a claim refused with
    `STALE_FILE_REASON` makes the loader forget the ids it reused that run
    (`forget_reused`), and `camsocs purge-dev` forgets the dev deployment's.
    """

    def __init__(self, path: Path, deployment: str, entries: dict[str, str] | None = None):
        self.path = path
        self.deployment = deployment.rstrip("/")
        self.entries: dict[str, str] = dict(entries or {})
        self.reused = 0
        self._reused_ids: set[str] = set()
        self._others: dict[str, dict[str, str]] = {}

    @classmethod
    def load(cls, path: Path, deployment: str) -> StoredFileCache:
        """The cache for `deployment`; empty when the file is missing or unreadable."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        key = deployment.rstrip("/")
        cache = cls(path, key, data.get(key) if isinstance(data.get(key), dict) else None)
        cache._others = {k: v for k, v in data.items() if k != key and isinstance(v, dict)}
        return cache

    def get(self, sha256: str) -> str | None:
        storage_id = self.entries.get(sha256)
        if storage_id is not None:
            self.reused += 1
            self._reused_ids.add(storage_id)
        return storage_id

    def put(self, sha256: str, storage_id: str) -> None:
        self.entries[sha256] = storage_id

    def forget_reused(self) -> int:
        """Forgets every id `get` handed out; returns how many entries went."""
        stale = {sha for sha, sid in self.entries.items() if sid in self._reused_ids}
        for sha in stale:
            del self.entries[sha]
        self._reused_ids.clear()
        return len(stale)

    def clear(self) -> None:
        self.entries.clear()

    def save(self) -> None:
        """Writes atomically, keeping other deployments' entries."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {**self._others, self.deployment: dict(sorted(self.entries.items()))}
        temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
        temporary.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(self.path)


def stored_files_path(staging_dir: Path) -> Path:
    """``var/state/stored-files.json`` (next to the crosswalk cache; gitignored)."""
    return staging_dir.parent / "state" / "stored-files.json"


def attach_stored_files(
    claims: Sequence[ClaimInput], loader: ConvexLoader, media: MediaSource
) -> tuple[list[ClaimInput], int, int]:
    """Gives every image claim that names only a ``sourceUrl`` our own copy:
    reads the bytes through `media`, uploads them (`POST files`, de-duplicated
    by content) and adds the ``storageId`` — or, when `loader.file_cache`
    already knows those bytes' id on this deployment, adds that id without
    uploading. A claim whose bytes cannot be had is dropped rather than posted
    as a bare URL — it would otherwise replace an earlier stored copy from the
    same source. Returns (claims, stored, dropped); one URL is read once per
    call."""
    stored: dict[tuple[str, FetchPurpose], str | None] = {}
    kept: list[ClaimInput] = []
    uploaded = dropped = 0
    for claim in claims:
        value = claim.value
        if (
            (claim.entity_type, claim.field) not in STORED_FILE_FIELDS
            or not isinstance(value, dict)
            or value.get("storageId")
            or not isinstance(value.get("sourceUrl"), str)
        ):
            kept.append(claim)
            continue
        url = value["sourceUrl"]
        purpose = file_purpose(claim)
        if (url, purpose) not in stored:
            found = media(url, purpose)
            stored[url, purpose] = _stored_id(loader, found) if found is not None else None
        storage_id = stored[url, purpose]
        if storage_id is None:
            dropped += 1
            continue
        kept.append(claim.model_copy(update={"value": {**value, "storageId": storage_id}}))
        uploaded += 1
    return kept, uploaded, dropped


def file_purpose(claim: ClaimInput) -> FetchPurpose:
    """The fetch purpose for an image claim's file: the society purpose for
    what an organisation publishes about itself (`SOCIETY_FILE_FIELDS`), and
    the society's website class — bound to the page the image was read on, so
    only a file on that site — when it came from the society's own website.
    The same purpose the stage's probe used (`media.probe_image`), so an image
    staged under a D3 override is not refused at load."""
    if (claim.entity_type, claim.field) not in SOCIETY_FILE_FIELDS:
        return GENERAL
    if claim.source_type == "society_website" and _is_http(claim.source_url):
        return SOCIETY_WEBSITE.bound_to(claim.source_url)
    return SOCIETY


def _stored_id(loader: ConvexLoader, found: tuple[bytes, str]) -> str:
    data, content_type = found
    cache = loader.file_cache
    sha256 = hashlib.sha256(data).hexdigest()
    if cache is not None:
        known = cache.get(sha256)
        if known is not None:
            return known
    result = loader.upload_file(data, content_type)
    if cache is not None and not loader.dry_run:
        cache.put(sha256, result.storage_id)
    return result.storage_id


def _is_http(url: str) -> bool:
    return url.startswith(("http://", "https://"))


def merge_coverage(a: CoverageCounts, b: CoverageCounts) -> CoverageCounts:
    """`a` + `b` (webapp/lib/broker/coverage.ts `mergeCoverage`)."""

    def add(x: dict[str, int], y: dict[str, int]) -> dict[str, int]:
        out = dict(x)
        for key, count in y.items():
            out[key] = out.get(key, 0) + count
        return out

    by_level_status = {level: dict(statuses) for level, statuses in a.by_level_status.items()}
    for level, statuses in b.by_level_status.items():
        by_level_status[level] = add(by_level_status.get(level, {}), statuses)
    return CoverageCounts(
        total=a.total + b.total,
        hidden=a.hidden + b.hidden,
        counterparts=a.counterparts + b.counterparts,
        by_level=add(a.by_level, b.by_level),
        by_status=add(a.by_status, b.by_status),
        by_level_status=by_level_status,
        by_org_type=add(a.by_org_type, b.by_org_type),
        headline=add(a.headline, b.headline),
        held=add(a.held, b.held),
        missing=add(a.missing, b.missing),
    )


def plan_observations(records: Iterable[Observation | EventObservation]) -> LoadPlan:
    """Turns keyed observations into wire rows. See `ConvexLoader.post_observations`.

    Event readings another source already lists (`events.duplicates`: the
    same organiser, London date and visibility, a similar title, starts at
    most 30 minutes apart) become claims on that source's event, with their
    own provenance, instead of events of their own; they are planned after
    every other record, so the event and its organiser set exist first."""
    plan = LoadPlan()
    items = list(records)
    duplicates = find_duplicates(record for record in items if record.is_keyed)
    plan.duplicates = duplicates
    sources: dict[str, SourceInput] = {}
    #: The organisations each fetched page was observed for. A page observed
    #: for several (a directory, a register, an A–Z) belongs to none of them.
    owners: dict[str, set[str]] = {}
    #: The organisations each event's organiser sets so far name.
    planned_organisers: dict[str, set[str]] = {}
    for record in primaries_first(items, duplicates):
        assert isinstance(record, Observation | EventObservation)
        if not record.is_keyed:
            plan.skipped += 1
            continue
        org_key: str | None = None
        if isinstance(record, EventObservation):
            primary = duplicates.primary_of.get(event_identity(record))
            reading = as_duplicate(record, duplicates) if primary else record
            plan.claims.extend(claims_for_event(reading, duplicate_of=primary))
            unresolved = bool(record.unresolved_organisers) or any(
                not o.identity.known_key for o in record.organisers
            )
            target = event_key(*(primary or event_identity(record)))
            known = planned_organisers.setdefault(target, set())
            organisers = [
                EventOrganiser(org_key=o.identity.known_key, role=o.role)
                for o in record.organisers
                if o.identity.known_key
                # A second source's reading adds only organisations the
                # event's own reading does not name: Camdram's co-host stays a
                # co-host when the co-host's site calls the show its own (a
                # role added beside it would be removed and re-added by every
                # load's replace-then-merge).
                and not (primary and o.identity.known_key in known)
            ]
            known.update(o.org_key for o in organisers)
            if organisers or not primary:
                plan.event_organisers.append(
                    EventOrganiserSet(
                        event_key=target,
                        organisers=organisers,
                        # Organisers the source names but this run could not
                        # resolve (a fresh machine, a --limit run, an
                        # ambiguous name), or a second source's reading of an
                        # event: add what is known, remove nothing.
                        mode="merge" if unresolved or primary else "replace",
                    )
                )
        else:
            plan.claims.extend(claims_for_observation(record))
            if record.entity_type == "organisation":
                _plan_organisation(plan, record)
                # A counterpart named on a page (a sponsor on a society's
                # site) does not own that page.
                if not _claims_counterpart(record):
                    org_key = record.entity_key
        if _is_http(record.source_url):
            sources[record.source_url] = _source_row(
                record, org_key, sources.get(record.source_url)
            )
            if org_key:
                owners.setdefault(record.source_url, set()).add(org_key)
    for url, keys in owners.items():
        if len(keys) > 1:
            sources[url] = sources[url].model_copy(update={"org_key": None})
    plan.claims, plan.collisions = _without_collisions(plan.claims)
    plan.sources = list(sources.values())
    plan.broker_profiles = _merge_profiles(plan.broker_profiles)
    plan.org_internal = merge_org_internal(plan.org_internal)
    return plan


#: `OrgInternalPatch` list fields; the server merges them too.
_INTERNAL_LISTS = (
    "talks_list_ids",
    "ics_urls",
    "luma_calendar_ids",
    "google_calendar_ids",
    "ticketing_urls",
)


def _union(*lists: list[str] | None) -> list[str]:
    return list(dict.fromkeys(item for items in lists for item in items or []))


def merge_org_internal(patches: Sequence[OrgInternalPatch]) -> list[OrgInternalPatch]:
    """One patch per organisation, folded in staging order the way the server
    applies a sequence of patches: lists merge, a later scalar replaces an
    earlier one. Posting the fold instead of the sequence is what makes a
    second identical load write nothing — two sources giving one organisation
    different scalars (a website domain, an Instagram handle) used to flip
    the row back and forth on every load."""
    merged: dict[str, OrgInternalPatch] = {}
    for patch in patches:
        current = merged.get(patch.org_key)
        if current is None:
            merged[patch.org_key] = patch.model_copy(deep=True)
            continue
        update: dict[str, Any] = {}
        for name in type(patch).model_fields:
            value = getattr(patch, name)
            if value is None or name == "org_key":
                continue
            if name in _INTERNAL_LISTS:
                update[name] = _union(getattr(current, name), value)
            elif name == "playwaze":
                before = current.playwaze
                update[name] = PlaywazeIds(
                    community_id=value.community_id or (before.community_id if before else None),
                    league_ids=_union(before.league_ids if before else None, value.league_ids),
                    team_ids=_union(before.team_ids if before else None, value.team_ids),
                )
            else:
                update[name] = value
        merged[patch.org_key] = current.model_copy(update=update)
    return list(merged.values())


def _without_collisions(claims: list[ClaimInput]) -> tuple[list[ClaimInput], list[str]]:
    """Drops claims that would overwrite each other: two different readings of
    one field of one entity from the same source and method (two rows of one
    PDF resolved to one organisation). The server keeps only the newest per
    (source, method), so either would win by arrival order — neither is
    posted, and the collision is reported."""
    readings: dict[tuple[str, str, str, str, str], set[str]] = defaultdict(set)
    for claim in claims:
        group = (claim.entity_type, claim.entity_key, claim.field, claim.source_key, claim.method)
        readings[group].add(
            canonical_json(claim.value)
            if claim.value is not None
            else f"!{claim.status}:{claim.missing_reason}"
        )
    clashing = {group for group, values in readings.items() if len(values) > 1}
    if not clashing:
        return claims, []
    kept = [
        claim
        for claim in claims
        if (claim.entity_type, claim.entity_key, claim.field, claim.source_key, claim.method)
        not in clashing
    ]
    notes = sorted(
        f"{entity_key} {field_name}: {len(readings[group])} readings from one source"
        for group in clashing
        for _type, entity_key, field_name, _source, _method in [group]
    )
    return kept, notes


def _claims_counterpart(record: Observation) -> bool:
    return any(f.field == "isCounterpart" and f.value is True for f in record.fields)


def _merge_profiles(profiles: list[BrokerProfileInput]) -> list[BrokerProfileInput]:
    """One profile per organisation. The server replaces an organisation's
    inferred needs (offers) with each posted list, so the pages of one site —
    each its own observation — must arrive as one list, not overwrite each
    other. Items keep their own page's source URL; the first sighting of an
    item wins."""
    merged: dict[str, BrokerProfileInput] = {}
    for profile in profiles:
        current = merged.get(profile.org_key)
        if current is None:
            merged[profile.org_key] = profile.model_copy(deep=True)
            continue
        for kind in ("needs", "offers"):
            incoming = getattr(profile, kind)
            if incoming is None:
                continue
            existing = getattr(current, kind) or []
            known = {item.item for item in existing}
            setattr(current, kind, [*existing, *(i for i in incoming if i.item not in known)])
    return list(merged.values())


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
        access_note=_merged_notes(previous.access_note if previous else None, fetch),
        content_sha256=record.content_sha256,
        last_fetched_at=max(fetched, previous.last_fetched_at if previous else 0),
        yielded=yielded,
        robots_verdict=fetch.robots_verdict if fetch else "allowed",
        robots_checked_at=robots_at,
    )


def _merged_notes(previous: str | None, fetch: FetchInfo | None) -> str | None:
    """The access note of a URL several records came from: every note any of
    them carries, once each (an override one record noted is never lost to
    the next record's note)."""
    notes = [
        *(previous or "").split("; "),
        *((fetch.access_note if fetch else None) or "").split("; "),
    ]
    merged = list(dict.fromkeys(note for note in notes if note))
    return "; ".join(merged) or None


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
                academic_year=person.get("academic_year"),
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
