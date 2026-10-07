"""Deterministic reading of society sites: page text, links, emails,
platform, page discovery, Linktree.

Fixtures (``fixtures/websites/``) are real pages recorded 2026-10-07 with
the polite client — a WordPress site (CUATS), a Squarespace site (Catz JCR)
and a Wix site (CUAC) — trimmed (scripts other than JSON-LD, styles and
inline SVG dropped) and with every committee member's name replaced by a
placeholder ("Sam Sample", "Alex Example"): fixtures carry no personal data.
The Linktree page is synthetic: Linktree's robots.txt answers our
User-Agent with 403, so its pages are never fetched (source-research §13).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from camsocs_pipeline.sources.websites.discover import choose_pages, in_scope
from camsocs_pipeline.sources.websites.links import (
    classify_email,
    feed_of,
    is_join_link,
    mailing_list_of,
    org_words,
    social_of,
)
from camsocs_pipeline.sources.websites.linktree import linktree_links
from camsocs_pipeline.sources.websites.page import detect_platform, parse_page

FIXTURES = Path(__file__).parent / "fixtures" / "websites"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# --- recorded pages -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "url", "platform"),
    [
        ("cuats_wordpress.html", "https://www.cuats.co.uk/", "wordpress"),
        ("catzjcr_squarespace.html", "https://www.catzjcr.com/", "squarespace"),
        ("cuac_wix.html", "https://www.cuac.org.uk/", "wix"),
    ],
)
def test_platform_is_detected_on_recorded_sites(name: str, url: str, platform: str) -> None:
    assert parse_page(url, fixture(name)).platform == platform


def test_wordpress_page_text_keeps_sentences_and_drops_navigation() -> None:
    page = parse_page("https://www.cuats.co.uk/", fixture("cuats_wordpress.html"))
    assert "is the first student society in Cambridge to promote the understanding" in page.text
    # Inline markup stays inside its sentence, with no stray spaces.
    assert "research in quant finance, and industry experts" in page.text
    assert page.title.startswith("Cambridge University Algorithmic Trading Society")
    # mailto: links as written on the site: "Name <address/>", a trailing slash.
    assert page.emails == [
        "president@cuats.co.uk",
        "vice-president@cuats.co.uk",
        "secretary@cuats.co.uk",
        "treasurer@cuats.co.uk",
    ]
    assert {link.region for link in page.links} >= {"main"}


def test_discovery_picks_one_page_per_kind_inside_the_site() -> None:
    page = parse_page("https://www.catzjcr.com/", fixture("catzjcr_squarespace.html"))
    chosen = choose_pages(page.url, page.links)
    assert chosen["committee"] == "https://www.catzjcr.com/committee"
    assert chosen["contact"] == "https://www.catzjcr.com/contact"
    assert all(url.startswith("https://www.catzjcr.com/") for url in chosen.values())
    assert len(set(chosen.values())) == len(chosen)
    assert choose_pages(page.url, page.links, nofollow=True) == {}


def test_discovery_stays_under_a_sub_page_site() -> None:
    home = "https://www.phy.cam.ac.uk/students/physoc"
    assert in_scope("https://www.phy.cam.ac.uk/students/physoc/committee", home)
    assert not in_scope("https://www.phy.cam.ac.uk/about", home)
    assert not in_scope("https://www.phy.cam.ac.uk/students/physoc/login", home)
    assert not in_scope("https://www.phy.cam.ac.uk/students/physoc/termcard.pdf", home)


# --- emails --------------------------------------------------------------------------------


def test_obfuscated_emails_are_never_decoded() -> None:
    html = """<html><body><main>
      <p>Write to <a href="/cdn-cgi/l/email-protection#6800071d1b0d">[email&#160;protected]</a>
      or <span class="__cf_email__" data-cfemail="6800071d1b0d">[email protected]</span>.</p>
      <p>Or president [at] example [dot] org.</p>
      <p><a href="mailto:Secretary@Example.org?subject=Hi">email us</a></p>
    </main></body></html>"""
    page = parse_page("https://example.org/", html)
    assert page.emails == ["secretary@example.org"]
    assert page.obfuscated_emails == 2


@pytest.mark.parametrize(
    ("email", "kind", "role"),
    [
        ("president@cuats.co.uk", "role", "president"),
        ("vicepresident@cambridgeacs.org", "role", "other"),
        ("caribbeanofficer@cambridgeacs.org", "role", "other"),
        ("sponsorship@cuxyz.org", "role", "sponsorship"),
        ("info@cuxyz.org", "general", None),
        ("cuxyz@cambridgesu.co.uk", "general", None),
        ("stcatharinesjcr@gmail.com", "general", None),
        ("ab123@cam.ac.uk", "skip", None),
        ("ab123@jesus.cam.ac.uk", "skip", None),
        ("jane.smith@gmail.com", "skip", None),
        ("jane@cuxyz.org", "skip", None),
    ],
)
def test_emails_are_role_or_general_never_personal(email: str, kind: str, role: str | None) -> None:
    words = org_words("Cambridge University XYZ Society", "St Catharine's JCR", "CUXYZ")
    reading = classify_email(email, org_words=words, site_host="cuxyz.org")
    assert (reading.kind, reading.role) == (kind, role)


# --- links ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "platform", "handle"),
    [
        ("https://www.instagram.com/catz.jcr/", "instagram", "catz.jcr"),
        ("https://www.facebook.com/groups/795160471728479/", "facebook_group", None),
        ("https://twitter.com/stcatharinesjcr", "x", "stcatharinesjcr"),
        ("https://www.linkedin.com/company/cuats/", "linkedin", "cuats"),
        ("https://www.youtube.com/@cucats", "youtube", "cucats"),
        ("https://linktr.ee/cuwes", "linktree", "cuwes"),
    ],
)
def test_social_profiles_are_recognised(url: str, platform: str, handle: str | None) -> None:
    social = social_of(url)
    assert social is not None
    assert (social.platform, social.handle) == (platform, handle)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.linkedin.com/in/jane-smith",
        "https://www.facebook.com/sharer/sharer.php?u=x",
        "https://twitter.com/intent/tweet?text=x",
        "https://www.instagram.com/p/Cx123/",
        "https://www.youtube.com/watch?v=abc",
    ],
)
def test_people_and_share_buttons_are_not_socials(url: str) -> None:
    assert social_of(url) is None


def test_feeds_and_mailing_lists() -> None:
    assert feed_of("webcal://example.org/cal.ics").kind == "ics_urls"
    google = feed_of(
        "https://calendar.google.com/calendar/embed?src=abc%40group.calendar.google.com"
    )
    assert (google.kind, google.value) == ("google_calendar_ids", "abc@group.calendar.google.com")
    assert feed_of("https://lu.ma/cue").value == "cue"
    assert feed_of("https://lu.ma/abcd1234") is None  # a single event
    assert feed_of("https://talks.cam.ac.uk/show/index/12345").value == "12345"
    assert feed_of("https://www.camdram.net/societies/cuadc").kind == "camdram_slug"
    assert feed_of("https://fixr.co/organiser/cuxyz?x=1").value == "https://fixr.co/organiser/cuxyz"
    value, sympa = mailing_list_of("https://lists.cam.ac.uk/sympa/subscribe/soc-cuxyz")
    assert value["platform"] == "sympa" and sympa == "soc-cuxyz"
    assert is_join_link("https://forms.gle/abc", "Membership form")
    assert not is_join_link("https://forms.gle/abc", "Feedback")


def test_platform_from_host_and_markers() -> None:
    assert detect_platform("https://sites.google.com/view/x", "") == "google_sites"
    assert detect_platform("https://x.org/", '<div id="root"></div>') == "spa"
    assert detect_platform("https://x.org/", "<html></html>") is None


def test_linktree_links_come_from_next_data() -> None:
    links = linktree_links(fixture("linktree_synthetic.html"))
    assert [link.url for link in links][:2] == [
        "https://forms.gle/AbCdEfGh123",
        "https://www.cuexamplesoc.org/",
    ]
    assert "https://www.instagram.com/cuexamplesoc/" in {link.url for link in links}
