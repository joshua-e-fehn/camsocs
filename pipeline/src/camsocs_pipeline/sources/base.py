"""The polite HTTP client every source goes through.

Adapted from Bundestracker `api/base.py` (pacing, backoff, honest User-Agent,
no silent redirects) and cambridge `camtalks/fetch.py` (robots `Crawl-delay`,
`Retry-After`). The difference from Bundestracker: that client talks to one WAF-
fronted origin and refuses all concurrency; this one crawls many unrelated
hosts, so the rules are **per host**.

Properties enforced here rather than left to each caller's discipline:

1. **robots.txt per host, with our User-Agent.** Fetched once per host per
   process, through the same pacing as any other request. `Crawl-delay` and
   `Request-rate` raise that host's interval. A robots.txt that answers 401/403
   or cannot be reached (5xx, network error) means *disallow everything* for
   the run — RFC 9309 treats unreachable as complete disallow, and an access
   wall is not something to crawl around. 404/410 (no robots.txt) allows all.
   Note talks.cam.ac.uk disallows AI crawlers by name: fetching stays
   deterministic and honest here, and any LLM step runs over the cache later.
2. **One request in flight per host**, at least `min_interval` apart (measured
   from the end of the previous request). Different hosts may be fetched
   concurrently from different threads. Backoff sleeps *hold* the host slot,
   so a second thread cannot slip a request in during a retry wait.
3. **Retries only for transient failures**: 429, 503 and other 5xx, timeouts
   and connection errors, backing off 20 s → 300 s with jitter and honouring
   `Retry-After` (delta-seconds or HTTP-date, capped at 300 s).
4. **No auth bypass.** No cookies, no credentials. 401/403 are recorded as
   `access_restricted` and not retried.
5. **Raw cache under `var/cache/<host>/`**, one body + one JSON meta per URL
   (named by the URL's SHA-256), with the content's SHA-256. Conditional
   requests (`If-None-Match` / `If-Modified-Since`) and hash comparison report
   an unchanged page as `unchanged`; `fresh_for` skips the network entirely.
6. **Negative evidence is evidence.** 404/410 is `not_found` and is recorded in
   the cache meta. Nothing here ever says "verified": a `FetchResult` reports
   what the server said, and verification is decided downstream — never from a
   failed fetch.
7. **Redirects are followed by hand** (at most 5 hops, http/https only), each
   hop checked against its own host's robots.txt and paced on its own host.
"""

from __future__ import annotations

import email.utils
import hashlib
import http.cookiejar
import json
import logging
import random
import threading
import time
import urllib.robotparser
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import Literal, Self
from urllib.parse import urljoin, urlsplit

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3
INITIAL_BACKOFF = 20.0
MAX_BACKOFF = 300.0
MAX_REDIRECTS = 5
#: A society page or PDF larger than this is not what we are looking for.
MAX_BYTES = 25 * 1024 * 1024

RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
NOT_FOUND_STATUSES = frozenset({404, 410})
RESTRICTED_STATUSES = frozenset({401, 403})

FetchOutcome = Literal[
    "fetched",  # 200 with new or changed content
    "unchanged",  # 304, identical hash, or fresh in cache
    "not_found",  # 404/410 — negative evidence
    "access_restricted",  # 401/403 — not retried, never with credentials
    "disallowed_by_robots",  # no request was made
    "unreachable",  # transient failures outlasted the retries
    "http_error",  # any other non-2xx, or a malformed/oversized response
]


@dataclass(frozen=True)
class FetchResult:
    """What one fetch observed. Evidence about a URL, never a verdict on a fact."""

    url: str
    final_url: str
    outcome: FetchOutcome
    status: int | None
    fetched_at: str
    content: bytes | None = None
    content_type: str | None = None
    content_sha256: str | None = None
    from_cache: bool = False
    detail: str | None = None

    @property
    def ok(self) -> bool:
        """Whether there is content to work with."""
        return self.outcome in ("fetched", "unchanged") and self.content is not None

    @property
    def text(self) -> str:
        if self.content is None:
            return ""
        return self.content.decode(_charset(self.content_type), errors="replace")


# --- per-host gates -----------------------------------------------------------


class _HostGate:
    """One host's slot: a lock (one request in flight) and its pacing."""

    def __init__(self, min_interval: float) -> None:
        self.min_interval = min_interval
        self.lock = threading.Lock()
        self.last_finished: float | None = None


class HostGates:
    """Process-wide registry of per-host gates, shared by every client.

    Shared by default (`SHARED_GATES`) so two client instances crawling the same
    host still add up to one polite stream against it.
    """

    def __init__(self) -> None:
        self._gates: dict[str, _HostGate] = {}
        self._lock = threading.Lock()

    def gate(self, host: str, min_interval: float) -> _HostGate:
        with self._lock:
            gate = self._gates.get(host)
            if gate is None:
                gate = self._gates[host] = _HostGate(min_interval)
            elif min_interval > gate.min_interval:
                gate.min_interval = min_interval
            return gate


SHARED_GATES = HostGates()


@dataclass
class _RobotsPolicy:
    parser: urllib.robotparser.RobotFileParser | None
    #: None = allow everything; a reason string = disallow everything.
    blanket_disallow: str | None
    delay: float


# --- the client ---------------------------------------------------------------


class PoliteClient:
    """A robots-aware, per-host-paced, caching HTTP client. Thread-safe."""

    def __init__(
        self,
        *,
        user_agent: str,
        cache_dir: Path,
        min_interval: float = 1.0,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = DEFAULT_TIMEOUT,
        client: httpx.Client | None = None,
        gates: HostGates | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not user_agent:
            raise ValueError("A User-Agent is required; see Settings.require_user_agent.")
        self.user_agent = user_agent
        self.cache_dir = cache_dir
        self.min_interval = min_interval
        self.max_retries = max_retries
        self._gates = gates or SHARED_GATES
        self._clock = clock
        self._sleep = sleep
        self._now = now
        self._robots: dict[str, _RobotsPolicy] = {}
        self._robots_lock = threading.Lock()
        self._owns_client = client is None
        # A cookie jar that refuses everything: no session state is ever kept
        # or sent back, so the crawler is the same anonymous visitor every time.
        self._client = client or httpx.Client(
            timeout=timeout, cookies=http.cookiejar.CookieJar(policy=_RejectAllCookies())
        )
        self._headers = {"User-Agent": user_agent}

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

    # -- public API ------------------------------------------------------------

    def fetch(
        self,
        url: str,
        *,
        fresh_for: timedelta | None = None,
        accept: str = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    ) -> FetchResult:
        """Fetch `url` under every rule in the module docstring.

        `fresh_for`: if the cache holds a successful copy younger than this,
        return it without touching the network (a per-entity TTL for expensive
        pages).
        """
        _require_http(url)
        cached = self._read_cache(url)
        if fresh_for is not None and cached is not None and self._is_fresh(cached[0], fresh_for):
            meta, body = cached
            return FetchResult(
                url=url,
                final_url=meta.get("final_url", url),
                outcome="unchanged",
                status=meta.get("status"),
                fetched_at=meta["fetched_at"],
                content=body,
                content_type=meta.get("content_type"),
                content_sha256=meta.get("content_sha256"),
                from_cache=True,
                detail="fresh in cache",
            )

        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            policy = self._robots_policy(current)
            if not self._robots_allows(policy, current):
                reason = policy.blanket_disallow or "disallowed by robots.txt"
                return self._result(url, current, "disallowed_by_robots", None, detail=reason)

            conditional = cached if current == url else None
            response, error = self._request(current, policy.delay, accept, conditional)
            if response is None:
                result = self._result(url, current, "unreachable", None, detail=error)
                self._record_negative(url, result)
                return result

            # Not `response.is_redirect`: httpx counts a bare 304 as one.
            location = response.headers.get("location")
            if response.status_code in REDIRECT_STATUSES and location:
                current = urljoin(current, location)
                if urlsplit(current).scheme not in ("http", "https"):
                    return self._result(
                        url,
                        current,
                        "http_error",
                        response.status_code,
                        detail=f"refusing non-http redirect to {current}",
                    )
                continue

            return self._classify(url, current, response, cached)

        return self._result(url, current, "http_error", None, detail="too many redirects")

    # -- robots ----------------------------------------------------------------

    def _robots_policy(self, url: str) -> _RobotsPolicy:
        origin = _origin(url)
        with self._robots_lock:
            policy = self._robots.get(origin)
        if policy is not None:
            return policy
        policy = self._load_robots(origin)
        with self._robots_lock:
            self._robots.setdefault(origin, policy)
            return self._robots[origin]

    def _load_robots(self, origin: str) -> _RobotsPolicy:
        robots_url = f"{origin}/robots.txt"
        response, error = self._request(robots_url, 0.0, "text/plain", None, follow=True)
        if response is None:
            logger.warning(
                "robots.txt unreachable for %s (%s) — treating as disallow", origin, error
            )
            return _RobotsPolicy(None, f"robots.txt unreachable: {error}", 0.0)
        status = response.status_code
        if status in RESTRICTED_STATUSES:
            return _RobotsPolicy(None, f"robots.txt answered {status}", 0.0)
        if status >= 500 or status == 429:
            return _RobotsPolicy(None, f"robots.txt answered {status}", 0.0)
        if status >= 400:
            # No robots.txt: everything is allowed (RFC 9309 §2.3.1.3).
            return _RobotsPolicy(None, None, 0.0)
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(response.text.splitlines())
        delay = 0.0
        crawl_delay = parser.crawl_delay(self.user_agent)
        if crawl_delay:
            delay = float(crawl_delay)
        rate = parser.request_rate(self.user_agent)
        if rate and rate.requests:
            delay = max(delay, rate.seconds / rate.requests)
        return _RobotsPolicy(parser, None, delay)

    def _robots_allows(self, policy: _RobotsPolicy, url: str) -> bool:
        if policy.blanket_disallow is not None:
            return False
        if policy.parser is None:
            return True
        return policy.parser.can_fetch(self.user_agent, url)

    # -- transport -------------------------------------------------------------

    @contextmanager
    def _slot(self, host: str, robots_delay: float) -> Iterator[None]:
        gate = self._gates.gate(host, max(self.min_interval, robots_delay))
        with gate.lock:
            if gate.last_finished is not None:
                wait = gate.min_interval - (self._clock() - gate.last_finished)
                if wait > 0:
                    self._sleep(wait)
            try:
                yield
            finally:
                gate.last_finished = self._clock()

    def _request(
        self,
        url: str,
        robots_delay: float,
        accept: str,
        cached: tuple[dict, bytes | None] | None,
        *,
        follow: bool = False,
    ) -> tuple[httpx.Response | None, str | None]:
        """One logical request with retries, inside the host's slot.

        Returns `(response, None)` for any HTTP answer worth classifying, or
        `(None, reason)` when transient failures outlasted the retries.
        """
        headers = {**self._headers, "Accept": accept}
        if cached is not None:
            meta = cached[0]
            if meta.get("etag"):
                headers["If-None-Match"] = meta["etag"]
            if meta.get("last_modified"):
                headers["If-Modified-Since"] = meta["last_modified"]

        host = urlsplit(url).netloc.lower()
        # Also for an injected client, whose jar we do not control.
        self._client.cookies.clear()
        backoff = INITIAL_BACKOFF
        last_error = "no attempt made"
        with self._slot(host, robots_delay):
            for attempt in range(self.max_retries + 1):
                try:
                    response = self._client.get(url, headers=headers, follow_redirects=follow)
                except (httpx.TimeoutException, httpx.TransportError) as error:
                    last_error = f"{type(error).__name__}: {error}"
                    wait = _jittered(backoff)
                else:
                    if response.status_code not in RETRYABLE_STATUSES:
                        return response, None
                    last_error = f"HTTP {response.status_code}"
                    retry_after = _retry_after_seconds(response, self._now())
                    wait = retry_after if retry_after is not None else _jittered(backoff)
                if attempt < self.max_retries:
                    wait = min(wait, MAX_BACKOFF)
                    logger.warning(
                        "%s on %s (attempt %d/%d) — backing off %.0fs",
                        last_error,
                        url,
                        attempt + 1,
                        self.max_retries + 1,
                        wait,
                    )
                    self._sleep(wait)
                    backoff = min(backoff * 2, MAX_BACKOFF)
        return None, last_error

    # -- classification and cache ---------------------------------------------

    def _classify(
        self,
        url: str,
        final_url: str,
        response: httpx.Response,
        cached: tuple[dict, bytes | None] | None,
    ) -> FetchResult:
        status = response.status_code
        if status == 304 and cached is not None and cached[1] is not None:
            meta, body = cached
            return self._result(
                url,
                final_url,
                "unchanged",
                status,
                content=body,
                content_type=meta.get("content_type"),
                content_sha256=meta.get("content_sha256"),
                from_cache=True,
            )
        if status in NOT_FOUND_STATUSES:
            result = self._result(url, final_url, "not_found", status)
            self._record_negative(url, result)
            return result
        if status in RESTRICTED_STATUSES:
            result = self._result(url, final_url, "access_restricted", status)
            self._record_negative(url, result)
            return result
        if not 200 <= status < 300:
            return self._result(url, final_url, "http_error", status, detail=f"HTTP {status}")

        body = response.content
        if len(body) > MAX_BYTES:
            return self._result(url, final_url, "http_error", status, detail="response too large")
        digest = hashlib.sha256(body).hexdigest()
        previous = cached[0].get("content_sha256") if cached is not None else None
        outcome: FetchOutcome = "unchanged" if previous == digest else "fetched"
        result = self._result(
            url,
            final_url,
            outcome,
            status,
            content=body,
            content_type=response.headers.get("content-type"),
            content_sha256=digest,
        )
        self._write_cache(
            url,
            result,
            body,
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
        )
        return result

    def _result(
        self,
        url: str,
        final_url: str,
        outcome: FetchOutcome,
        status: int | None,
        **fields: object,
    ) -> FetchResult:
        return FetchResult(
            url=url,
            final_url=final_url,
            outcome=outcome,
            status=status,
            fetched_at=self._now().isoformat(),
            **fields,  # type: ignore[arg-type]
        )

    def cache_paths(self, url: str) -> tuple[Path, Path]:
        """`(body, meta)` paths for a URL: `var/cache/<host>/<sha256(url)>{.body,.json}`."""
        host = urlsplit(url).netloc.lower().replace(":", "_") or "_"
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        folder = self.cache_dir / host
        return folder / f"{key}.body", folder / f"{key}.json"

    def _read_cache(self, url: str) -> tuple[dict, bytes | None] | None:
        body_path, meta_path = self.cache_paths(url)
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if meta.get("outcome") not in ("fetched", "unchanged"):
            return None
        try:
            body = body_path.read_bytes()
        except OSError:
            return None
        if hashlib.sha256(body).hexdigest() != meta.get("content_sha256"):
            logger.warning("Cache body for %s does not match its hash — ignoring it", url)
            return None
        return meta, body

    def _is_fresh(self, meta: dict, fresh_for: timedelta) -> bool:
        try:
            fetched = datetime.fromisoformat(meta["fetched_at"])
        except (KeyError, ValueError):
            return False
        return self._now() - fetched < fresh_for

    def _write_cache(
        self,
        url: str,
        result: FetchResult,
        body: bytes,
        *,
        etag: str | None,
        last_modified: str | None,
    ) -> None:
        body_path, meta_path = self.cache_paths(url)
        body_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(body_path, body)
        meta = {
            "url": url,
            "final_url": result.final_url,
            "outcome": result.outcome,
            "status": result.status,
            "fetched_at": result.fetched_at,
            "content_type": result.content_type,
            "content_sha256": result.content_sha256,
            "etag": etag,
            "last_modified": last_modified,
        }
        _atomic_write(meta_path, (json.dumps(meta, indent=2) + "\n").encode("utf-8"))

    def _record_negative(self, url: str, result: FetchResult) -> None:
        """Keep the latest negative outcome next to (not instead of) any earlier
        body, so "was there, now 404" stays visible."""
        _body_path, meta_path = self.cache_paths(url)
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        negative_path = meta_path.with_suffix(".last-failure.json")
        record = {
            "url": url,
            "final_url": result.final_url,
            "outcome": result.outcome,
            "status": result.status,
            "fetched_at": result.fetched_at,
            "detail": result.detail,
        }
        _atomic_write(negative_path, (json.dumps(record, indent=2) + "\n").encode("utf-8"))


# --- helpers ------------------------------------------------------------------


class _RejectAllCookies(http.cookiejar.DefaultCookiePolicy):
    """Never store a cookie and never send one."""

    def set_ok(self, cookie: http.cookiejar.Cookie, request: object) -> bool:
        return False

    def return_ok(self, cookie: http.cookiejar.Cookie, request: object) -> bool:
        return False


def _require_http(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"Not an http(s) URL: {url!r}")


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc.lower()}"


def _jittered(seconds: float) -> float:
    """Spread retries so restarted workers do not re-synchronise."""
    return seconds * random.uniform(0.8, 1.2)


def _retry_after_seconds(response: httpx.Response, now: datetime) -> float | None:
    """`Retry-After` as seconds: delta-seconds or an HTTP-date. None if absent."""
    header = response.headers.get("retry-after")
    if header is None:
        return None
    header = header.strip()
    if header.isdigit():
        return float(header)
    try:
        when = email.utils.parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - now).total_seconds())


def _charset(content_type: str | None) -> str:
    if content_type:
        for part in content_type.split(";")[1:]:
            key, _, value = part.strip().partition("=")
            if key.lower() == "charset" and value:
                return value.strip('"')
    return "utf-8"


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f"{path.name}.tmp-{threading.get_ident()}")
    temporary.write_bytes(data)
    temporary.replace(path)


__all__ = [
    "MAX_REDIRECTS",
    "SHARED_GATES",
    "FetchOutcome",
    "FetchResult",
    "HostGates",
    "PoliteClient",
]
