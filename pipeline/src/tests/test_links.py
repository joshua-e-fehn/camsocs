"""Classifying published links and addresses (sources/links.py, the one module
for it): what becomes a social, a website, a chat platform or a mailing list;
which addresses are role, general or personal — personal CRSids never become
values. Email kinds are asserted against the fixtures the server's
`classifyEmail` uses (webapp/lib/email-types.fixtures.json)."""

from __future__ import annotations

import json

import pytest

from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.sources.links import (
    INVITE_WITHHELD,
    WITHHELD,
    absolute_url,
    account_of,
    bare_urls,
    chat_platform,
    classify_email,
    dedupe_socials,
    email_type,
    find_emails,
    has_obfuscated_emails,
    instagram_from_handle,
    instagram_handle,
    instagram_handle_of,
    is_email,
    is_personal_crsid,
    label_role,
    mailing_list_link,
    name_tokens,
    read_contacts,
    registrable,
    role_of,
    social_key,
    social_link,
    unwrap_redirect,
    withhold_private,
)

EMAIL_TYPES = json.loads(
    (REPO_ROOT / "webapp" / "lib" / "email-types.fixtures.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", EMAIL_TYPES["cases"], ids=lambda case: case["email"])
def test_email_kinds_match_the_server(case: dict) -> None:
    assert email_type(case["email"]) == case["type"]


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


# --- reading addresses and social links on a page (formerly contact_links) -----------


class TestEmails:
    @pytest.mark.parametrize(
        "address",
        ["ab123@cam.ac.uk", "XY9@hermes.cam.ac.uk", "abc12@jesus.cam.ac.uk"],
    )
    def test_crsids_on_cam_ac_uk_and_subdomains_are_personal(self, address: str) -> None:
        assert is_personal_crsid(address)
        assert classify_email(address, labelled=True).kind == "personal"

    def test_lists_and_role_addresses_are_not_crsids(self) -> None:
        assert not is_personal_crsid("soc-abc1@lists.cam.ac.uk")
        assert not is_personal_crsid("president@cuadc.org")

    @pytest.mark.parametrize(
        ("address", "role"),
        [
            ("president@cuadc.org", "president"),
            ("vicepresident@cuadc.org", "other"),
            ("womens.president.cuafc@gmail.com", "president"),
            ("mcr_president@corpus.cam.ac.uk", "president"),
            ("cuhwcpresident@gmail.com", "president"),
            ("wcsa-juniortreasurer@wolfson.cam.ac.uk", "treasurer"),
            ("publicist@gands.org.uk", "publicity"),
            ("td@cuadc.org", "other"),
            ("mcr.welfare@magd.cam.ac.uk", "welfare"),
            ("captain@cubowmen.com", "captain"),
            ("info@example.org", None),
        ],
    )
    def test_role_of(self, address: str, role: str | None) -> None:
        assert role_of(address) == role

    def test_a_link_label_can_name_the_post(self) -> None:
        assert label_role("Club Publicist") == "publicity"
        assert label_role("Actors' Rep") == "other"
        assert classify_email("actor@eadc.example", label="Actors' Rep").kind == "role"

    def test_general_addresses_need_a_generic_local_part_or_the_name(self) -> None:
        own = name_tokens("CU Dryden Society", "Dryden")
        assert classify_email("drydensoc@gmail.com", own).kind == "general"
        assert classify_email("enquiries@btb.example").kind == "general"
        # On the organisation's own domain, but a person's mailbox.
        assert classify_email("sam@blanktheatre.example", name_tokens("Blank Theatre")).kind == (
            "unknown"
        )

    def test_another_domains_info_address_is_not_the_pages(self) -> None:
        reading = classify_email(
            "it.support@kings.cam.ac.uk", name_tokens("KCSU"), site_host="kcsu.org.uk"
        )
        assert reading.kind == "unknown"
        same_site = classify_email(
            "committee@mcr.jesus.cam.ac.uk", set(), site_host="mcr.jesus.cam.ac.uk"
        )
        assert same_site.kind == "general"

    def test_short_name_plus_a_word_is_an_officers_post(self) -> None:
        own = name_tokens("Clare Hall Graduate Student Body", "GSB")
        assert classify_email("gsb.punt@clarehall.cam.ac.uk", own).role == "other"
        assert classify_email("gsb.president@clarehall.cam.ac.uk", own).role == "president"

    def test_a_labelled_contact_counts_and_typos_do_not(self) -> None:
        assert classify_email("pythonsexample@gmail.com", labelled=True).kind == "general"
        assert classify_email("official.club@gmail.comm", labelled=True).kind == "unknown"

    def test_a_persons_name_is_never_a_contact_even_where_a_page_says_so(self) -> None:
        # The shape of an SU profile's contact seen on 2026-10-08 (made up).
        for address in ("jane.example@gmail.com", "jane_example@soc.example"):
            reading = classify_email(address, name_tokens("Quokka Society"), labelled=True)
            assert reading.kind == "unknown" and reading.reason == "looks like a person's name"
        alumni = classify_email("jane.example@cantab.net", labelled=True)
        assert alumni.kind == "personal" and email_type("jane.example@cantab.net") == (
            "personal_crsid"
        )
        # Mailboxes named after the society or a post are not people.
        own = name_tokens("Cambridge University Malaysian Society", "CUMaS")
        for address in (
            "logistics.cumas@gmail.com",
            "cambridge.lacrosse@gmail.com",
            "csep.docs@gmail.com",
            "chess.club@gmail.com",
            "quokka.president@gmail.com",
        ):
            assert classify_email(address, own, labelled=True).kept, address

    def test_read_contacts_keeps_the_first_general_and_dedupes_roles(self) -> None:
        contacts = read_contacts(
            [
                "info@a.example",
                "hello@a.example",
                "president@a.example",
                "PRESIDENT@a.example",
                "ab12@cam.ac.uk",
            ]
        )
        assert contacts.email == "info@a.example"
        assert contacts.role_emails == [{"role": "president", "email": "president@a.example"}]

    def test_find_emails_dedupes_and_trims(self) -> None:
        assert find_emails("Mail us: info@x.example. Or INFO@x.example") == ["info@x.example"]

    def test_obfuscation_is_detected_never_decoded(self) -> None:
        assert has_obfuscated_emails('<a href="/cdn-cgi/l/email-protection#a1b2">[email]</a>')
        assert has_obfuscated_emails("<td>jesus[at]cucbc.org</td>")
        assert not has_obfuscated_emails('<a href="mailto:info@x.example">info</a>')


class TestSocialLinks:
    def test_instagram_profile_with_tracking_removed(self) -> None:
        assert social_link("https://www.instagram.com/cuafc/?hl=en") == {
            "platform": "instagram",
            "url": "https://www.instagram.com/cuafc/",
            "handle": "cuafc",
        }

    def test_bare_printed_links_gain_https(self) -> None:
        assert social_link("instagram.com/camuniarchery/")["url"] == (
            "https://instagram.com/camuniarchery/"
        )

    def test_facebook_groups_and_pages(self) -> None:
        assert social_link("https://www.facebook.com/groups/CUJJC")["platform"] == "facebook_group"
        assert social_link("facebook.com/CUAFC1")["platform"] == "facebook_page"

    @pytest.mark.parametrize(
        "url",
        [
            "https://www.facebook.com/sharer.php?u=x",
            "https://www.instagram.com/p/abc123/",
            "https://instagram.com",
            "https://example.org/instagram",
        ],
    )
    def test_not_an_account(self, url: str) -> None:
        assert social_link(url) is None

    def test_printed_handle(self) -> None:
        assert instagram_from_handle("@cugac_") == {
            "platform": "instagram",
            "url": "https://www.instagram.com/cugac_/",
            "handle": "cugac_",
        }
        assert instagram_from_handle("not a handle!") is None

    def test_bare_urls_skip_email_domains(self) -> None:
        text = "cuafc.org    instagram.com/cuafc contact: president@cuafc.org"
        assert bare_urls(text.replace("president@cuafc.org", " ")) == [
            "cuafc.org",
            "instagram.com/cuafc",
        ]


def test_registrable_host() -> None:
    assert registrable("mcr.jesus.cam.ac.uk") == "jesus.cam.ac.uk"
    assert registrable("www.cuadc.org") == "cuadc.org"
    assert registrable("www.blanktheatre.co.uk") == "blanktheatre.co.uk"


# --- one classifier for every source (the consolidation's guarantees) ------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://www.linkedin.com/in/jane-smith-123",  # a person: never stored
        "https://youtu.be/dQw4w9WgXcQ",  # a video, not a channel
        "https://twitter.com/cuchess/status/1234",  # a post
        "https://www.facebook.com/people/Jane-Smith/1000",  # a person
        "https://www.facebook.com/groups",  # no group named
    ],
)
def test_people_posts_and_videos_are_never_socials(url: str) -> None:
    assert social_link(url) is None


def test_one_account_however_it_is_written() -> None:
    spellings = [
        "https://www.instagram.com/CUChess/?hl=en",
        "instagram.com/cuchess",
        "http://instagram.com/cuchess/",
    ]
    items = [social_link(url) for url in spellings]
    assert all(item is not None and item["platform"] == "instagram" for item in items)
    assert len({social_key(item) for item in items if item}) == 1
    assert dedupe_socials([item for item in items if item]) == [items[0]]
    assert instagram_handle("@CUChess") == "CUChess"
    assert instagram_handle_of([items[0]]) == "cuchess"


def test_account_of_names_pages_without_a_handle() -> None:
    page = social_link("https://m.facebook.com/CambridgeUniversity/")
    assert page == {
        "platform": "facebook_page",
        "url": "https://m.facebook.com/CambridgeUniversity/",
    }
    assert account_of(page) == "cambridgeuniversity"


@pytest.mark.parametrize(
    ("address", "kind"),
    [
        ("ab123@srcf.net", "personal"),
        ("ab123@cantab.ac.uk", "personal"),
        ("abc12@cantab.net", "personal"),
        ("chess@srcf.net", "general"),
        ("cuchess@cambridgesu.co.uk", "general"),
        ("jane.smith@cambridgesu.co.uk", "unknown"),
    ],
)
def test_the_crsid_rule_covers_srcf_and_cantab(address: str, kind: str) -> None:
    assert classify_email(address).kind == kind
    assert is_personal_crsid(address) == (kind == "personal")


@pytest.mark.parametrize(
    ("address", "names", "site", "expected"),
    [
        # Initials of the name: "Cambridge University Blind Wine Tasting Society".
        ("cubwts@gmail.com", ("Cambridge University Blind Wine Tasting Society",), None,
         ("general", None)),
        ("mscsec@phil.cam.ac.uk", ("Cambridge University Moral Sciences Club",),
         "www.phil.cam.ac.uk", ("general", None)),
        # The site's own name, on its domain or a sibling one.
        ("cucss@cucss.uk", ("Czech and Slovak Society",), "cucss.uk", ("general", None)),
        ("cucaadmin@gmail.com", ("Conservative Association",), "www.cuca.org.uk",
         ("general", None)),
        ("info@cambridgenightline.org", ("Cambridge Nightline",), "www.cambridgenightline.org.uk",
         ("general", None)),
        ("committee@cuhags.cam", ("Heraldic and Genealogical Society",), "cuhags.soc.srcf.net",
         ("general", None)),
        ("webmaster@ciccu.org.uk", ("CICCU",), "ciccu.org.uk", ("general", None)),
        # Posts.
        ("archim-external-secretary@srcf.net", ("The Archimedeans",), None, ("role", "other")),
        ("jcr.bame@newn.cam.ac.uk", ("Newnham JCR",), "newn.cam.ac.uk", ("role", "other")),
        ("membership@cupoloclub.com", ("Polo Club",), None, ("role", "other")),
        ("cubb-chair@srcf.ucam.org", ("Brass Band Society",), None, ("role", "president")),
        # The name in pieces is no post.
        ("foundation.medtech@gmail.com", ("MedTech Foundation (Cambridge)",), None,
         ("general", None)),
        # Still never a person's.
        ("alice.smith@gmail.com", ("Ice Hockey Club",), None, ("unknown", None)),
        ("support@sport.cam.ac.uk", ("Fencing Club",), "fencing.example", ("unknown", None)),
    ],
)  # fmt: skip
def test_one_reading_of_addresses_for_seeds_and_sites(address, names, site, expected) -> None:
    reading = classify_email(address, name_tokens(*names), site_host=site)
    assert (reading.kind, reading.role) == expected


def test_a_webmaster_named_on_a_committee_list_is_a_post() -> None:
    reading = classify_email("webmaster@cuadc.org", name_tokens("CUADC"), label="Webmaster")
    assert (reading.kind, reading.role) == ("role", "other")


def test_facebook_people_pages_only_of_organisations() -> None:
    page = "https://www.facebook.com/people/Cambridge-University-Immunology-Society/61554/"
    assert social_link(page) == {"platform": "facebook_page", "url": page}
    assert social_link("https://www.facebook.com/people/Jane-Smith/1000123/") is None


def test_addresses_broken_against_spam_are_never_stored_or_repaired() -> None:
    from camsocs_pipeline.sources.links import is_obfuscated_address
    from camsocs_pipeline.sources.websites.page import parse_page

    for address in (
        "round.xyz@cambridgesu.co.uk",
        "round.nospam@cambridgesu.co.uk",
        "soc-round-managers.nospam@lists.cam.ac.uk",
        "ann@example.xyz.org",
    ):
        assert is_obfuscated_address(address), address
        assert classify_email(address, labelled=True).kind == "unknown"
    assert not is_obfuscated_address("president@roundsoc.org")
    assert not is_obfuscated_address("hello@roundsoc.xyz")
    page = parse_page(
        "https://round.example/",
        "<p>Write to round.xyz@cambridgesu.co.uk (remove '.xyz'); "
        "or <a href='mailto:secretary@round.example'>us</a>.</p>",
    )
    assert page.emails == ["secretary@round.example"] and page.obfuscated_emails == 1


def test_an_escaped_address_is_checked_as_the_reader_sees_it() -> None:
    """Review 2026-10-10: the renderer unescapes markdown after every check."""
    from camsocs_pipeline.events.common import withhold_personal_contacts
    from camsocs_pipeline.sources.links import unescape_addresses, withhold_personal_emails
    from camsocs_pipeline.suppressions import REDACTED, Suppressions, contact_hash

    assert unescape_addresses("write to jane\\_doe@gmail.com") == "write to jane_doe@gmail.com"
    assert unescape_addresses("a\\_b and \\*x\\*") == "a\\_b and \\*x\\*"
    assert "ab123" not in withhold_personal_emails("ab\\_123@cam.ac.uk".replace("\\_", ""))
    suppressed = Suppressions(contact_hashes=frozenset({contact_hash("jane_doe@gmail.com")}))
    assert suppressed.redact("mail jane\\_doe@gmail.com") == f"mail {REDACTED}"
    # A feed's personal address is withheld however the converter escaped it.
    assert "jane" not in (withhold_personal_contacts("RSVP jane\\.smith@cantab.net") or "")
    # Entities are never decoded (AGENTS.md): the renderer shows them as written.
    assert unescape_addresses("ab123&#64;cam.ac.uk") == "ab123&#64;cam.ac.uk"
