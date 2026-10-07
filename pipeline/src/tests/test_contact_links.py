"""Reading contacts and social links: personal CRSids never become values, role
addresses are told from general ones, and links are classified, not fetched."""

from __future__ import annotations

import pytest

from camsocs_pipeline.sources.contact_links import (
    bare_urls,
    classify_email,
    find_emails,
    has_obfuscated_emails,
    instagram_from_handle,
    is_personal_crsid,
    label_role,
    name_tokens,
    read_contacts,
    registrable,
    role_of,
    social_link,
)


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
        assert classify_email("pythons.example@gmail.com", labelled=True).kind == "general"
        assert classify_email("official.club@gmail.comm", labelled=True).kind == "unknown"

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
