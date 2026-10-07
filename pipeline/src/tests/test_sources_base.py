"""The polite client: robots, per-host pacing, retries, cache, negative evidence."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import respx

from camsocs_pipeline.sources.base import (
    INITIAL_BACKOFF,
    HostGates,
    PoliteClient,
)

UA = "camsocs-test/0.1 (+https://example.org/camsocs)"


class FakeClock:
    """Monotonic clock + sleep that advance together, recording every sleep."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_client(tmp_path: Path, clock: FakeClock | None = None, **kwargs) -> PoliteClient:
    clock = clock or FakeClock()
    return PoliteClient(
        user_agent=UA,
        cache_dir=tmp_path / "cache",
        gates=HostGates(),
        clock=clock.clock,
        sleep=clock.sleep,
        **kwargs,
    )


def allow_all(net: respx.MockRouter, origin: str) -> None:
    net.get(f"{origin}/robots.txt").respond(404)


# --- robots.txt ---------------------------------------------------------------


def test_a_disallowed_path_is_never_requested(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://soc.example/robots.txt").respond(
        200, text="User-agent: camsocs-test\nDisallow: /private\n"
    )
    page = net.get("https://soc.example/private/members").respond(200, text="secret")

    result = make_client(tmp_path).fetch("https://soc.example/private/members")

    assert result.outcome == "disallowed_by_robots"
    assert result.content is None
    assert not page.called


def test_rules_for_other_crawlers_do_not_apply_to_us(tmp_path: Path, net) -> None:
    net.get("https://soc.example/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    net.get("https://soc.example/").respond(200, text="<h1>Chess</h1>")

    assert make_client(tmp_path).fetch("https://soc.example/").outcome == "fetched"


def test_a_wildcard_disallow_applies_to_us(tmp_path: Path, net) -> None:
    net.get("https://talks.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    page = net.get("https://talks.example/talk/1").respond(200)

    assert make_client(tmp_path).fetch("https://talks.example/talk/1").outcome == (
        "disallowed_by_robots"
    )
    assert not page.called


@pytest.mark.parametrize("status", [401, 403, 500, 503])
def test_an_unreadable_robots_txt_means_disallow(tmp_path: Path, net, status: int) -> None:
    net.get("https://soc.example/robots.txt").respond(status)
    page = net.get("https://soc.example/").respond(200)

    result = make_client(tmp_path, max_retries=0).fetch("https://soc.example/")

    assert result.outcome == "disallowed_by_robots"
    assert "robots.txt" in (result.detail or "")
    assert not page.called


def test_robots_is_fetched_once_per_host(tmp_path: Path, net) -> None:
    robots = net.get("https://soc.example/robots.txt").respond(404)
    net.get("https://soc.example/a").respond(200, text="a")
    net.get("https://soc.example/b").respond(200, text="b")

    client = make_client(tmp_path)
    client.fetch("https://soc.example/a")
    client.fetch("https://soc.example/b")

    assert robots.call_count == 1


def test_requests_carry_our_user_agent_and_no_cookies(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    page = net.get("https://soc.example/").respond(200, text="x", headers={"Set-Cookie": "a=b"})

    client = make_client(tmp_path)
    client.fetch("https://soc.example/")
    client.fetch("https://soc.example/")

    for call in page.calls:
        assert call.request.headers["User-Agent"] == UA
        assert "cookie" not in call.request.headers


# --- pacing -------------------------------------------------------------------


def test_crawl_delay_sets_the_interval_for_that_host(tmp_path: Path, net) -> None:
    net.get("https://talks.example/robots.txt").respond(
        200, text="User-agent: *\nCrawl-delay: 10\nAllow: /\n"
    )
    net.get("https://talks.example/a").respond(200, text="a")
    net.get("https://talks.example/b").respond(200, text="b")
    clock = FakeClock()

    client = make_client(tmp_path, clock, min_interval=1.0)
    client.fetch("https://talks.example/a")
    client.fetch("https://talks.example/b")

    # robots.txt itself goes first (nothing to wait for); once its Crawl-delay is
    # known, every later request to the host waits the full 10 s.
    assert clock.sleeps == [pytest.approx(10.0), pytest.approx(10.0)]


def test_requests_to_one_host_are_spaced(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/a").respond(200, text="a")
    net.get("https://soc.example/b").respond(200, text="b")
    clock = FakeClock()

    client = make_client(tmp_path, clock, min_interval=2.0)
    client.fetch("https://soc.example/a")
    client.fetch("https://soc.example/b")

    assert clock.sleeps == [pytest.approx(2.0), pytest.approx(2.0)]


def test_different_hosts_do_not_wait_for_each_other(tmp_path: Path, net) -> None:
    for origin in ("https://one.example", "https://two.example"):
        allow_all(net, origin)
        net.get(f"{origin}/").respond(200, text=origin)
    clock = FakeClock()

    client = make_client(tmp_path, clock, min_interval=5.0)
    client.fetch("https://one.example/")
    sleeps_after_first_host = list(clock.sleeps)
    client.fetch("https://two.example/")

    # The second host only paid its own robots → page interval, nothing for host one.
    assert clock.sleeps[len(sleeps_after_first_host) :] == [pytest.approx(5.0)]


def test_at_most_one_request_in_flight_per_host(tmp_path: Path, net) -> None:
    """Real threads, real time: same-host requests serialise, other hosts overlap."""
    lock = threading.Lock()
    active: dict[str, int] = {}
    peak: dict[str, int] = {}

    def slow(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        with lock:
            active[host] = active.get(host, 0) + 1
            peak[host] = max(peak.get(host, 0), active[host])
        time.sleep(0.05)
        with lock:
            active[host] -= 1
        return httpx.Response(200, text="ok")

    for origin in ("https://one.example", "https://two.example"):
        allow_all(net, origin)
        net.get(url__regex=rf"^{origin}/page/\d+$").mock(side_effect=slow)

    client = PoliteClient(
        user_agent=UA, cache_dir=tmp_path / "cache", gates=HostGates(), min_interval=0.0
    )
    urls = [f"https://{h}.example/page/{i}" for h in ("one", "two") for i in range(4)]
    threads = [threading.Thread(target=client.fetch, args=(url,)) for url in urls]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert peak == {"one.example": 1, "two.example": 1}


# --- retries ------------------------------------------------------------------


def test_retry_after_is_honoured(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "7"}),
            httpx.Response(200, text="back"),
        ]
    )
    clock = FakeClock()

    result = make_client(tmp_path, clock, min_interval=0.0).fetch("https://soc.example/")

    assert result.outcome == "fetched"
    assert 7.0 in clock.sleeps


def test_transient_failures_back_off_then_give_up(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    page = net.get("https://soc.example/").respond(503)
    clock = FakeClock()

    result = make_client(tmp_path, clock, min_interval=0.0, max_retries=2).fetch(
        "https://soc.example/"
    )

    assert result.outcome == "unreachable"
    assert page.call_count == 3
    backoffs = [s for s in clock.sleeps if s >= INITIAL_BACKOFF * 0.8]
    assert len(backoffs) == 2
    assert INITIAL_BACKOFF * 0.8 <= backoffs[0] <= INITIAL_BACKOFF * 1.2
    assert INITIAL_BACKOFF * 1.6 <= backoffs[1] <= INITIAL_BACKOFF * 2.4


def test_connection_errors_are_retried(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/").mock(
        side_effect=[httpx.ConnectError("reset"), httpx.Response(200, text="ok")]
    )

    result = make_client(tmp_path, min_interval=0.0).fetch("https://soc.example/")

    assert result.outcome == "fetched"


# --- outcomes -----------------------------------------------------------------


def test_404_is_negative_evidence_not_an_error(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    page = net.get("https://soc.example/gone").respond(404)

    client = make_client(tmp_path)
    result = client.fetch("https://soc.example/gone")

    assert result.outcome == "not_found"
    assert result.status == 404
    assert not result.ok
    assert page.call_count == 1, "a 404 is an answer, not something to retry"
    _body, meta = client.cache_paths("https://soc.example/gone")
    assert meta.with_suffix(".last-failure.json").exists()


@pytest.mark.parametrize("status", [401, 403])
def test_access_walls_are_recorded_and_not_retried(tmp_path: Path, net, status: int) -> None:
    allow_all(net, "https://soc.example")
    page = net.get("https://soc.example/members").respond(status)

    result = make_client(tmp_path).fetch("https://soc.example/members")

    assert result.outcome == "access_restricted"
    assert page.call_count == 1
    assert "authorization" not in page.calls[0].request.headers


def test_redirects_are_followed_and_checked_against_the_new_host(tmp_path: Path, net) -> None:
    allow_all(net, "https://old.example")
    net.get("https://new.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    net.get("https://old.example/").respond(301, headers={"Location": "https://new.example/"})
    target = net.get("https://new.example/").respond(200)

    result = make_client(tmp_path).fetch("https://old.example/")

    assert result.outcome == "disallowed_by_robots"
    assert result.final_url == "https://new.example/"
    assert not target.called


def test_a_followed_redirect_reports_the_final_url(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/old").respond(302, headers={"Location": "/new"})
    net.get("https://soc.example/new").respond(200, text="moved")

    result = make_client(tmp_path).fetch("https://soc.example/old")

    assert result.outcome == "fetched"
    assert result.final_url == "https://soc.example/new"
    assert result.text == "moved"


def test_a_redirect_into_raven_is_not_followed(tmp_path: Path, net) -> None:
    allow_all(net, "http://amnesty.soc.example")
    net.get("http://amnesty.soc.example/").respond(
        302, headers={"Location": "https://raven.cam.ac.uk/auth/authenticate.html?ver=3"}
    )
    raven = net.get(url__startswith="https://raven.cam.ac.uk/").respond(200)

    result = make_client(tmp_path).fetch("http://amnesty.soc.example/")

    assert result.outcome == "access_restricted"
    assert "raven.cam.ac.uk" in (result.detail or "")
    assert not raven.called


def test_a_redirect_into_a_wls_login_is_not_followed(tmp_path: Path, net) -> None:
    allow_all(net, "http://soc.example")
    net.get("http://soc.example/").respond(
        302, headers={"Location": "https://nevar.example/wls/authenticate?ver=3&url=x"}
    )
    login = net.get(url__startswith="https://nevar.example/").respond(200)

    result = make_client(tmp_path).fetch("http://soc.example/")

    assert result.outcome == "access_restricted"
    assert not login.called


def test_ai_input_follows_robots_ai_blocks_and_content_signals(tmp_path: Path, net) -> None:
    net.get("https://open.example/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    net.get("https://noai.example/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    net.get("https://signal.example/robots.txt").respond(
        200, text="User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /\n"
    )
    net.get("https://none.example/robots.txt").respond(404)
    client = make_client(tmp_path)
    assert client.ai_input_allowed("https://open.example/about")
    assert not client.ai_input_allowed("https://noai.example/")
    assert not client.ai_input_allowed("https://signal.example/")
    assert client.ai_input_allowed("https://none.example/")


def test_non_http_urls_are_refused(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        make_client(tmp_path).fetch("file:///etc/passwd")


# --- cache --------------------------------------------------------------------


def test_cache_stores_body_and_sha256(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/").respond(200, text="hello")

    client = make_client(tmp_path)
    result = client.fetch("https://soc.example/")

    body_path, meta_path = client.cache_paths("https://soc.example/")
    assert body_path.read_bytes() == b"hello"
    assert body_path.parent.name == "soc.example"
    assert result.content_sha256 == (
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )
    assert meta_path.exists()


def test_a_304_is_unchanged_and_served_from_cache(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    route = net.get("https://soc.example/").mock(
        side_effect=[
            httpx.Response(200, text="v1", headers={"ETag": '"abc"'}),
            httpx.Response(304),
        ]
    )

    client = make_client(tmp_path)
    client.fetch("https://soc.example/")
    second = client.fetch("https://soc.example/")

    assert route.calls[1].request.headers["If-None-Match"] == '"abc"'
    assert second.outcome == "unchanged"
    assert second.from_cache
    assert second.content == b"v1"


def test_identical_content_is_unchanged_and_new_content_is_fetched(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/").mock(
        side_effect=[
            httpx.Response(200, text="same"),
            httpx.Response(200, text="same"),
            httpx.Response(200, text="different"),
        ]
    )

    client = make_client(tmp_path)
    outcomes = [client.fetch("https://soc.example/").outcome for _ in range(3)]

    assert outcomes == ["fetched", "unchanged", "fetched"]


def test_fresh_for_skips_the_network(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    route = net.get("https://soc.example/").respond(200, text="cached")
    now = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)

    client = make_client(tmp_path, now=lambda: now)
    client.fetch("https://soc.example/")
    again = client.fetch("https://soc.example/", fresh_for=timedelta(days=30))

    assert route.call_count == 1
    assert again.outcome == "unchanged"
    assert again.content == b"cached"


def test_cached_replays_without_the_network(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    route = net.get("https://soc.example/").respond(200, text="cached")

    client = make_client(tmp_path)
    assert client.cached("https://soc.example/") is None
    client.fetch("https://soc.example/")
    replay = make_client(tmp_path).cached("https://soc.example/")

    assert route.call_count == 1
    assert replay is not None
    assert (replay.outcome, replay.content, replay.from_cache) == ("unchanged", b"cached", True)


def test_a_failed_fetch_is_never_replayed_as_content(tmp_path: Path, net) -> None:
    allow_all(net, "https://soc.example")
    net.get("https://soc.example/gone").respond(404)

    client = make_client(tmp_path)
    client.fetch("https://soc.example/gone")

    assert client.cached("https://soc.example/gone") is None


def test_allows_checks_robots_without_requesting_the_url(tmp_path: Path, net) -> None:
    net.get("https://su.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /asset/\n")
    asset = net.get("https://su.example/asset/logo.png").respond(200, content=b"png")

    client = make_client(tmp_path)

    assert client.allows("https://su.example/asset/logo.png") is False
    assert client.allows("https://su.example/organisation/1/") is True
    assert not asset.called
