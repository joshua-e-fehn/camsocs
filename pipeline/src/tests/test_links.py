"""Classifying published links and addresses (sources/links.py): what becomes a
social, a website, a chat platform or a mailing list, and which addresses are
personal. Email kinds are asserted against the fixtures the server's
`classifyEmail` uses (webapp/lib/email-types.fixtures.json)."""

from __future__ import annotations

import json

import pytest

from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.sources.links import (
    INVITE_WITHHELD,
    WITHHELD,
    absolute_url,
    chat_platform,
    classify_email,
    instagram_handle,
    is_email,
    mailing_list_link,
    social_link,
    unwrap_redirect,
    withhold_private,
)

EMAIL_TYPES = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "email-types.fixtures.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", EMAIL_TYPES["cases"], ids=lambda case: case["email"])
def test_email_kinds_match_the_server(case: dict) -> None:
    assert classify_email(case["email"]) == case["type"]


@pytest.mark.parametrize(
    ("href", "base", "expected"),
    [
        ("//instagram.com/cuchess", None, "https://instagram.com/cuchess"),
        ("www.cuchess.org", None, "https://www.cuchess.org"),
        ("cuchess.co.uk/join", None, "https://cuchess.co.uk/join"),
        ("http://cambridge.recruiting@180dc.org", None, None),
        ("mailto:chess@cuchess.org", None, None),
        ("javascript:void(0)", None, None),
        ("#top", None, None),
        ("https://localhost/x", None, None),
    ],
)
def test_only_http_links_with_a_real_host_are_kept(href, base, expected) -> None:
    assert absolute_url(href, base) == expected


def test_relative_hrefs_resolve_against_the_page() -> None:
    page = "https://www.cambridgesu.co.uk/organisation/7501/"
    assert (
        absolute_url("../../file/7501/Termcard/", page)
        == "https://www.cambridgesu.co.uk/file/7501/Termcard/"
    )


@pytest.mark.parametrize(
    ("url", "platform", "handle"),
    [
        ("https://instagram.com/180dc.cambridge", "instagram", "180dc.cambridge"),
        ("https://www.instagram.com/cuchess/?hl=en", "instagram", "cuchess"),
        ("https://www.facebook.com/groups/123456/", "facebook_group", None),
        ("https://www.facebook.com/CUspansoc", "facebook_page", None),
        ("https://twitter.com/CambridgeBioSoc", "x", "CambridgeBioSoc"),
        ("https://x.com/cuchess", "x", "cuchess"),
        ("https://www.tiktok.com/@cuchess", "tiktok", "cuchess"),
        ("https://www.youtube.com/@cuchess", "youtube", "cuchess"),
        ("https://youtube.com/c/OxbridgeBioSoc", "youtube", None),
        ("https://linktr.ee/campsychsoc", "linktree", "campsychsoc"),
        ("https://www.linkedin.com/company/camdata", "linkedin", None),
        ("https://mp.weixin.qq.com/s/abc", "wechat", None),
    ],
)
def test_social_platforms_are_recognised(url, platform, handle) -> None:
    item = social_link(url)
    assert item is not None
    assert item["platform"] == platform
    assert item.get("handle") == handle


@pytest.mark.parametrize(
    "url",
    [
        "https://www.instagram.com/p/C1abc/",
        "https://www.instagram.com/",
        "https://twitter.com/intent/tweet",
        "https://twitter.com/foo%20bar",
        "https://www.youtube.com/watch?v=abc",
        "https://www.facebook.com/",
        "https://cambridge.facebook.com/group.php",
        "https://www.facebook.com/sharer/sharer.php?u=x",
        "https://www.facebook.com/events/923512818296441",
        "https://www.cuchess.org/",
    ],
)
def test_posts_shares_and_ordinary_sites_are_not_socials(url) -> None:
    assert social_link(url) is None


def test_social_urls_lose_tracking_parameters_but_not_their_address() -> None:
    linktree = social_link(
        "https://linktr.ee/cugris?%20utm_source=linktree_profile_share&amp;ltsid=a90"
    )
    assert linktree == {
        "platform": "linktree",
        "url": "https://linktr.ee/cugris",
        "handle": "cugris",
    }
    profile = social_link("https://www.facebook.com/profile.php?id=61565291279223&locale=en_GB")
    assert profile is not None
    assert profile["url"] == "https://www.facebook.com/profile.php?id=61565291279223"


def test_instagram_handle() -> None:
    assert instagram_handle("https://instagram.com/@cu_chess") == "cu_chess"
    assert instagram_handle("https://www.instagram.com/reel/abc/") is None
    assert instagram_handle("https://example.org/cuchess") is None


@pytest.mark.parametrize(
    ("url", "platform"),
    [
        ("https://chat.whatsapp.com/abc", "whatsapp"),
        ("https://wa.me/441234", "whatsapp"),
        ("https://discord.gg/abc", "discord"),
        ("https://discord.com/invite/abc", "discord"),
        ("https://t.me/cuchess", "telegram"),
        ("https://join.slack.com/t/x/shared_invite/y", "slack"),
        ("https://groupme.com/join_group/1/2", "groupme"),
        ("https://www.cuchess.org", None),
    ],
)
def test_chat_platforms(url, platform) -> None:
    assert chat_platform(url) == platform


def test_mailing_list_links_are_sign_up_links_as_published() -> None:
    assert mailing_list_link("https://lists.cam.ac.uk/sympa/subscribe/soc-aim") == {
        "platform": "sympa",
        "signupUrl": "https://lists.cam.ac.uk/sympa/subscribe/soc-aim",
    }
    assert mailing_list_link("https://lists.cam.ac.uk/sympa/info/soc-cuas")["platform"] == "sympa"
    assert mailing_list_link("https://lists.cam.ac.uk/sympa/") is None
    assert mailing_list_link("http://eepurl.com/hKz9Rv")["platform"] == "mailchimp"
    assert (
        mailing_list_link("https://x.us18.list-manage.com/subscribe?u=1&id=2")["platform"]
        == "mailchimp"
    )
    assert mailing_list_link("https://groups.google.com/g/cuchess")["platform"] == "google_group"
    assert mailing_list_link("https://www.cuchess.org/newsletter") is None


def test_redirect_wrappers_are_unwrapped_without_fetching() -> None:
    wrapped = (
        "https://eur03.safelinks.protection.outlook.com/?url=https%3A%2F%2Fcuchess.org%2F&data=x"
    )
    assert unwrap_redirect(wrapped) == "https://cuchess.org/"
    assert unwrap_redirect("https://www.google.com/url?q=https://cuchess.org&sa=D") == (
        "https://cuchess.org"
    )
    assert unwrap_redirect("https://cuchess.org/?url=x") == "https://cuchess.org/?url=x"


def test_free_text_loses_personal_addresses_and_invites_only() -> None:
    text = (
        "Email jf123@cam.ac.uk or ab12@jesus.cam.ac.uk, or president@cuchess.org, "
        "soc-chess@lists.cam.ac.uk. Discord: https://discord.gg/AbC123 and chat.whatsapp.com/XyZ"
    )
    cleaned = withhold_private(text)
    assert "jf123" not in cleaned and "ab12@" not in cleaned
    assert cleaned.count(WITHHELD) == 2
    assert "president@cuchess.org" in cleaned and "soc-chess@lists.cam.ac.uk" in cleaned
    assert "AbC123" not in cleaned and "XyZ" not in cleaned
    assert cleaned.count(INVITE_WITHHELD) == 2


def test_email_syntax() -> None:
    assert is_email("hello@cuchess.org")
    assert not is_email("hello at cuchess.org")
    assert not is_email("hello@localhost")
