"""Fetch statistics per stage: what the polite client did, as counts only.

The runner (`pipeline/sync.py`) activates one collector per stage
(``with fetch_stats.activate(stage.name, phase=stage.phase) as stats:``).
While it is active, `sources/base.py` reports every logical fetch (a
`PoliteClient.fetch` or `post_form`, redirects and retries included) and what
happened inside it: retries, 429 answers, transport errors (by exception
class), address refusals, robots.txt hosts that could not be reached, the
hosts contacted and the seconds spent waiting for a host slot.
`extract/memo.py` counts LLM cache hits and fresh generations the same way.

Afterwards `StageStats.metrics()` gives the stage's totals, merged into
`StageReport.metrics` (they travel to Convex on `runs/finish` and to
PostHog on `harvest_stage_completed`), and `StageStats.by_host_class()` the
same counters per host class, one `harvest_source_fetched` event each
(`telemetry.HarvestTelemetry.sources_fetched`). That event alone also carries
`transportErrorType`: the class's most frequent transport exception class
name (``ConnectTimeout``, ``ConnectError``…), when there was one. It is not a
counter, so it stays out of `CLASS_COUNTERS` and `StageReport.metrics`.

**Host classes** (`host_class`), first match wins:

1. ``never_override``: talks.cam and tbc.xyz (`policy.never_overridden`).
2. A D3 society URL class (``society_website``, ``linktree``,
   ``google_calendar_feed``, ``su_asset``, ``college_society_list``): by the
   URL's shape (`policy.url_class_of`) or the class the purpose declared
   (`policy.society_class`).
3. ``registry`` for every other fetch of a stage in a register phase
   (`REGISTER_PHASES`: the society registers, ``harvest``): the SU directory,
   Camdram, CUCBC, the Proctors' and Sport registers, the colleges' lists.
4. ``university_main_site``: the University's, a college's or a department's
   own site on cam.ac.uk, the central www.cam.ac.uk included
   (`policy.is_cam_main_site`).
5. ``registry``: the University's register and admin hosts, that is a
   general host on cam.ac.uk that is not a main site (webservices.admin…),
   or a host with a recorded permission (`policy.permission_for`).
6. ``other``: everything else, including the other general hosts (search
   engines, social and video sites, link shorteners, gov.uk and the
   national organisations) and the event sources outside a register phase.

**Never a host or a URL.** A fetch is reduced to its host *class*
(`HOST_CLASSES`, decided by `sources/policy.py`'s own functions); hosts are
kept in memory only to count them, and never leave this module.

**Process-global, thread-safe.** Stages run one after another, but a stage's
worker threads (ThreadPoolExecutors) fetch concurrently and do not inherit a
ContextVar, so the active collector is a module global behind a lock. The
per-fetch trace (`fetch_trace`) is thread-local: one fetch runs on one
thread from start to finish. With no active collector (a test, a CLI command
that is not a run) every call is a no-op.
"""

from __future__ import annotations

import threading
from collections import Counter
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from camsocs_pipeline.sources import policy

#: Where a fetch went, as one word (`host_class`). Never the host itself.
HOST_CLASSES: tuple[str, ...] = (
    "registry",
    "university_main_site",
    "society_website",
    "linktree",
    "google_calendar_feed",
    "su_asset",
    "college_society_list",
    "never_override",
    "other",
)

#: Counters kept per host class (and summed per stage), in report order.
CLASS_COUNTERS: tuple[str, ...] = (
    "fetchRequests",
    "fetchFetched",
    "fetchUnchanged",
    "fetchNotFound",
    "fetchRestricted",
    "fetchRobotsBlocked",
    "fetchUnreachable",
    "fetchHttpError",
    "fetchCacheHits",
    "fetchStatus2xx",
    "fetchStatus3xx",
    "fetchStatus4xx",
    "fetchStatus5xx",
    "fetchTooMany",
    "fetchRetries",
    "fetchAddressRefused",
    "fetchOverrideSociety",
    "fetchOverridePermission",
    "robotsHostsUnreachable",
    "hostsContacted",
    "fetchWaitS",
)

#: Phases whose stages read a register (`pipeline.context.PHASES`): there,
#: a fetch of no fixed class (rules 1-2 above) is a ``registry`` fetch.
REGISTER_PHASES = frozenset({"harvest"})

#: Counters other modules add through `count` (only when non-zero).
EXTRA_COUNTERS: tuple[str, ...] = ("llmCacheHits", "llmGenerations")

_OUTCOME_COUNTER = {
    "fetched": "fetchFetched",
    "unchanged": "fetchUnchanged",
    "not_found": "fetchNotFound",
    "access_restricted": "fetchRestricted",
    "disallowed_by_robots": "fetchRobotsBlocked",
    "unreachable": "fetchUnreachable",
    "http_error": "fetchHttpError",
}

_OVERRIDE_COUNTER = {
    policy.ROBOTS_OVERRIDE_NOTE: "fetchOverrideSociety",
    policy.PERMISSION_ROBOTS_NOTE: "fetchOverridePermission",
}


def host_class(
    url: str, purpose: policy.FetchPurpose = policy.GENERAL, *, register: bool = False
) -> str:
    """The class of `url`'s host for statistics (`HOST_CLASSES`), decided
    by `sources/policy.py`'s functions in the order the module docstring
    lists. `register`: the fetching stage reads a register
    (`REGISTER_PHASES`)."""
    try:
        if policy.never_overridden(url):
            return "never_override"
        shaped = policy.url_class_of(url) or policy.society_class(url, purpose)
        if shaped is not None:
            return shaped
        if register:
            return "registry"
        if policy.is_cam_main_site(url):
            return "university_main_site"
        if policy.permission_for(url, "fetch") is not None or (
            _on_cam(url) and policy.is_general_host(url)
        ):
            return "registry"
    except ValueError:
        pass
    return "other"


def _on_cam(url: str) -> bool:
    host = policy.host_of(url)
    return host == "cam.ac.uk" or host.endswith(".cam.ac.uk")


def _host(url: str) -> str:
    return policy.host_of(url)


@dataclass
class FetchTrace:
    """What happened inside one logical fetch (thread-local)."""

    retries: int = 0
    too_many: int = 0
    address_refused: bool = False
    wait_s: float = 0.0
    hosts: set[str] = field(default_factory=set)
    robots_unreachable: set[str] = field(default_factory=set)
    #: Transport exceptions per class name (``ConnectTimeout``: 2).
    transport_errors: Counter[str] = field(default_factory=Counter)


@dataclass
class _ClassStats:
    counts: dict[str, int] = field(default_factory=dict)
    wait_s: float = 0.0
    hosts: set[str] = field(default_factory=set)
    robots_unreachable: set[str] = field(default_factory=set)
    transport_errors: Counter[str] = field(default_factory=Counter)

    def add(self, name: str, amount: int = 1) -> None:
        if amount:
            self.counts[name] = self.counts.get(name, 0) + amount

    def merge(self, trace: FetchTrace) -> None:
        self.add("fetchRetries", trace.retries)
        self.add("fetchTooMany", trace.too_many)
        self.add("fetchAddressRefused", int(trace.address_refused))
        self.wait_s += trace.wait_s
        self.hosts |= trace.hosts
        self.robots_unreachable |= trace.robots_unreachable
        self.transport_errors.update(trace.transport_errors)

    @property
    def active(self) -> bool:
        return bool(self.counts or self.hosts or self.robots_unreachable or self.wait_s)

    def values(self) -> dict[str, int | float | str]:
        values: dict[str, int | float | str] = dict.fromkeys(CLASS_COUNTERS, 0)
        values.update(self.counts)
        values["robotsHostsUnreachable"] = len(self.robots_unreachable)
        values["hostsContacted"] = len(self.hosts)
        values["fetchWaitS"] = round(self.wait_s, 3)
        if self.transport_errors:
            # Most frequent first; a tie goes to the name first in order.
            values["transportErrorType"] = min(
                self.transport_errors, key=lambda name: (-self.transport_errors[name], name)
            )
        return values


class StageStats:
    """One stage's statistics. Filled while it is the active collector."""

    def __init__(self, stage: str, *, register: bool = False) -> None:
        self.stage = stage
        #: The stage reads a register (`REGISTER_PHASES`, `host_class`).
        self.register = register
        self._lock = threading.Lock()
        self._classes: dict[str, _ClassStats] = {}
        self._extra: dict[str, int] = {}

    def _class(self, name: str) -> _ClassStats:
        stats = self._classes.get(name)
        if stats is None:
            stats = self._classes[name] = _ClassStats()
        return stats

    def record(
        self,
        klass: str,
        *,
        outcome: str,
        status: int | None,
        from_cache: bool,
        override: str | None,
        trace: FetchTrace | None,
    ) -> None:
        with self._lock:
            stats = self._class(klass if klass in HOST_CLASSES else "other")
            stats.add("fetchRequests")
            stats.add(_OUTCOME_COUNTER.get(outcome, "fetchHttpError"))
            if from_cache:
                stats.add("fetchCacheHits")
            if isinstance(status, int) and 200 <= status < 600:
                stats.add(f"fetchStatus{status // 100}xx")
            counter = _OVERRIDE_COUNTER.get(override or "")
            if counter is not None:
                stats.add(counter)
            if trace is not None:
                stats.merge(trace)

    def merge_loose(self, trace: FetchTrace) -> None:
        """Activity outside any logical fetch (a robots.txt read for
        `robots_verdict`): counted under ``other``."""
        with self._lock:
            self._class("other").merge(trace)

    def count(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._extra[name] = self._extra.get(name, 0) + amount

    def by_host_class(self) -> dict[str, dict[str, int | float | str]]:
        """Every counter per host class that saw any activity, and its
        `transportErrorType` when it had transport errors."""
        with self._lock:
            return {
                name: stats.values()
                for name, stats in sorted(self._classes.items())
                if stats.active
            }

    def metrics(self) -> dict[str, int | float]:
        """The stage's totals for `StageReport.metrics`: every fetch counter
        when the stage fetched at all (zeros included, so readers can take
        medians), and the extra counters that are non-zero."""
        with self._lock:
            active = [stats for stats in self._classes.values() if stats.active]
            out: dict[str, int | float] = {}
            if active:
                out = dict.fromkeys(CLASS_COUNTERS, 0)
                wait = 0.0
                hosts: set[str] = set()
                robots: set[str] = set()
                for stats in active:
                    for name, value in stats.counts.items():
                        out[name] = out[name] + value
                    wait += stats.wait_s
                    hosts |= stats.hosts
                    robots |= stats.robots_unreachable
                out["fetchWaitS"] = round(wait, 3)
                out["hostsContacted"] = len(hosts)
                out["robotsHostsUnreachable"] = len(robots)
            out.update({name: value for name, value in self._extra.items() if value})
            return out


_lock = threading.Lock()
_current: StageStats | None = None
_local = threading.local()


def current() -> StageStats | None:
    """The stage collector now active, if any."""
    return _current


@contextmanager
def activate(stage: str, *, phase: str | None = None) -> Iterator[StageStats]:
    """Collect statistics for `stage` (of `phase`, `pipeline.context.PHASES`)
    until the block ends; yields them."""
    global _current
    stats = StageStats(stage, register=phase in REGISTER_PHASES)
    with _lock:
        previous, _current = _current, stats
    try:
        yield stats
    finally:
        with _lock:
            _current = previous


@contextmanager
def fetch_trace() -> Iterator[FetchTrace]:
    """One logical fetch on this thread: the notes below land in it."""
    trace = FetchTrace()
    previous = getattr(_local, "trace", None)
    _local.trace = trace
    try:
        yield trace
    finally:
        _local.trace = previous


def _trace() -> tuple[FetchTrace, bool]:
    """This thread's open trace, or a loose one (flushed at once)."""
    trace = getattr(_local, "trace", None)
    return (trace, False) if trace is not None else (FetchTrace(), True)


def _note(update: Callable[[FetchTrace], None]) -> None:
    stats = _current
    if stats is None:
        return
    trace, loose = _trace()
    update(trace)
    if loose:
        stats.merge_loose(trace)


def note_retry() -> None:
    _note(lambda trace: setattr(trace, "retries", trace.retries + 1))


def note_too_many() -> None:
    _note(lambda trace: setattr(trace, "too_many", trace.too_many + 1))


def note_address_refused() -> None:
    _note(lambda trace: setattr(trace, "address_refused", True))


def note_wait(seconds: float) -> None:
    if seconds > 0:
        _note(lambda trace: setattr(trace, "wait_s", trace.wait_s + seconds))


def note_transport_error(error: BaseException) -> None:
    """One attempt that ended in a transport exception (a timeout, a refused
    connection): its class name only, never its message."""
    name = type(error).__name__
    _note(lambda trace: trace.transport_errors.update((name,)))


def note_contacted(url: str) -> None:
    _note(lambda trace: trace.hosts.add(_host(url)))


def note_robots_unreachable(url: str) -> None:
    _note(lambda trace: trace.robots_unreachable.add(_host(url)))


def record_fetch(
    url: str,
    purpose: policy.FetchPurpose,
    *,
    outcome: str,
    status: int | None,
    from_cache: bool,
    override: str | None,
    trace: FetchTrace | None,
) -> None:
    """One logical fetch's result, under its host class."""
    stats = _current
    if stats is None:
        return
    stats.record(
        host_class(url, purpose, register=stats.register),
        outcome=outcome,
        status=status,
        from_cache=from_cache,
        override=override,
        trace=trace,
    )


def count(name: str, amount: int = 1) -> None:
    """Add to one of `EXTRA_COUNTERS` for the active stage."""
    stats = _current
    if stats is not None:
        stats.count(name, amount)


__all__ = [
    "CLASS_COUNTERS",
    "EXTRA_COUNTERS",
    "HOST_CLASSES",
    "REGISTER_PHASES",
    "FetchTrace",
    "StageStats",
    "activate",
    "count",
    "current",
    "fetch_trace",
    "host_class",
    "note_address_refused",
    "note_contacted",
    "note_retry",
    "note_robots_unreachable",
    "note_too_many",
    "note_transport_error",
    "note_wait",
    "record_fetch",
]
