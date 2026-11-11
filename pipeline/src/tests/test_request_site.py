"""The request agent's site check (ENG-158, `request_site.py`): the site a
listing request points to, read as the scraper will read it, and what ties
it to the listing. Fictional data."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx

from camsocs_pipeline import request_site
from camsocs_pipeline.extract.memo import LLMMemo
from camsocs_pipeline.request_site import check_site, run_site_checks, tied_by
from camsocs_pipeline.sources.websites.page import parse_page
from tests.fakes import FakeLLM
from tests.test_website_events import HOME, KEY, NOW, REPLY, SITE, client, serve

CHECK = {
    "key": "lr-0123456789abcdef0123",
    "orgKey": KEY,
    "name": "Cambridge University Quokka Appreciation Society",
    "aliases": [],
    "website": f"{SITE}/",
    "eventsUrl": f"{SITE}/events",
    "socials": ["https://www.instagram.com/cuquokkas/"],
}
LINKED = HOME.replace(
    "</main>", '<footer><a href="https://instagram.com/cuquokkas">Instagram</a></footer></main>'
)


class FakeLoader:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, payload))
        return {"ok": True}


def test_a_site_is_tied_to_the_listing_by_an_account_it_links() -> None:
    page = parse_page(f"{SITE}/", LINKED)
    assert tied_by(page, CHECK["socials"]) == "links the listing's instagram.com account"
    assert tied_by(page, ["https://www.instagram.com/someoneelse/"]) is None
    # A network's front page is not an account.
    front = parse_page(
        f"{SITE}/", HOME.replace("</main>", '<a href="https://instagram.com/">x</a>')
    )
    assert tied_by(front, ["https://www.instagram.com/"]) is None
    assert tied_by(parse_page(f"{SITE}/", HOME), []) is None


def test_a_check_reports_the_tie_and_the_events_the_reader_finds(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    serve(net)
    net.get(f"{SITE}/").respond(200, text=LINKED, headers={"content-type": "text/html"})
    fake = FakeLLM(lambda _text, _tier: REPLY)
    with client(tmp_path) as http:
        found = check_site(
            CHECK,
            http,
            llm=fake,  # type: ignore[arg-type]
            memo=LLMMemo(tmp_path / "llm"),
            now=NOW,
        )
    assert found["ok"] is True and found["key"] == CHECK["key"]
    assert found["website"] == f"{SITE}/"
    assert (found["ownSite"], found["tiedBy"]) == (
        True,
        "links the listing's instagram.com account",
    )
    assert [event["title"] for event in found["events"]] == ["Quokka Quiz", "Burrow building"]
    assert found["events"][0]["venue"] == "The Old Library"
    assert found["eventCount"] == 2 and found["pages"] == 1


def test_a_host_never_read_as_a_societys_site_is_refused(tmp_path: Path) -> None:
    with client(tmp_path) as http:
        for website in (
            "https://www.instagram.com/",
            "https://quokkas.example.org./",
            "https://quokkas.example.org:8443/",
        ):
            found = check_site({**CHECK, "website": website}, http, llm=None, memo=None, now=NOW)
            assert found["ok"] is False and "never read" in found["error"], website


def test_a_site_nothing_ties_to_the_listing_never_reaches_the_model(
    tmp_path: Path, net: respx.MockRouter
) -> None:
    """The request is a stranger's word: a site that neither links the
    listing's accounts nor names the society is not read further."""
    site = "https://widgets.example.com"
    net.get(f"{site}/robots.txt").respond(200, text="User-agent: *\nAllow: /\n")
    net.get(f"{site}/").respond(
        200,
        text="<html><head><title>Acme Widgets</title></head><body><main>"
        '<a href="/events">Events</a><p>We sell widgets.</p></main></body></html>',
        headers={"content-type": "text/html"},
    )
    fake = FakeLLM(lambda _text, _tier: REPLY)
    with client(tmp_path) as http:
        found = check_site(
            {**CHECK, "website": f"{site}/", "socials": []},
            http,
            llm=fake,  # type: ignore[arg-type]
            memo=LLMMemo(tmp_path / "llm"),
            now=NOW,
        )
    assert (found["ok"], found["ownSite"], found["events"]) == (True, False, [])
    assert "not shown to be the society's own site" in found["notes"][0]
    assert fake.calls == []


def test_robots_txt_holds_before_the_broker_confirms(tmp_path: Path, net: respx.MockRouter) -> None:
    net.get(f"{SITE}/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    net.get(f"{SITE}/").respond(200, text=LINKED, headers={"content-type": "text/html"})
    with client(tmp_path) as http:
        found = check_site(CHECK, http, llm=None, memo=None, now=NOW)
    assert found == {
        "key": CHECK["key"],
        "website": f"{SITE}/",
        "ok": False,
        "error": "disallowed_by_robots",
    }


def test_a_check_that_raises_is_posted_as_failed_by_class(
    make_settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("the page said something private")

    monkeypatch.setattr(request_site, "check_site", boom)
    loader = FakeLoader()
    counts = run_site_checks(loader, [CHECK], make_settings(), None, now=NOW)
    assert counts.line() == "1 sites offered, 0 read, 1 failed"
    assert loader.posts == [
        (
            "requests/check",
            {
                "key": CHECK["key"],
                "website": CHECK["website"],
                "ok": False,
                "error": "RuntimeError",
            },
        )
    ]
    assert (
        run_site_checks(loader, [], make_settings(), None).line()
        == "0 sites offered, 0 read, 0 failed"
    )
