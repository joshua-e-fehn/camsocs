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
   `access_restricted` and not retried. The one exception is an API key a
   source itself asks its API consumers to send (Camdram), passed per call as
   `headers=` — identification, never a way past an access wall.
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
   A redirect into a login service (Raven, Microsoft, Google sign-in; see
   `LOGIN_HOSTS`) is not followed: the page is login-gated, recorded as
   ``access_restricted`` (AGENTS.md: never fetch Raven-gated pages).
8. **`post_form`** is for the rare public page whose own listing loads by a
   form POST (Playwaze fixtures): the same robots check, host slot, retries
   and cache as `fetch` (cached per URL + body), but no redirects are
   followed — a redirect from a data endpoint is a sign-in wall, not content.
9. **The fetch policy** (`sources/policy.py`, Joshua's decision D3). Every
   fetch carries a `FetchPurpose`. With the default ``general`` purpose,
   robots.txt and AI opt-outs hold exactly as above. A ``society`` purpose
   may override a robots.txt *disallow*, and an AI opt-out in
   `ai_input_allowed`, for the D3 URL classes only: society websites,
   Linktree, Google Calendar ICS feeds, SU ``/asset/`` files, and college
   society lists. It never does so on talks.cam or tbc.xyz, and never when
   robots.txt could not be reached. Some hosts are never fetched at all
   (`policy.never_fetched`). An override changes nothing else here: pacing,
   Crawl-delay, the host slot, no cookies, login walls and 401/403 all
   still apply. A result fetched only thanks to an override carries
   `override` (``robots_override:society``), and so does its cache entry.
"""

from __future__ import annotations

import email.utils
import hashlib
import http.cookiejar
import json
import logging
import random
import re
import threading
import time
import urllib.robotparser
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import Literal, Self
from urllib.parse import urljoin, urlsplit

import httpx

from camsocs_pipeline.sources.policy import (
    GENERAL,
    ROBOTS_OVERRIDE_NOTE,
    FetchPurpose,
    ai_optout_override,
    never_fetched,
    never_overridden,
    robots_override,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3
INITIAL_BACKOFF = 20.0
MAX_BACKOFF = 300.0
MAX_REDIRECTS = 5
#: A society page or PDF larger than this is not what we are looking for.
MAX_BYTES = 25 * 1024 * 1024

#: Hosts a site redirects to when a page needs a login. Never followed.
LOGIN_HOSTS = frozenset(
    {
        "raven.cam.ac.uk",
        "auth.srcf.net",
        "login.microsoftonline.com",
        "login.live.com",
        "accounts.google.com",
        "shib.raven.cam.ac.uk",
        "nevar.srcf.net",
    }
)
#: Paths a site redirects to when a page needs a login (Raven-style WLS, a
#: CMS's own login). Never followed.
_LOGIN_PATH = re.compile(
    r"/(wls|auth)/authenticate|/wp-login\.php|/(login|signin|sign-in|saml2?|sso)(/|$|\?)", re.I
)

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
    #: Set when robots.txt disallowed the URL and the fetch went ahead under
    #: the D3 society override (`policy.ROBOTS_OVERRIDE_NOTE`).
    override: str | None = None
    #: The response's ``Last-Modified`` header, as sent (a termcard's age).
    last_modified: str | None = None

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
    #: ``Content-Signal`` preferences (``ai-input`` → ``no`` …), any group.
    content_signals: dict[str, str] | None = None
    #: robots.txt could not be read at all (network error, 5xx, 429): the
    #: host is down rather than closed, so no override applies.
    unreachable: bool = False


#: Crawlers of AI companies that robots.txt files block by name. A host that
#: blocks any of them from a page does not want that page read by a model, so
#: its content is never passed to the LLM (source-research global rules, the
#: talks.cam precedent in §6) — fetched and parsed deterministically only.
AI_AGENTS = (
    "GPTBot",
    "ChatGPT-User",
    "OAI-SearchBot",
    "ClaudeBot",
    "Claude-User",
    "anthropic-ai",
    "CCBot",
    "Google-Extended",
    "PerplexityBot",
    "Applebot-Extended",
    "Bytespider",
    "meta-externalagent",
    "cohere-ai",
)


def _content_signals(text: str) -> dict[str, str]:
    """``Content-Signal: search=yes, ai-train=no`` lines (Cloudflare's
    robots.txt extension), merged; a ``no`` anywhere wins."""
    signals: dict[str, str] = {}
    for line in text.splitlines():
        key, _, value = line.partition(":")
        if key.strip().lower() != "content-signal":
            continue
        for pair in value.split(","):
            name, _, setting = pair.partition("=")
            name, setting = name.strip().lower(), setting.strip().lower()
            if name and setting and signals.get(name) != "no":
                signals[name] = setting
    return signals


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
        headers: Mapping[str, str] | None = None,
        purpose: FetchPurpose = GENERAL,
    ) -> FetchResult:
        """Fetch `url` under every rule in the module docstring.

        `fresh_for`: if the cache holds a successful copy younger than this,
        return it without touching the network (a per-entity TTL for expensive
        pages). `headers`: extra request headers (an API key a source asks
        for); they never replace the User-Agent. `purpose`: the fetch policy
        scope (`sources/policy.py`); only a ``society`` purpose may override
        a robots.txt disallow, and only for the D3 URL classes.
        """
        _require_http(url)
        refused = never_fetched(url)
        if refused is not None:
            return self._result(url, url, "disallowed_by_robots", None, detail=refused)
        # A declared class (a society's own website) belongs to the site it
        # was declared for: a redirect to another domain is re-classified.
        purpose = purpose.bound_to(url)
        cached = self._usable_cache(url, purpose)
        if fresh_for is not None and cached is not None and self._is_fresh(cached[0], fresh_for):
            return _from_cache(url, *cached, detail="fresh in cache")

        current = url
        override: str | None = None
        for _hop in range(MAX_REDIRECTS + 1):
            refused = never_fetched(current)
            if refused is not None:
                return self._result(url, current, "disallowed_by_robots", None, detail=refused)
            policy = self._robots_policy(current)
            if not self._robots_allows(policy, current):
                if policy.unreachable or not robots_override(current, purpose):
                    reason = policy.blanket_disallow or "disallowed by robots.txt"
                    return self._result(url, current, "disallowed_by_robots", None, detail=reason)
                override = ROBOTS_OVERRIDE_NOTE

            conditional = cached if current == url else None
            response, error = self._request(
                current, policy.delay, accept, conditional, extra_headers=headers
            )
            if response is None:
                result = self._result(
                    url, current, "unreachable", None, detail=error, override=override
                )
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
                login = urlsplit(current).netloc.lower().split(":")[0]
                if login in LOGIN_HOSTS or _LOGIN_PATH.search(urlsplit(current).path):
                    result = self._result(
                        url,
                        current,
                        "access_restricted",
                        response.status_code,
                        detail=f"redirects to a login at {login}",
                        override=override,
                    )
                    self._record_negative(url, result)
                    return result
                continue

            return self._classify(url, current, response, cached, override=override)

        return self._result(url, current, "http_error", None, detail="too many redirects")

    def allows(self, url: str, purpose: FetchPurpose = GENERAL) -> bool:
        """Whether we may fetch `url` for `purpose`: robots.txt lets us, or a
        society purpose overrides its disallow (`sources/policy.py`). Loads the
        host's robots.txt on first use (paced like any request); never
        requests `url` itself — for deciding what to record about a resource
        before fetching it."""
        _require_http(url)
        if never_fetched(url) is not None:
            return False
        policy = self._robots_policy(url)
        if self._robots_allows(policy, url):
            return True
        return not policy.unreachable and robots_override(url, purpose)

    def cached(self, url: str, purpose: FetchPurpose = GENERAL) -> FetchResult | None:
        """The last successful copy of `url` in the cache, without touching the
        network (a dry run replays from here), or None. A copy fetched under a
        society override is served only to a purpose that may override too."""
        _require_http(url)
        cached = self._usable_cache(url, purpose.bound_to(url))
        return None if cached is None else _from_cache(url, *cached, detail="from cache")

    def robots_verdict(self, url: str) -> Literal["allowed", "disallowed", "crawl_delay"]:
        """What robots.txt says about `url` for us (the `sources.robotsVerdict`
        vocabulary). Reads the host's robots.txt if this run has not yet."""
        policy = self._robots_policy(url)
        if not self._robots_allows(policy, url):
            return "disallowed"
        return "crawl_delay" if policy.delay > 0 else "allowed"

    def ai_input_allowed(self, url: str, purpose: FetchPurpose = GENERAL) -> bool:
        """Whether this host lets `url`'s content reach a language model: its
        robots.txt names no AI crawler (`AI_AGENTS`) as disallowed from the
        URL and sets no ``Content-Signal: ai-input=no``. Fetches robots.txt if
        this run has not yet; an unreadable robots.txt answers False.

        A society `purpose` overrides the opt-out for the D3 URL classes
        (`policy.ai_optout_override`); talks.cam and tbc.xyz are never
        overridden and always answer False."""
        _require_http(url)
        if never_overridden(url):
            return False
        if ai_optout_override(url, purpose):
            return True
        policy = self._robots_policy(url)
        if policy.blanket_disallow is not None:
            return False
        if (policy.content_signals or {}).get("ai-input") == "no":
            return False
        if policy.parser is None:
            return True
        return all(policy.parser.can_fetch(agent, url) for agent in AI_AGENTS)

    def post_form(
        self,
        url: str,
        form: Mapping[str, str],
        *,
        fresh_for: timedelta | None = None,
        accept: str = "text/html,application/xhtml+xml,*/*;q=0.8",
    ) -> FetchResult:
        """POST `form` to `url` (url-encoded) under the same rules as `fetch`,
        for a public page whose listing loads by a form POST. Cached per URL +
        form body. A redirect is not followed: it is reported as `http_error`
        (from a data endpoint it means a sign-in wall)."""
        _require_http(url)
        cache_key = _form_cache_key(url, form)
        cached = self._read_cache(cache_key)
        if fresh_for is not None and cached is not None and self._is_fresh(cached[0], fresh_for):
            fresh = _from_cache(cache_key, *cached, detail="fresh in cache")
            return replace(fresh, url=url, final_url=url)
        policy = self._robots_policy(url)
        if not self._robots_allows(policy, url):
            reason = policy.blanket_disallow or "disallowed by robots.txt"
            return self._result(url, url, "disallowed_by_robots", None, detail=reason)
        response, error = self._request(url, policy.delay, accept, None, form=form)
        if response is None:
            result = self._result(url, url, "unreachable", None, detail=error)
            self._record_negative(cache_key, result)
            return result
        if response.status_code in REDIRECT_STATUSES:
            return self._result(
                url,
                url,
                "http_error",
                response.status_code,
                detail="refusing to follow a redirect from a form POST",
            )
        return replace(self._classify(cache_key, url, response, cached), url=url)

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
            return _RobotsPolicy(None, f"robots.txt unreachable: {error}", 0.0, unreachable=True)
        status = response.status_code
        if status in RESTRICTED_STATUSES:
            return _RobotsPolicy(None, f"robots.txt answered {status}", 0.0)
        if status >= 500 or status == 429:
            return _RobotsPolicy(None, f"robots.txt answered {status}", 0.0, unreachable=True)
        if status >= 400:
            # No robots.txt: everything is allowed (RFC 9309 §2.3.1.3).
            return _RobotsPolicy(None, None, 0.0)
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(response.text.splitlines())
        signals = _content_signals(response.text)
        delay = 0.0
        crawl_delay = parser.crawl_delay(self.user_agent)
        if crawl_delay:
            delay = float(crawl_delay)
        rate = parser.request_rate(self.user_agent)
        if rate and rate.requests:
            delay = max(delay, rate.seconds / rate.requests)
        return _RobotsPolicy(parser, None, delay, signals)

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
        extra_headers: Mapping[str, str] | None = None,
        form: Mapping[str, str] | None = None,
    ) -> tuple[httpx.Response | None, str | None]:
        """One logical request with retries, inside the host's slot: a GET,
        or a form POST when `form` is given.

        Returns `(response, None)` for any HTTP answer worth classifying, or
        `(None, reason)` when transient failures outlasted the retries.
        """
        headers = {**(extra_headers or {}), **self._headers, "Accept": accept}
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
                    if form is None:
                        response = self._client.get(url, headers=headers, follow_redirects=follow)
                    else:
                        response = self._client.post(
                            url, headers=headers, data=dict(form), follow_redirects=False
                        )
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
        *,
        override: str | None = None,
    ) -> FetchResult:
        status = response.status_code
        if status == 304 and cached is not None and cached[1] is not None:
            meta, body = cached
            result = self._result(
                url,
                final_url,
                "unchanged",
                status,
                content=body,
                content_type=meta.get("content_type"),
                content_sha256=meta.get("content_sha256"),
                from_cache=True,
                override=override,
                last_modified=response.headers.get("last-modified") or meta.get("last_modified"),
            )
            if override != meta.get("override"):
                self._write_cache(
                    url,
                    result,
                    body,
                    etag=meta.get("etag"),
                    last_modified=meta.get("last_modified"),
                )
            return result
        if status in NOT_FOUND_STATUSES:
            result = self._result(url, final_url, "not_found", status, override=override)
            self._record_negative(url, result)
            return result
        if status in RESTRICTED_STATUSES:
            result = self._result(url, final_url, "access_restricted", status, override=override)
            self._record_negative(url, result)
            return result
        if not 200 <= status < 300:
            return self._result(
                url, final_url, "http_error", status, detail=f"HTTP {status}", override=override
            )

        body = response.content
        if len(body) > MAX_BYTES:
            return self._result(
                url, final_url, "http_error", status, detail="response too large", override=override
            )
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
            override=override,
            last_modified=response.headers.get("last-modified"),
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

    def _usable_cache(self, url: str, purpose: FetchPurpose) -> tuple[dict, bytes | None] | None:
        """The cached copy of `url`, unless it was fetched under a society
        override that `purpose` may not use: the cache never launders a
        robots.txt override into a general fetch."""
        cached = self._read_cache(url)
        if cached is not None and cached[0].get("override") and not robots_override(url, purpose):
            return None
        return cached

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
        if result.override:
            meta["override"] = result.override
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
        if result.override:
            record["override"] = result.override
        _atomic_write(negative_path, (json.dumps(record, indent=2) + "\n").encode("utf-8"))


# --- helpers ------------------------------------------------------------------


def _from_cache(url: str, meta: dict, body: bytes | None, *, detail: str) -> FetchResult:
    """A cached successful copy as an `unchanged` result."""
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
        detail=detail,
        override=meta.get("override"),
        last_modified=meta.get("last_modified"),
    )


class _RejectAllCookies(http.cookiejar.DefaultCookiePolicy):
    """Never store a cookie and never send one."""

    def set_ok(self, cookie: http.cookiejar.Cookie, request: object) -> bool:
        return False

    def return_ok(self, cookie: http.cookiejar.Cookie, request: object) -> bool:
        return False


def _form_cache_key(url: str, form: Mapping[str, str]) -> str:
    """A cache identity for a POST: the URL plus a hash of its sorted form."""
    body = "&".join(f"{key}={form[key]}" for key in sorted(form))
    return f"{url}#post-{hashlib.sha256(body.encode('utf-8')).hexdigest()[:16]}"


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
    "AI_AGENTS",
    "LOGIN_HOSTS",
    "MAX_REDIRECTS",
    "SHARED_GATES",
    "FetchOutcome",
    "FetchResult",
    "HostGates",
    "PoliteClient",
]
