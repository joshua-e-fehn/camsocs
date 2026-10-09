"""The fetch policy (decision D3): which robots.txt and AI opt-out signals a
fetch may override, as a pure matrix and through the polite client."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest
import respx

from camsocs_pipeline.sources.base import HostGates, PoliteClient
from camsocs_pipeline.sources.policy import (
    AI_OVERRIDE_NOTE,
    COLLEGE_SOCIETY_LIST,
    GENERAL,
    ROBOTS_OVERRIDE_NOTE,
    SOCIETY,
    SOCIETY_WEBSITE,
    FetchPurpose,
    ai_optout_override,
    is_general_host,
    never_fetched,
    robots_override,
    society_class,
    url_class_of,
)

UA = "camsocs-test/0.1 (+https://example.org/camsocs)"

SU_LOGO = "https://www.cambridgesu.co.uk/asset/Organisation/15759/logo.png"
LINKTREE = "https://linktr.ee/cuexamplesoc"
GOOGLE_ICS = (
    "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/public/basic.ics"
)
SOCIETY_SITE = "https://cuchess.example/join/"
JCR_SITE = "https://jcr.cai.cam.ac.uk/"
COLLEGE_LIST = "https://www.chu.cam.ac.uk/student-life/clubs-and-societies/"


# --- the pure matrix -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "general", "society", "website", "college_list"),
    [
        # Recognised from the URL: any society purpose may override.
        (SU_LOGO, None, "su_asset", "su_asset", "su_asset"),
        (LINKTREE, None, "linktree", "linktree", "linktree"),
        (GOOGLE_ICS, None, "google_calendar_feed", "google_calendar_feed", "google_calendar_feed"),
        # Declared by the caller: only that purpose overrides.
        (SOCIETY_SITE, None, None, "society_website", "college_society_list"),
        (JCR_SITE, None, None, "society_website", "college_society_list"),
        (COLLEGE_LIST, None, None, "society_website", "college_society_list"),
        # Other paths of the pattern hosts never stretch to a declared class.
        ("https://www.cambridgesu.co.uk/organisation/15759/", None, None, None, None),
        ("https://www.cambridgesu.co.uk/resourcehandler/1/", None, None, None, None),
        ("https://www.cambridgesu.co.uk/login/", None, None, None, None),
        ("https://calendar.google.com/calendar/embed?src=abc", None, None, None, None),
        ("https://linktr.ee/", None, None, None, None),
        # Never overridden.
        ("https://talks.cam.ac.uk/show/xml/201664", None, None, None, None),
        ("https://tbc.xyz/events", None, None, None, None),
        # Never fetched at all.
        ("https://webservices.admin.cam.ac.uk/events/api/x.ics", None, None, None, None),
        ("https://www.instagram.com/cuchess/", None, None, None, None),
        ("https://www.facebook.com/cuchess", None, None, None, None),
        ("https://www.linkedin.com/company/cuchess/", None, None, None, None),
        # Not a society's page: the University's own sites, search engines,
        # other networks and link shorteners.
        ("https://www.cam.ac.uk/colleges-and-departments/college-a-z", None, None, None, None),
        ("https://www.admin.cam.ac.uk/whatson/", None, None, None, None),
        ("https://www.sport.cam.ac.uk/university-sports-clubs-0/fencing", None, None, None, None),
        ("https://www.google.com/search?q=cu+chess", None, None, None, None),
        ("https://duckduckgo.com/?q=cu+chess", None, None, None, None),
        ("https://x.com/cuchess", None, None, None, None),
        ("https://www.youtube.com/@cuchess", None, None, None, None),
        ("https://bit.ly/cuchess", None, None, None, None),
    ],
)
def test_the_override_matrix(
    url: str,
    general: str | None,
    society: str | None,
    website: str | None,
    college_list: str | None,
) -> None:
    assert society_class(url, GENERAL) == general
    assert society_class(url, SOCIETY) == society
    assert society_class(url, SOCIETY_WEBSITE) == website
    assert society_class(url, COLLEGE_SOCIETY_LIST) == college_list
    for purpose in (GENERAL, SOCIETY, SOCIETY_WEBSITE, COLLEGE_SOCIETY_LIST):
        expected = society_class(url, purpose) is not None
        assert robots_override(url, purpose) is expected
        assert ai_optout_override(url, purpose) is expected


def test_url_classes_are_read_from_the_shape_of_the_url() -> None:
    assert url_class_of(SU_LOGO) == "su_asset"
    assert url_class_of("https://cambridgesu.co.uk/asset/Event/1/x.jpg") == "su_asset"
    assert url_class_of(LINKTREE) == "linktree"
    assert url_class_of(GOOGLE_ICS) == "google_calendar_feed"
    assert url_class_of("https://calendar.google.com/calendar/ical/x/private-abc/basic.ics") is None
    assert url_class_of(SOCIETY_SITE) is None


@pytest.mark.parametrize(
    "url",
    [
        "https://webservices.admin.cam.ac.uk/events/api/programmes/11/calendar/events.json",
        "https://instagram.com/p/abc/",
        "https://m.facebook.com/cuchess",
        "https://uk.linkedin.com/company/x",
        "https://lnkd.in/abc",
    ],
)
def test_some_hosts_are_never_fetched(url: str) -> None:
    assert never_fetched(url)


def test_cdn_hosts_of_the_official_meta_api_are_not_social_networks() -> None:
    # Images the Graph API returns are copied from Meta's CDN (§17).
    assert never_fetched("https://scontent-lhr8-1.cdninstagram.com/v/t51/1.jpg") is None
    assert never_fetched("https://scontent.fbcdn.net/v/1.jpg") is None


def test_a_purpose_is_well_formed() -> None:
    with pytest.raises(ValueError, match="only a society fetch"):
        FetchPurpose("general", "society_website")
    with pytest.raises(ValueError, match="unknown society URL class"):
        FetchPurpose("society", "anything")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="unknown fetch scope"):
        FetchPurpose("everything")  # type: ignore[arg-type]


# --- through the polite client ---------------------------------------------------------------


class FakeClock:
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
        max_retries=0,
        **kwargs,
    )


def test_a_society_site_is_read_despite_a_disallow_and_says_so(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://cuchess.example/robots.txt").respond(
        200, text="User-agent: *\nCrawl-delay: 5\nDisallow: /\n"
    )
    page = net.get(SOCIETY_SITE).respond(200, text="<h1>CU Chess</h1>")
    clock = FakeClock()
    client = make_client(tmp_path, clock)

    general = client.fetch(SOCIETY_SITE)
    assert general.outcome == "disallowed_by_robots"
    assert page.call_count == 0

    first = client.fetch(SOCIETY_SITE, purpose=SOCIETY_WEBSITE)
    second = client.fetch(SOCIETY_SITE, purpose=SOCIETY_WEBSITE)
    assert first.outcome == "fetched" and second.ok
    assert first.override == second.override == ROBOTS_OVERRIDE_NOTE
    assert page.call_count == 2
    # Crawl-delay still holds between the two requests to the host.
    assert any(wait >= 5 for wait in clock.sleeps)
    # The honest verdict stays "disallowed"; `allows` answers per purpose.
    assert client.robots_verdict(SOCIETY_SITE) == "disallowed"
    assert not client.allows(SOCIETY_SITE)
    assert client.allows(SOCIETY_SITE, SOCIETY_WEBSITE)


def test_an_override_never_crosses_a_login_wall_or_a_403(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    # Linktree's edge answers 403 even for robots.txt: the society purpose
    # tries the page once, and a 403 there is recorded, never worked around.
    net.get("https://linktr.ee/robots.txt").respond(403)
    profile = net.get(LINKTREE).respond(403)
    net.get("https://cuchess.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    net.get("https://cuchess.example/members/").respond(
        302, headers={"location": "https://raven.cam.ac.uk/auth/authenticate.html"}
    )
    client = make_client(tmp_path)

    linktree = client.fetch(LINKTREE, purpose=SOCIETY)
    members = client.fetch("https://cuchess.example/members/", purpose=SOCIETY_WEBSITE)

    assert linktree.outcome == "access_restricted" and linktree.status == 403
    assert linktree.override == ROBOTS_OVERRIDE_NOTE
    assert profile.call_count == 1
    assert members.outcome == "access_restricted"
    assert "login" in (members.detail or "")


def test_an_unreachable_robots_txt_is_not_overridden(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://down.example/robots.txt").respond(503)
    page = net.get("https://down.example/").respond(200, text="x")

    result = make_client(tmp_path).fetch("https://down.example/", purpose=SOCIETY_WEBSITE)

    assert result.outcome == "disallowed_by_robots"
    assert "robots.txt" in (result.detail or "")
    assert page.call_count == 0


def test_talks_cam_and_general_hosts_are_never_overridden(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://talks.cam.ac.uk/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    net.get("https://www.cam.ac.uk/robots.txt").respond(200, text="User-agent: *\nDisallow: /x\n")
    talk = net.get("https://talks.cam.ac.uk/show/xml/1")
    central = net.get("https://www.cam.ac.uk/x")
    client = make_client(tmp_path)

    assert client.fetch("https://talks.cam.ac.uk/show/xml/1", purpose=SOCIETY_WEBSITE).outcome == (
        "disallowed_by_robots"
    )
    assert client.fetch("https://www.cam.ac.uk/x", purpose=SOCIETY_WEBSITE).outcome == (
        "disallowed_by_robots"
    )
    assert talk.call_count == central.call_count == 0


def test_a_government_site_a_society_names_keeps_its_robots_txt(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    # The OTC's stated "website" is a page on army.mod.uk: published by the
    # government, not by a society, so D3 does not lift its robots.txt.
    army = "https://www.army.mod.uk/who-we-are/corps-regiments-and-units/uotc/"
    net.get("https://www.army.mod.uk/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    page = net.get(army)
    for url in (army, "https://www.gov.uk/x", "https://www.nhs.uk/x"):
        assert is_general_host(url)
        assert society_class(url, SOCIETY_WEBSITE) is None

    assert make_client(tmp_path).fetch(army, purpose=SOCIETY_WEBSITE).outcome == (
        "disallowed_by_robots"
    )
    assert page.call_count == 0


def test_never_fetched_hosts_are_refused_before_any_request(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    client = make_client(tmp_path)
    for url in (
        "https://webservices.admin.cam.ac.uk/events/api/programmes/11/calendar/events.ics",
        "https://www.instagram.com/cuchess/",
    ):
        for purpose in (GENERAL, SOCIETY, SOCIETY_WEBSITE):
            result = client.fetch(url, purpose=purpose)
            assert result.outcome == "disallowed_by_robots"
            assert not client.allows(url, purpose)
    assert not net.calls


def test_a_redirect_hop_is_checked_against_its_own_host(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    # A society's short link landing on a page of a general host: the override
    # covers the society's site, never the host it redirects to.
    net.get("https://cuchess.example/robots.txt").respond(404)
    net.get("https://cuchess.example/feed").respond(
        301, headers={"location": "https://www.cam.ac.uk/private/feed"}
    )
    net.get("https://www.cam.ac.uk/robots.txt").respond(
        200, text="User-agent: *\nDisallow: /private\n"
    )
    target = net.get("https://www.cam.ac.uk/private/feed")

    result = make_client(tmp_path).fetch("https://cuchess.example/feed", purpose=SOCIETY_WEBSITE)

    assert result.outcome == "disallowed_by_robots"
    assert result.final_url == "https://www.cam.ac.uk/private/feed"
    assert target.call_count == 0


def test_the_cache_never_launders_an_override(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://www.cambridgesu.co.uk/robots.txt").respond(
        200, text="User-agent: *\nDisallow: /asset/\n"
    )
    logo = net.get(SU_LOGO).respond(200, content=b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    client = make_client(tmp_path)

    copied = client.fetch(SU_LOGO, purpose=SOCIETY)
    assert copied.ok and copied.override == ROBOTS_OVERRIDE_NOTE

    fresh = timedelta(days=1)
    again = client.fetch(SU_LOGO, fresh_for=fresh, purpose=SOCIETY)
    assert again.from_cache and again.override == ROBOTS_OVERRIDE_NOTE
    assert logo.call_count == 1
    # A general fetch is refused even though the cache holds a fresh copy.
    assert client.fetch(SU_LOGO, fresh_for=fresh).outcome == "disallowed_by_robots"
    assert client.cached(SU_LOGO) is None
    replay = client.cached(SU_LOGO, purpose=SOCIETY)
    assert replay is not None and replay.override == ROBOTS_OVERRIDE_NOTE


def test_an_allowed_fetch_carries_no_override(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get("https://cuchess.example/robots.txt").respond(404)
    net.get(SOCIETY_SITE).respond(200, text="<h1>CU Chess</h1>")

    result = make_client(tmp_path).fetch(SOCIETY_SITE, purpose=SOCIETY_WEBSITE)

    assert result.outcome == "fetched" and result.override is None


def test_ai_opt_outs_are_lifted_for_society_pages_only(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    net.get("https://cuchess.example/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    )
    net.get("https://signal.example/robots.txt").respond(
        200, text="User-agent: *\nContent-Signal: ai-input=no\nAllow: /\n"
    )
    net.get("https://talks.cam.ac.uk/robots.txt").respond(
        200, text="User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 10\n"
    )
    client = make_client(tmp_path)

    assert not client.ai_input_allowed(SOCIETY_SITE)
    assert client.ai_input_allowed(SOCIETY_SITE, SOCIETY_WEBSITE)
    assert not client.ai_input_allowed("https://signal.example/")
    assert client.ai_input_allowed("https://signal.example/", SOCIETY_WEBSITE)
    # talks.cam never, whatever the purpose; an undeclared society purpose
    # does not stretch to a society website either.
    assert not client.ai_input_allowed("https://talks.cam.ac.uk/talk/1", SOCIETY_WEBSITE)
    assert not client.ai_input_allowed(SOCIETY_SITE, SOCIETY)


def test_override_notes_are_distinct() -> None:
    assert ROBOTS_OVERRIDE_NOTE == "robots_override:society"
    assert AI_OVERRIDE_NOTE == "ai_optout_override:society"
