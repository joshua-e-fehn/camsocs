"""The SU "Find a Society" parsers and observations (sources/su.py, source-research §1),
against pages recorded live on 2026-10-07 (src/tests/fixtures/su/)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from camsocs_pipeline.models.observation import FieldObs, Observation
from camsocs_pipeline.sources.base import FetchResult
from camsocs_pipeline.sources.links import WITHHELD
from camsocs_pipeline.sources.su import (
    DIRECTORY_URL,
    DirectoryEntry,
    Resource,
    academic_year_of,
    current_termcard,
    directory_observation,
    parse_directory,
    parse_profile,
    profile_observation,
    unavailable_profile_observation,
)

FIXTURES = Path(__file__).parent / "fixtures" / "su"
FETCHED_AT = "2026-10-07T22:18:00+00:00"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def page(url: str, html: str = "", **overrides) -> FetchResult:
    values = {
        "url": url,
        "final_url": url,
        "outcome": "fetched",
        "status": 200,
        "fetched_at": FETCHED_AT,
        "content": html.encode(),
        "content_sha256": "0" * 64,
    }
    values.update(overrides)
    return FetchResult(**values)


@pytest.fixture(scope="module")
def entries() -> dict[str, DirectoryEntry]:
    return {entry.su_id: entry for entry in parse_directory(fixture("directory.html"))}


def fields(observation: Observation) -> dict[str, FieldObs]:
    by_name = {f.field: f for f in observation.fields}
    assert len(by_name) == len(observation.fields), "one claim per field per observation"
    return by_name


def profile(entries: dict[str, DirectoryEntry], su_id: str, name: str) -> Observation:
    entry = entries[su_id]
    html = fixture(f"profile_{su_id}_{name}.html")
    return profile_observation(
        entry, parse_profile(html, entry.profile_url), page(entry.profile_url)
    )


# --- the directory ------------------------------------------------------------------------


def test_the_directory_lists_every_entry_with_its_id_link_and_category(entries) -> None:
    assert len(entries) == 11
    dc = entries["15759"]
    assert dc.name == "180 Degrees Consulting (Cambridge)"
    assert dc.profile_url == "https://www.cambridgesu.co.uk/organisation/15759/"
    assert dc.su_slug is None
    assert dc.category == "Skills & Professional Development"
    assert dc.logo_url is not None and "?" not in dc.logo_url
    assert dc.logo_url.startswith("https://www.cambridgesu.co.uk/asset/Organisation/15759/")

    printing = entries["20910"]
    assert printing.su_slug == "cu3d"
    assert printing.profile_url == "https://www.cambridgesu.co.uk/organisation/cu3d/"
    assert entries["27880"].category == "Not categorised"


def test_the_logo_file_name_tells_the_form_year_and_when_it_was_uploaded(entries) -> None:
    dc = entries["15759"]
    assert dc.form_year == "2026-27"
    # "…__Logo__32635_2026-08-14-16-09__…" is London time (BST).
    assert dc.logo_uploaded_at == datetime(2026, 8, 14, 15, 9, tzinfo=UTC)
    assert entries["19097"].form_year == "2025-26"
    assert entries["24140"].form_year == "2024-25"
    assert entries["28172"].form_year == "2025-26"  # "New Society_ Register Here (2025-2026)"
    # A logo re-uploaded through two forms: the outer (newest) one counts.
    assert entries["6961"].form_year == "2026-27"
    assert entries["20910"].form_year is None
    assert entries["20910"].logo_uploaded_at is None


def test_a_directory_observation_registers_the_society_for_the_year_its_form_confirms(
    entries,
) -> None:
    directory = page(DIRECTORY_URL)
    current = fields(directory_observation(entries["15759"], directory, logo_allowed=False))
    assert current["registrations.su"].value == {
        "registered": True,
        "sourceUrl": DIRECTORY_URL,
        "year": "2026-27",
    }
    assert current["registrations.su"].evidence == "primary"
    assert current["name"].value == "180 Degrees Consulting (Cambridge)"
    assert current["suCategory"].value == "Skills & Professional Development"

    # An older form's logo was simply not replaced: listed now, no year claimed.
    older = fields(directory_observation(entries["19097"], directory, logo_allowed=False))
    assert older["registrations.su"].value == {"registered": True, "sourceUrl": DIRECTORY_URL}


def test_the_upload_stamp_is_an_inferred_activity_date(entries) -> None:
    observed = fields(
        directory_observation(entries["15759"], page(DIRECTORY_URL), logo_allowed=False)
    )
    activity = observed["lastActiveAt"]
    assert activity.value == int(datetime(2026, 8, 14, 15, 9, tzinfo=UTC).timestamp() * 1000)
    assert activity.status == "inferred"
    no_stamp = fields(
        directory_observation(entries["20910"], page(DIRECTORY_URL), logo_allowed=False)
    )
    assert "lastActiveAt" not in no_stamp


def test_logos_are_never_hotlinked(entries) -> None:
    directory = page(DIRECTORY_URL)
    blocked = fields(directory_observation(entries["15759"], directory, logo_allowed=False))
    assert blocked["logo"].status == "missing"
    assert blocked["logo"].missing_reason == "access_restricted"
    # Not checked (a dry run) or fetchable without an upload path: say nothing.
    for allowed in (None, True):
        observed = fields(directory_observation(entries["15759"], directory, logo_allowed=allowed))
        assert "logo" not in observed
    assert "asset/" not in directory_observation(
        entries["15759"], directory, logo_allowed=False
    ).model_dump_json(exclude={"fields": {2: {"value_raw"}}, "identity": True})


def test_an_uncategorised_entry_has_a_missing_category(entries) -> None:
    observed = fields(
        directory_observation(entries["27880"], page(DIRECTORY_URL), logo_allowed=False)
    )
    assert observed["suCategory"].status == "missing"
    assert observed["suCategory"].missing_reason == "not_published"


def test_directory_identity_and_internal_ids(entries) -> None:
    observation = directory_observation(entries["20910"], page(DIRECTORY_URL), logo_allowed=False)
    assert observation.source_type == "su_directory"
    assert observation.source_key == "20910"
    assert observation.identity.su_id == "20910"
    assert observation.identity.su_slug == "cu3d"
    assert observation.internal == {"su_org_id": "20910", "su_slug": "cu3d"}
    assert observation.entity_key is None, "harvesters never mint keys"


# --- profiles -------------------------------------------------------------------------------


def test_a_complete_profile(entries) -> None:
    observation = profile(entries, "15759", "full")
    observed = fields(observation)
    assert observation.source_type == "su_profile"
    assert observation.source_url == "https://www.cambridgesu.co.uk/organisation/15759/"
    assert observed["email"].value == "cambridge.recruiting@180dc.org"
    assert observed["socials"].value == [
        {
            "platform": "instagram",
            "url": "https://instagram.com/180dc.cambridge",
            "handle": "180dc.cambridge",
        }
    ]
    assert observed["shortDescription"].value.startswith("180 Degrees is the world")
    assert "\n- Real life consulting experience" in observed["description"].value
    assert observed["website"].value == "https://180dc.org/branch/cambridge/"
    assert observed["joinUrl"].status == "missing"
    assert observed["joinUrl"].missing_reason == "access_restricted"
    assert all(f.method == "parser" and f.evidence == "primary" for f in observation.fields)

    identity = observation.identity
    assert (identity.instagram_handle, identity.website_domain, identity.email_domain) == (
        "180dc.cambridge",
        "180dc.org",
        "180dc.org",
    )
    assert observation.internal["instagram_handle"] == "180dc.cambridge"
    # The SU's own footer links are not the society's.
    assert "yourcambridgesu" not in observation.model_dump_json()


def test_a_legacy_cusu_address_is_kept_and_an_undated_termcard_is_inferred(entries) -> None:
    observed = fields(profile(entries, "9791", "cusu_termcard"))
    assert observed["email"].value == "scansoc@cusu.cam.ac.uk"
    termcard = observed["termcardUrl"]
    assert termcard.value == "https://www.cambridgesu.co.uk/file/9791/Termcard/"
    assert termcard.status == "inferred"


def test_an_empty_profile_records_what_it_does_not_publish(entries) -> None:
    observation = profile(entries, "11551", "cusu_no_description")
    observed = fields(observation)
    for name in ("shortDescription", "description", "website"):
        assert (observed[name].status, observed[name].missing_reason) == (
            "missing",
            "not_published",
        ), name
        assert observed[name].value is None
    # A bare `group.php` link names no page.
    assert [s["url"] for s in observed["socials"].value] == [
        "http://www.facebook.com/streetbitecambridge/",
        "https://instagram.com/streetbite_cambridge",
    ]
    assert observation.identity.email_domain is None, "a shared domain identifies nobody"


def test_a_stale_termcard_is_not_claimed(entries) -> None:
    observed = fields(profile(entries, "10021", "stale_termcard"))
    assert "termcardUrl" not in observed  # "Termcard Michaelmas 2020"


def test_links_in_the_website_slot_and_the_description(entries) -> None:
    observation = profile(entries, "6961", "linktree_mailchimp_chat")
    observed = fields(observation)
    # A Linktree typed into the website slot is a social, not a website.
    assert observed["website"].status == "missing"
    assert observed["socials"].value == [
        {"platform": "linktree", "url": "https://linktr.ee/campsychsoc", "handle": "campsychsoc"}
    ]
    assert observed["mailingList"].value == {
        "platform": "mailchimp",
        "signupUrl": "http://eepurl.com/hKz9Rv",
    }
    assert observed["chatChannels"].value == [{"platform": "whatsapp"}]
    assert "chat.whatsapp.com" not in observation.model_dump_json()


def test_role_addresses_in_the_description(entries) -> None:
    observed = fields(profile(entries, "20303", "role_emails"))
    roles = {(item["role"], item["email"]) for item in observed["roleEmails"].value}
    assert ("treasurer", "treasurer.cbms@gmail.com") in roles
    assert ("president", "pres.cbms@gmail.com") in roles
    assert ("events", "ents.cbms@gmail.com") in roles
    # No role word, or not a role we track: not a role address.
    assert all(not email.startswith(("outreach.", "academic.", "vp.")) for _, email in roles)
    assert observed["email"].value == "liaison.cbms@gmail.com"


def test_a_personal_crsid_never_enters_an_observation(entries) -> None:
    html = fixture("profile_9791_cusu_termcard.html").replace(
        "scansoc@cusu.cam.ac.uk", "zz999@cam.ac.uk"
    )
    html = html.replace(
        "over facebook/messenger.", "over facebook/messenger, or write to zz998@jesus.cam.ac.uk."
    )
    entry = entries["9791"]
    observation = profile_observation(entry, parse_profile(html, entry.profile_url), page("x"))
    observed = fields(observation)
    assert (observed["email"].status, observed["email"].missing_reason) == (
        "missing",
        "not_published",
    )
    assert observed["email"].extractor == "su_profile.email.personal_withheld"
    assert WITHHELD in observed["description"].value
    dumped = observation.model_dump_json()
    assert "zz999" not in dumped and "zz998" not in dumped


def test_an_unavailable_profile_claims_nothing(entries) -> None:
    entry = entries["15759"]
    gone = page(entry.profile_url, outcome="not_found", status=404, content=None)
    observation = unavailable_profile_observation(entry, gone)
    assert observation.fields == []
    assert observation.fetch is not None and observation.fetch.http_status == 404
    assert observation.fetch.access_note == "not_found"


# --- termcards and years ------------------------------------------------------------------------


def test_termcards_dated_to_an_earlier_year_are_stale() -> None:
    now = datetime(2026, 10, 7, tzinfo=UTC)

    def card(title: str) -> Resource:
        return Resource(title=title, url=f"https://su.example/file/{title.replace(' ', '-')}/")

    assert current_termcard([card("Constitution")], now) is None
    assert current_termcard([card("Michaelmas 2020 Term Card")], now) is None
    assert current_termcard([card("Easter 2026 Termcard")], now) is None
    assert current_termcard([card("Michaelmas Term 2025 Card")], now) is None
    dated = card("Michaelmas 2026 Termcard")
    assert current_termcard([card("Termcard"), dated], now) == (dated, True)
    assert current_termcard([card("Lent 2027 Term Card")], now) is not None
    assert current_termcard([card("Termcard 2026-27")], now) is not None
    undated = card("Termcard")
    assert current_termcard([undated], now) == (undated, False)


def test_academic_years_turn_over_on_1_july_in_london() -> None:
    assert academic_year_of(datetime(2026, 6, 30, 22, 59, tzinfo=UTC)) == "2025-26"
    assert academic_year_of(datetime(2026, 6, 30, 23, 0, tzinfo=UTC)) == "2026-27"
    assert academic_year_of(datetime(2027, 1, 19, tzinfo=UTC)) == "2026-27"
