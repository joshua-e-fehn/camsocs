"""The Proctors' register (sources/proctors.py, source-research §2), against the
page recorded live on 2026-10-07 (src/tests/fixtures/proctors/register.html)."""

from __future__ import annotations

from pathlib import Path

import pytest

from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.proctors import (
    REGISTER_URL,
    RegisterEntry,
    classify_link,
    parse_register,
    register_name,
    register_observation,
)

FIXTURE = Path(__file__).parent / "fixtures" / "proctors" / "register.html"

PAGE = FetchResult(
    url=REGISTER_URL,
    final_url=REGISTER_URL,
    outcome="fetched",
    status=200,
    fetched_at="2026-10-07T21:40:00+00:00",
    content=b"",
    content_sha256="1" * 64,
)


@pytest.fixture(scope="module")
def entries() -> dict[str, RegisterEntry]:
    parsed = parse_register(FIXTURE.read_text(encoding="utf-8"))
    return {entry.raw_name: entry for entry in parsed}


def test_every_entry_is_read_with_its_one_link(entries) -> None:
    assert len(entries) == 18
    assert (
        entries["180 Degrees Consulting Cambridge"].link == "https://180dc.org/branches/Cambridge"
    )
    # Text outside the anchor belongs to the name.
    assert "Algorithmic Trading Society (CU)" in entries
    # Two anchors on one entry (an editing slip): the first one with text counts.
    assert entries["Musical Theatre Society (CU)"].link == "https://www.cumts.co.uk"
    assert entries["Sign Language Society (CUSLS)"].link == (
        "https://www.cambridgesu.co.uk/organisation/9911/"
    )
    assert entries["Guandan Society (CU)"].link is None


@pytest.mark.parametrize(
    ("raw", "name", "aliases"),
    [
        (
            "African Caribbean Society (CU)",
            "Cambridge University African Caribbean Society",
            (
                "African Caribbean Society (CU)",
                "African Caribbean Society",
                "CU African Caribbean Society",
            ),
        ),
        (
            "AI in Law Society (CU, CUAILS)",
            "Cambridge University AI in Law Society",
            (
                "AI in Law Society (CU, CUAILS)",
                "AI in Law Society",
                "CU AI in Law Society",
                "CUAILS",
            ),
        ),
        (
            "Building Bridges in Medical Sciences (BBMS) Society (The)",
            "The Building Bridges in Medical Sciences (BBMS) Society",
            (
                "Building Bridges in Medical Sciences (BBMS) Society (The)",
                "Building Bridges in Medical Sciences (BBMS) Society",
            ),
        ),
        (
            "Addenbrooke’s Intercollegiate Boat Club (Addies Boat Club) (The)",
            "The Addenbrooke’s Intercollegiate Boat Club (Addies Boat Club)",
            (
                "Addenbrooke’s Intercollegiate Boat Club (Addies Boat Club) (The)",
                "Addenbrooke’s Intercollegiate Boat Club (Addies Boat Club)",
            ),
        ),
        (
            "Sign Language Society (CUSLS)",
            "Sign Language Society",
            ("Sign Language Society (CUSLS)", "CUSLS"),
        ),
        ("180 Degrees Consulting Cambridge", "180 Degrees Consulting Cambridge", ()),
        ("(CU)", "(CU)", ()),
    ],
)
def test_register_names_are_read_back_into_display_order(raw, name, aliases) -> None:
    assert register_name(raw) == (name, aliases)


@pytest.mark.parametrize(
    ("url", "kind"),
    [
        ("https://www.cambridgesu.co.uk/organisation/28488/", "su_profile"),
        ("https://www.facebook.com/addiesforblades/?locale=en_GB", "social"),
        ("https://www.facebook.com/share/15JuhhyJCR/?mibextid=x", "social"),
        ("https://instagram.com/cambridgeabsoc", "social"),
        ("https://linktr.ee/cucats", "social"),
        ("http://www.srcf.ucam.org/bahai/", "srcf"),
        ("https://cucos.soc.srcf.net/wordpress/", "srcf"),
        ("http://cuams.soc.ucam.org", "srcf"),
        ("https://www.cmp.cam.ac.uk/opportunities/entry/x/", "cam"),
        ("https://cuats.co.uk", "website"),
    ],
)
def test_links_are_classified_by_shape(url, kind) -> None:
    assert classify_link(url) == kind


def by_field(observation) -> dict:
    return {f.field: f for f in observation.fields}


def test_an_observation_registers_and_names_the_society(entries) -> None:
    observation = register_observation(entries["Algorithmic Trading Society (CU)"], PAGE)
    observed = by_field(observation)
    assert observation.source_type == "proctors_register"
    assert observation.source_url == REGISTER_URL
    assert observed["registrations.proctors"].value == {
        "registered": True,
        "sourceUrl": REGISTER_URL,
    }
    assert observed["registrations.proctors"].evidence == "primary"
    name = observed["name"]
    assert (name.value, name.value_raw, name.evidence) == (
        "Cambridge University Algorithmic Trading Society",
        "Algorithmic Trading Society (CU)",
        "secondary",
    )
    assert observed["website"].value == "https://cuats.co.uk"
    assert observation.identity.proctors_name == "Algorithmic Trading Society (CU)"
    assert observation.identity.website_domain == "cuats.co.uk"
    assert observation.internal == {
        "proctors_name": "Algorithmic Trading Society (CU)",
        "website_domain": "cuats.co.uk",
    }
    assert observation.entity_key is None, "harvesters never mint keys"


def test_social_links_become_socials(entries) -> None:
    observation = register_observation(entries["Ahlul Bayt Islamic Society"], PAGE)
    observed = by_field(observation)
    assert observed["socials"].value == [
        {
            "platform": "instagram",
            "url": "https://instagram.com/cambridgeabsoc",
            "handle": "cambridgeabsoc",
        }
    ]
    assert observed["socials"].evidence == "secondary"
    assert "website" not in observed
    assert observation.identity.instagram_handle == "cambridgeabsoc"


def test_an_su_link_is_identity_only(entries) -> None:
    observation = register_observation(entries["AI in Law Society (CU, CUAILS)"], PAGE)
    assert set(by_field(observation)) == {"registrations.proctors", "name"}
    assert observation.identity.su_id == "28488"
    assert "CUAILS" in observation.identity.aliases


def test_an_entry_without_a_link_says_nothing_about_a_website(entries) -> None:
    observation = register_observation(entries["Guandan Society (CU)"], PAGE)
    assert set(by_field(observation)) == {"registrations.proctors", "name"}


def test_a_share_link_claims_no_social() -> None:
    entry = RegisterEntry(
        raw_name="Women in Ophthalmology Society",
        name="Women in Ophthalmology Society",
        aliases=(),
        link="https://www.facebook.com/share/15JuhhyJCR/?mibextid=LQQJ4d",
    )
    assert set(by_field(register_observation(entry, PAGE))) == {"registrations.proctors", "name"}
