"""CUCBC boat clubs (source-research §7)."""

from __future__ import annotations

import pytest

from camsocs_pipeline.sources import cucbc
from tests.seedkit import FakeClient, fixture, ok

LISTING = cucbc.CLUBS_URL
DETAILS = "https://www.cucbc.org/node/86"
LMBC_PAGE = "https://www.ladymargaretboatclub.org/"


def test_parse_clubs_reads_names_details_and_websites() -> None:
    rows = cucbc.parse_clubs(fixture("cucbc_clubs.html"), LISTING)
    assert len(rows) == 8
    assert rows[0] == cucbc.ClubRow(
        "Cambridge University Boat Club", "https://www.cucbc.org/node/87", "http://www.cubc.example"
    )
    assert rows[1].website is None
    assert rows[3].website == "https://www.firstandthird.example/"  # fragment dropped


def test_details_never_decode_the_email_and_never_read_officers() -> None:
    details = cucbc.parse_details(fixture("cucbc_details.html"))
    assert details == cucbc.ClubDetails("Caius Boat Club", "Caius", email_obfuscated=True)


CLUB = ("college_boat_club", "college", True)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Caius Boat Club", (*CLUB, "Gonville & Caius College")),
        ("First and Third Trinity Boat Club", (*CLUB, "Trinity College")),
        ("Trinity Hall Boat Club", (*CLUB, "Trinity Hall")),
        ("Clare Hall Boat Club", (*CLUB, "Clare Hall")),
        ("St. Catharine's College Boat Club", (*CLUB, "St Catharine's College")),
        ("Lady Margaret Boat Club", (*CLUB, "St John's College")),
        ("Cambridge University Boat Club", ("sports_club", "university", True, None)),
        ("Vet School Boat Club", ("sports_club", "department", False, None)),
        ("Mystery Boat Club", ("sports_club", "intercollegiate", False, None)),
    ],
)
def test_classify(name: str, expected: tuple) -> None:
    assert cucbc.classify(name)[:4] == expected


def harvest(lmbc_page: str = "The Lady Margaret Boat Club is the rowing club of St John’s College"):
    client = FakeClient(
        {
            LISTING: ok(LISTING, fixture("cucbc_clubs.html")),
            DETAILS: ok(DETAILS, fixture("cucbc_details.html")),
            LMBC_PAGE: ok(LMBC_PAGE, f"<html><body><p>{lmbc_page}</p></body></html>"),
        }
    )
    return cucbc.harvest(client), client


def club(result, name: str):
    return next(o for o in result.observations if o.identity.name == name)


def test_harvest_places_college_clubs_and_records_what_it_could_not_read() -> None:
    result, _client = harvest()
    caius = club(result, "Caius Boat Club")
    fields = {f.field: f for f in caius.fields}
    assert fields["registrations.cucbc"].value == {"registered": True, "sourceUrl": LISTING}
    assert fields["registrations.cucbc"].evidence == "primary"
    assert (fields["email"].status, fields["email"].missing_reason) == (
        "missing",
        "access_restricted",
    )
    assert caius.internal == {"cucbc_club": "Caius", "website_domain": "caiusbc.example"}
    assert [(r.type, r.to_identity.name) for r in caius.relationships] == [
        ("member_college", "Gonville & Caius College")
    ]
    assert "Alex Example" not in caius.model_dump_json()

    homerton = {f.field: f.value for f in club(result, "Homerton College Boat Club").fields}
    assert homerton["socials"] == [
        {"platform": "facebook_group", "url": "https://www.facebook.com/groups/123456789"}
    ]
    assert "website" not in homerton


def test_a_college_named_elsewhere_is_confirmed_on_that_page() -> None:
    result, client = harvest()
    lmbc = club(result, "Lady Margaret Boat Club")
    assert [(r.to_identity.name, r.evidence_url) for r in lmbc.relationships] == [
        ("St John's College", LMBC_PAGE)
    ]
    assert LMBC_PAGE in client.asked

    unconfirmed, _ = harvest(lmbc_page="We row.")
    assert club(unconfirmed, "Lady Margaret Boat Club").relationships == []
    assert any("no longer names" in note for note in unconfirmed.notes)
