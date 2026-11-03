"""IndexNow pings after a load (`camsocs_pipeline.indexnow`, SEO audit G15):
which pages count as public and changed, that only pages the site's sitemaps
list go out (so no /talks URL or talks.cam content ever does), and that a
failed ping or sitemap read is retried and never fatal. Offline: the network
is respx (conftest) or an injected fetcher, and every claim is synthetic."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
import respx

from camsocs_pipeline import indexnow
from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.indexnow import (
    ENDPOINT,
    INDEXNOW_KEY,
    SITEMAP_FILES,
    changed_paths,
    page_digests,
    ping_changed,
    site_origin,
    sitemap_paths,
    state_path_for,
)
from camsocs_pipeline.models.wire import ClaimInput

NOW = 1_793_000_000_000  # 2026-10-26, in epoch ms
DAY = 24 * 60 * 60 * 1000
SITE = "https://camsocs.example"
UA = "camsocs-test/0.1 (+https://example.org/camsocs)"


def claim(
    entity_type: str,
    key: str,
    field: str,
    value: Any,
    *,
    source_type: str = "ics_feed",
    source_url: str = "https://chess.example/calendar.ics",
    retrieved_at: int = NOW,
) -> ClaimInput:
    return ClaimInput(
        entity_type=entity_type,
        entity_key=key,
        field=field,
        value=value,
        evidence="primary",
        method="parser",
        extractor="test",
        source_key="src-test",
        source_url=source_url,
        source_type=source_type,
        retrieved_at=retrieved_at,
    )


def event(
    key: str, *, visibility: str = "public", starts: int = NOW + DAY, source: str = "ics", **kw
) -> list[ClaimInput]:
    return [
        claim("event", key, "title", "Open chess night", **kw),
        claim("event", key, "visibility", visibility, **kw),
        claim("event", key, "startsAt", starts, **kw),
        claim("event", key, "source", source, **kw),
    ]


def society(key: str = "org-chess-club", name: str = "Chess Club") -> list[ClaimInput]:
    return [claim("organisation", key, "name", name, source_type="su_profile")]


def sitemap(*paths: str) -> str:
    """A `<urlset>` as `webapp/lib/sitemap.ts` writes it, for `paths`."""
    urls = "\n".join(f"<url><loc>{SITE}{path}</loc></url>" for path in paths)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}\n</urlset>\n"
    )


def listing(*paths: str):
    """A fetcher whose sitemaps list `paths` (societies and events split as
    the site splits them), recording each URL it is asked for."""
    asked: list[str] = []

    def fetch(url: str) -> str:
        asked.append(url)
        file = urlsplit(url).path.rsplit("/", 1)[-1]
        prefix = "/societies/" if file == "societies.xml" else "/events/"
        return sitemap(*(path for path in paths if path.startswith(prefix)))

    fetch.asked = asked  # type: ignore[attr-defined]
    return fetch


def mock_sitemaps(net: respx.MockRouter, *paths: str) -> None:
    """The sitemaps as served, only when asked for past the edge cache (any
    run time: the load stage reads the clock)."""
    for name in SITEMAP_FILES:
        prefix = "/societies/" if name == "societies.xml" else "/events/"
        net.get(url__startswith=f"{SITE}/sitemaps/{name}?fresh=").respond(
            200, text=sitemap(*(p for p in paths if p.startswith(prefix)))
        )


class TestWhichPages:
    def test_societies_and_public_events_become_their_pages(self) -> None:
        digests = page_digests([*society(), *event("evt-1")], now_ms=NOW)
        assert sorted(digests) == ["/events/evt-1", "/societies/chess-club"]

    def test_restricted_events_are_left_out(self) -> None:
        claims = [
            *event("evt-cam", visibility="cam_only"),
            *event("evt-members", visibility="members_only"),
            # One stricter reading among public ones: the server keeps the strictest.
            *event("evt-mixed"),
            claim("event", "evt-mixed", "visibility", "cam_only", source_type="mailing_list_email"),
            # No visibility reading at all: not known to be public.
            claim("event", "evt-unknown", "title", "Something"),
        ]
        assert page_digests(claims, now_ms=NOW) == {}

    def test_talks_derived_events_never_leave_the_talks_prefix(self) -> None:
        claims = [
            *event(
                "evt-a",
                source="talks_cam",
                source_type="talks_list",
                source_url="https://talks.cam.ac.uk/talk/index/1",
            ),
            # Read from a talks.cam list, whatever its URL says.
            *event("evt-f", source_type="talks_list"),
            # A society event read elsewhere whose page is a talks.cam one.
            *event("evt-b"),
            claim("event", "evt-b", "sourceUrl", "https://talks.cam.ac.uk/talk/index/2"),
            # One whose external page or reading's page is on talks.cam.
            *event("evt-c"),
            claim("event", "evt-c", "externalUrl", "http://www.talks.cam.ac.uk/talk/index/3"),
            *event("evt-d", source_url="https://talks.cam.ac.uk/show/index/4"),
            # The source field alone says talks.cam.
            *event("evt-e"),
            claim("event", "evt-e", "source", "talks_cam"),
            # A description that links a talk (Convex sends it to /talks).
            *event("evt-g"),
            claim("event", "evt-g", "description", "Details at TALKS.cam.ac.uk/talk/index/5."),
        ]
        assert page_digests(claims, now_ms=NOW) == {}

    def test_a_description_without_a_talks_link_is_no_talks_event(self) -> None:
        claims = [
            *event("evt-1"),
            claim("event", "evt-1", "description", "Bring a board; talks.cam.ac.ukx is not it."),
        ]
        assert sorted(page_digests(claims, now_ms=NOW)) == ["/events/evt-1"]

    def test_only_events_the_sitemap_lists_by_their_times_are_candidates(self) -> None:
        # Review of the SEO audit 2026-11-02 (indexnow-past-events-never-listed):
        # the events sitemap lists events from London midnight today on, and
        # multi-day ones still running, so an ended one would count as changed,
        # unlisted, on every daily run. NOW is 07:33 on 26 Oct, London (GMT).
        hours = DAY // 24
        claims = [
            *event("evt-old", starts=NOW - 40 * DAY),
            *event("evt-yesterday", starts=NOW - DAY),
            *event("evt-late-last-night", starts=NOW - 8 * hours),
            claim("event", "evt-late-last-night", "endsAt", NOW - 7 * hours),
            # Over midnight but one night only: the sitemap does not list it.
            *event("evt-overnight", starts=NOW - 9 * hours),
            claim("event", "evt-overnight", "endsAt", NOW + hours),
            *event("evt-this-morning", starts=NOW - 2 * hours),
            *event("evt-running", starts=NOW - 3 * DAY),
            claim("event", "evt-running", "endsAt", NOW + DAY),
            *event("evt-tomorrow", starts=NOW + DAY),
        ]
        assert sorted(page_digests(claims, now_ms=NOW)) == [
            "/events/evt-running",
            "/events/evt-this-morning",
            "/events/evt-tomorrow",
        ]

    def test_an_event_that_ended_yesterday_is_never_pinged_or_held(self, tmp_path: Path) -> None:
        def post(_url: str, body: dict[str, Any]) -> int:
            assert body["urlList"] == [f"{SITE}/societies/chess-club"]
            return 200

        result = ping_changed(
            [*society(), *event("evt-yesterday", starts=NOW - DAY)],
            site_url=SITE,
            state_path=tmp_path / "s.json",
            user_agent=UA,
            post=post,
            fetch=listing("/societies/chess-club"),
            now_ms=NOW,
        )
        assert result.note == "IndexNow: pinged 1 changed pages"

    def test_teams_sessions_and_venues_have_no_page_of_their_own(self) -> None:
        claims = [
            claim("team", "team-chess-club--a", "name", "A team"),
            claim("session", "ses-1", "title", "Club night"),
            claim("venue", "ven-hall", "name", "Hall"),
        ]
        assert page_digests(claims, now_ms=NOW) == {}

    def test_no_url_is_ever_under_talks(self) -> None:
        claims = [*society(), *event("evt-1"), *event("evt-2", source="talks_cam")]
        assert not any(path.startswith("/talks") for path in page_digests(claims, now_ms=NOW))


class TestWhatChanged:
    def test_a_new_retrieval_of_the_same_values_is_no_change(self) -> None:
        first = page_digests(society(), now_ms=NOW)
        again = [c.model_copy(update={"retrieved_at": NOW + DAY}) for c in society()]
        assert changed_paths(page_digests(again, now_ms=NOW), first) == []

    def test_a_changed_value_or_a_new_page_is_a_change(self) -> None:
        before = page_digests(society(), now_ms=NOW)
        after = page_digests(
            [*society(name="Chess Club (renamed)"), *society("org-go", "Go Society")], now_ms=NOW
        )
        assert changed_paths(after, before) == ["/societies/chess-club", "/societies/go"]


class TestSitemapPaths:
    def test_the_paths_of_every_loc(self) -> None:
        body = sitemap("/societies/chess-club", "/events/evt-1").replace(
            "evt-1", "evt-1?a=1&amp;b=2"
        )
        assert sitemap_paths(body) == {"/societies/chess-club", "/events/evt-1"}

    def test_a_body_that_is_not_xml_raises(self) -> None:
        import xml.etree.ElementTree as ET

        import pytest

        with pytest.raises(ET.ParseError):
            sitemap_paths("<html><body>Service unavailable")


class TestSiteOrigin:
    def test_only_a_bare_https_origin_counts(self) -> None:
        assert site_origin("https://camsocs.uk/") == "https://camsocs.uk"
        assert site_origin("http://camsocs.uk") is None
        assert site_origin("https://camsocs.uk/about") is None
        assert site_origin("camsocs.uk") is None


def test_the_key_file_the_site_serves_holds_the_key() -> None:
    key_file = REPO_ROOT / "webapp" / "public" / f"{INDEXNOW_KEY}.txt"
    assert key_file.read_text(encoding="utf-8").strip() == INDEXNOW_KEY
    assert len(INDEXNOW_KEY) == 32
    int(INDEXNOW_KEY, 16)


def test_the_digest_file_sits_beside_each_environments_state(tmp_path: Path) -> None:
    assert state_path_for(tmp_path / ".camsocs-state.prod.json") == (
        tmp_path / ".camsocs-state.prod.indexnow.json"
    )


class TestPing:
    def test_unconfigured_sends_nothing(self, tmp_path: Path, net: respx.MockRouter) -> None:
        result = ping_changed(
            society(), site_url="", state_path=tmp_path / "s.json", user_agent=UA, now_ms=NOW
        )
        assert "not configured" in result.note
        assert result.sent == 0
        assert not net.calls

    def test_a_dry_run_reports_and_sends_nothing(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        state = tmp_path / "s.json"
        result = ping_changed(
            society(), site_url=SITE, state_path=state, user_agent=UA, dry_run=True, now_ms=NOW
        )
        assert result.note == (
            "IndexNow: would ping up to 1 changed pages, those the sitemaps list (dry run)"
        )
        assert not net.calls
        assert not state.exists()

    def test_changed_pages_are_posted_once_and_remembered(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        route = net.post(ENDPOINT).mock(return_value=httpx.Response(202))
        mock_sitemaps(net, "/societies/chess-club", "/events/evt-1")
        state = tmp_path / "s.json"
        claims = [*society(), *event("evt-1"), *event("evt-t", source="talks_cam")]

        result = ping_changed(claims, site_url=SITE, state_path=state, user_agent=UA, now_ms=NOW)

        assert result.sent == 2
        body = json.loads(route.calls.last.request.content)
        assert body == {
            "host": "camsocs.example",
            "key": INDEXNOW_KEY,
            "keyLocation": f"{SITE}/{INDEXNOW_KEY}.txt",
            "urlList": [f"{SITE}/events/evt-1", f"{SITE}/societies/chess-club"],
        }
        assert route.calls.last.request.headers["user-agent"] == UA
        sitemap_get = next(call for call in net.calls if call.request.method == "GET")
        assert sitemap_get.request.headers["user-agent"] == UA
        # Nothing changed since: nothing is sent again.
        again = ping_changed(claims, site_url=SITE, state_path=state, user_agent=UA, now_ms=NOW)
        assert again.note == "IndexNow: no public page changed"
        assert route.call_count == 1

    def test_a_refused_ping_is_retried_by_the_next_run(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        route = net.post(ENDPOINT).mock(side_effect=[httpx.Response(429), httpx.Response(200)])
        state = tmp_path / "s.json"
        fetch = listing("/societies/chess-club")
        first = ping_changed(
            society(), site_url=SITE, state_path=state, user_agent=UA, fetch=fetch, now_ms=NOW
        )
        assert "refused (HTTP 429)" in first.note
        assert not state.exists()
        second = ping_changed(
            society(), site_url=SITE, state_path=state, user_agent=UA, fetch=fetch, now_ms=NOW
        )
        assert second.sent == 1
        assert route.call_count == 2

    def test_a_network_failure_is_a_note_not_an_error(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        net.post(ENDPOINT).mock(side_effect=httpx.ConnectError("down"))
        result = ping_changed(
            society(),
            site_url=SITE,
            state_path=tmp_path / "s.json",
            user_agent=UA,
            fetch=listing("/societies/chess-club"),
            now_ms=NOW,
        )
        assert result.note == "IndexNow: ping failed (ConnectError); the next run retries"

    def test_large_change_sets_are_split_at_the_protocol_limit(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        monkeypatch.setattr(indexnow, "MAX_URLS", 2)
        sent: list[list[str]] = []

        def post(_url: str, body: dict[str, Any]) -> int:
            sent.append(body["urlList"])
            return 200

        claims = [c for n in range(5) for c in society(f"org-s{n}", f"S{n}")]
        result = ping_changed(
            claims,
            site_url=SITE,
            state_path=tmp_path / "s.json",
            user_agent=UA,
            post=post,
            fetch=listing(*(f"/societies/s{n}" for n in range(5))),
            now_ms=NOW,
        )
        assert result.sent == 5
        assert [len(chunk) for chunk in sent] == [2, 2, 1]


class TestSitemapsJudge:
    """Review of the SEO audit 2026-11-02 (indexnow-pipeline): the site's own
    sitemaps decide, so a thin, hidden or counterpart profile, or an event
    whose talks.cam provenance came in an earlier run, is never pinged."""

    def test_only_listed_pages_are_pinged_and_both_files_are_read(self, tmp_path: Path) -> None:
        sent: list[list[str]] = []

        def post(_url: str, body: dict[str, Any]) -> int:
            sent.append(body["urlList"])
            return 200

        fetch = listing("/societies/chess-club", "/events/evt-1", "/societies/other")
        claims = [
            *society(),
            # Thin (noindex, G3) or hidden: Convex leaves it out of the sitemap.
            *society("org-thin", "Thin Society"),
            *event("evt-1"),
            # Public by this run's claims, but talks.cam provenance is stored.
            *event("evt-earlier-talks"),
        ]
        result = ping_changed(
            claims,
            site_url=SITE,
            state_path=tmp_path / "s.json",
            user_agent=UA,
            post=post,
            fetch=fetch,
            now_ms=NOW,
        )
        assert sent == [[f"{SITE}/events/evt-1", f"{SITE}/societies/chess-club"]]
        assert result.sent == 2
        assert "2 not in the sitemaps, not sent" in result.note
        # Past the edge cache (indexnow-edge-cached-sitemap): Vercel keys on
        # the query string, so the run reads what Convex holds now.
        assert fetch.asked == [f"{SITE}/sitemaps/{name}?fresh={NOW}" for name in SITEMAP_FILES]

    def test_an_unlisted_page_keeps_its_old_digest_and_goes_once_listed(
        self, tmp_path: Path
    ) -> None:
        sent: list[list[str]] = []

        def post(_url: str, body: dict[str, Any]) -> int:
            sent.append(body["urlList"])
            return 200

        state = tmp_path / "s.json"
        claims = [*society(), *event("evt-new")]
        kw: dict[str, Any] = {"site_url": SITE, "state_path": state, "user_agent": UA}
        ping_changed(claims, post=post, fetch=listing("/societies/chess-club"), now_ms=NOW, **kw)
        assert sent == [[f"{SITE}/societies/chess-club"]]
        assert "/events/evt-new" not in json.loads(state.read_text())["pages"]
        # The sitemap lists the event now, and it goes once.
        ping_changed(
            claims,
            post=post,
            fetch=listing("/societies/chess-club", "/events/evt-new"),
            now_ms=NOW,
            **kw,
        )
        assert sent[-1] == [f"{SITE}/events/evt-new"]
        again = ping_changed(
            claims,
            post=post,
            fetch=listing("/societies/chess-club", "/events/evt-new"),
            now_ms=NOW,
            **kw,
        )
        assert again.note == "IndexNow: no public page changed"

    def test_nothing_listed_sends_nothing(self, tmp_path: Path) -> None:
        def post(_url: str, _body: dict[str, Any]) -> int:
            raise AssertionError("nothing to send")

        state = tmp_path / "s.json"
        result = ping_changed(
            society(),
            site_url=SITE,
            state_path=state,
            user_agent=UA,
            post=post,
            fetch=listing(),
            now_ms=NOW,
        )
        assert result.note == "IndexNow: 1 changed pages, none in the sitemaps yet; nothing sent"
        assert not state.exists()

    def test_an_unreadable_sitemap_sends_nothing_and_moves_no_digest(
        self, tmp_path: Path, net: respx.MockRouter
    ) -> None:
        ping = net.post(ENDPOINT).mock(return_value=httpx.Response(200))
        fresh = {"fresh": str(NOW)}
        net.get(f"{SITE}/sitemaps/societies.xml", params=fresh).respond(
            200, text=sitemap("/societies/chess-club")
        )
        # The route's backend failure: a 503, never a partial file.
        net.get(f"{SITE}/sitemaps/events.xml", params=fresh).respond(503, text="Unavailable")
        state = tmp_path / "s.json"
        result = ping_changed(society(), site_url=SITE, state_path=state, user_agent=UA, now_ms=NOW)
        assert result.note == (
            "IndexNow: sitemaps unavailable (HTTPStatusError), nothing sent; the next run retries"
        )
        assert result.sent == 0
        assert not ping.called
        assert not state.exists()

    def test_a_sitemap_that_is_not_xml_or_a_failing_fetcher_sends_nothing(
        self, tmp_path: Path
    ) -> None:
        def post(_url: str, _body: dict[str, Any]) -> int:
            raise AssertionError("nothing to send")

        def broken(_url: str) -> str:
            return "<html>maintenance"

        def down(_url: str) -> str:
            raise httpx.ConnectError("down")

        for fetch, name in ((broken, "ParseError"), (down, "ConnectError")):
            result = ping_changed(
                society(),
                site_url=SITE,
                state_path=tmp_path / "s.json",
                user_agent=UA,
                post=post,
                fetch=fetch,
                now_ms=NOW,
            )
            assert result.note.startswith(f"IndexNow: sitemaps unavailable ({name})")
            assert not (tmp_path / "s.json").exists()


def test_the_load_stage_pings_what_it_posted(make_settings, net: respx.MockRouter) -> None:
    """The one hook: `stages.load` hands what it posted to the ping, with the
    run's settings, and notes the outcome."""
    from datetime import UTC, datetime

    from camsocs_pipeline.claims import parser_field
    from camsocs_pipeline.models.observation import FetchInfo, IdentityHints, Observation
    from camsocs_pipeline.pipeline.context import StageContext
    from camsocs_pipeline.pipeline.load import ConvexLoader
    from camsocs_pipeline.pipeline.report import RunReport
    from camsocs_pipeline.pipeline.state import SyncState
    from camsocs_pipeline.stages import load as load_stage
    from camsocs_pipeline.staging.store import StagingStore

    convex = "https://happy-otter-123.convex.site"
    net.post(f"{convex}/api/pipeline/suppressions").respond(200, json={})
    net.post(f"{convex}/api/pipeline/sources").respond(200, json={"inserted": 1})
    net.post(f"{convex}/api/pipeline/claims").respond(200, json={"inserted": 1})
    ping = net.post(ENDPOINT).mock(return_value=httpx.Response(200))
    mock_sitemaps(net, "/societies/chess-club")

    settings = make_settings(indexnow_site_url=SITE)
    staging = StagingStore(settings.staging_dir)
    run = RunReport(run_key="20261026T120000Z-abcdef", command="sync", dry_run=False)
    staging.write(
        "society_website",
        run.run_key,
        [
            Observation(
                source_type="society_website",
                source_key="https://chess.example/",
                source_url="https://chess.example/",
                retrieved_at=datetime(2026, 10, 26, 12, 0, tzinfo=UTC),
                fetch=FetchInfo(http_status=200),
                entity_type="organisation",
                identity=IdentityHints(name="Chess Club"),
                entity_key="org-chess-club",
                fields=[parser_field("name", "Chess Club", extractor="h1", evidence="primary")],
            )
        ],
    )
    ctx = StageContext(
        settings=settings,
        report=run.stage("load"),
        run=run,
        loader=ConvexLoader(convex, "k", max_retries=1),
        state=SyncState(),
        staging=staging,
        dry_run=False,
        limit=None,
    )

    load_stage.run(ctx)

    assert json.loads(ping.calls.last.request.content)["urlList"] == [
        f"{SITE}/societies/chess-club"
    ]
    assert "IndexNow: pinged 1 changed pages" in ctx.report.notes
    assert ctx.report.metrics["indexNowPinged"] == 1
    assert state_path_for(settings.state_path).exists()
