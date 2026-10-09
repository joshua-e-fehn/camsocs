"""Camdram societies (source-research §5): role emails, never people."""

from __future__ import annotations

import pytest

from camsocs_pipeline.sources import camdram
from tests.seedkit import FakeClient, fixture, ok

URL = camdram.SOCIETIES_URL


@pytest.fixture
def harvest():
    client = FakeClient({URL: ok(URL, fixture("camdram_societies.json"), ctype="application/json")})
    return camdram.harvest(client)


def fields(observation) -> dict:
    return {f.field: f.value if f.value is not None else f.status for f in observation.fields}


def by_slug(harvest, slug: str):
    return next(o for o in harvest.observations if o.identity.camdram_slug == slug)


def test_every_named_society_is_observed(harvest) -> None:
    assert len(harvest.observations) == 3
    assert harvest.failed == 1  # the nameless one


def test_committee_blocks_become_role_emails_and_leave_the_description(harvest) -> None:
    eadc = by_slug(harvest, "example-amateur-dramatic-club")
    values = fields(eadc)
    assert values["description"] == (
        "The EADC puts on shows every week of term.\n\nWe welcome everyone, whatever their "
        "experience."
    )
    assert values["roleEmails"] == [
        {"role": "president", "email": "president@eadc.example"},
        {"role": "other", "email": "vicepresident@eadc.example"},
        {"role": "publicity", "email": "publicist@eadc.example"},
        {"role": "other", "email": "actor@eadc.example"},
    ]
    assert "Alex Example" not in eadc.model_dump_json()
    assert eadc.identity.camdram_id == 1
    assert eadc.internal == {"camdram_slug": "example-amateur-dramatic-club", "camdram_id": 1}


def test_crsids_and_named_contacts_never_reach_a_field(harvest) -> None:
    players = by_slug(harvest, "example-college-players")
    dumped = players.model_dump_json()
    for personal in ("ab123@cam.ac.uk", "ss123", "Sam Sample"):
        assert personal not in dumped
    values = fields(players)
    assert values["description"] == "Drama at Trinity Hall since 1900."
    assert values["email"] == "exampleplayers@gmail.com"


def test_college_places_and_other_universities(harvest) -> None:
    players = by_slug(harvest, "example-college-players")
    assert fields(players)["level"] == "college"
    assert players.identity.college_hint == "Trinity Hall"
    [rel] = players.relationships
    assert (rel.type, rel.to_identity.name, rel.direction) == (
        "member_college",
        "Trinity Hall",
        "outgoing",
    )
    other = by_slug(harvest, "other-uni-theatre")
    assert fields(other)["level"] == "external" and not other.relationships
    eadc_level = next(
        f for f in by_slug(harvest, "example-amateur-dramatic-club").fields if f.field == "level"
    )
    assert (eadc_level.value, eadc_level.status) == ("university", "inferred")


def test_links_logo_and_registration(harvest) -> None:
    eadc = fields(by_slug(harvest, "example-amateur-dramatic-club"))
    assert eadc["socials"] == [
        {"platform": "facebook_page", "url": "https://www.facebook.com/eadc/"}
    ]
    assert eadc["logo"] == {"sourceUrl": "https://www.camdram.net/media/cache/thumbnail/abc123.png"}
    assert eadc["registrations.camdram"] == {
        "registered": True,
        "sourceUrl": "https://www.camdram.net/societies/example-amateur-dramatic-club",
    }
    assert eadc["shortName"] == "EADC"
    players = fields(by_slug(harvest, "example-college-players"))
    assert players["socials"] == [
        {"platform": "facebook_page", "url": "https://www.facebook.com/123456789012"}
    ]
    assert "shortName" not in players  # same as the name
    other = fields(by_slug(harvest, "other-uni-theatre"))
    assert "socials" not in other  # a link shortener is not a Facebook page
    assert "description" not in other  # a bare link is not a description


LEAD = "We put on plays every term."


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (f"{LEAD}\nArtistic Director: Charlie Example", LEAD),
        (f"{LEAD}\nFounders:\nA B", LEAD),
        (f"{LEAD}\nContact Jo (jo12) for info", LEAD),
        (f"{LEAD}\nOur 2019/20 committee:\nX", LEAD),
        (f"{LEAD}\nMichaelmas: Hamlet", f"{LEAD}\nMichaelmas: Hamlet"),
        ("https://example.org/", None),
    ],
)
def test_public_description_stops_before_people(text: str, expected: str | None) -> None:
    assert camdram.public_description(text) == expected


def test_another_universitys_society_is_a_counterpart(harvest) -> None:
    other = fields(by_slug(harvest, "other-uni-theatre"))
    assert (other["orgType"], other["isCounterpart"]) == ("other_university_society", True)


@pytest.mark.parametrize(
    ("slug", "name", "description", "expected"),
    [
        ("cam-fm", "Cam FM", "Cam FM is Cambridge's student radio station.",
         ("media", ("media_publishing",), False)),
        ("cambridge-university-film-association", "Cambridge University Film Association", "",
         ("society", ("theatre_film_dance", "media_publishing"), False)),
        ("trolleydolly-productions", "Trolleydolly Productions",
         "Trolleydolly Productions is a new Cambridge film-makers' society.",
         ("society", ("theatre_film_dance", "media_publishing"), False)),
        ("bread-theatre-film-company", "Bread Theatre & Film Company", "",
         ("theatre_company", ("theatre_film_dance", "media_publishing"), False)),
        ("trinity-hall-music-society", "Trinity Hall Music Society", None,
         ("society", ("music",), False)),
        ("cambridge-university-ballet-club", "Cambridge University Ballet Club", None,
         ("society", ("theatre_film_dance",), False)),
        ("cambridge-university-opera-society", "Cambridge University Opera Society", "",
         ("theatre_company", ("theatre_film_dance", "music"), False)),
        ("camdram", "Camdram", "Camdram's meta-page on Camdram.", ("other", (), True)),
        ("adc-online", "ADC Online", "https://www.adctheatre.com/",
         ("other", ("theatre_film_dance",), True)),
        ("girton-musical-theatre", "Girton Musical Theatre",
         "We are based in the village of Girton",
         ("theatre_company", ("theatre_film_dance", "music"), True)),
        ("cambridge-creatives", "Cambridge Creatives",
         "We host Q&As with professionals in film, tv and theatre.",
         ("theatre_company", ("theatre_film_dance",), False)),
    ],
)  # fmt: skip
def test_not_everything_on_camdram_is_a_theatre_company(
    slug: str, name: str, description: str | None, expected: tuple
) -> None:
    kind = camdram.camdram_type(slug, name, description)
    assert (kind.org_type, kind.categories, kind.counterpart) == expected


def test_a_community_company_is_external_and_never_listed() -> None:
    society = {
        "id": 99,
        "name": "Pied Pipers",
        "slug": "pied-pipers",
        "description": "The Pied Pipers Musical Theatre Club is an amateur community Musical "
        "Theatre Company based in Cambridge, UK.",
    }
    result = ok(URL, "[]", ctype="application/json")
    observation = camdram.society_observation(society, result, FakeClient({}))
    assert observation is not None
    values = fields(observation)
    assert (values["isCounterpart"], values["level"]) == (True, "external")
    meta = camdram.society_observation(
        {"id": 1, "name": "Camdram", "slug": "camdram", "description": "meta"},
        result,
        FakeClient({}),
    )
    assert meta is not None
    assert "level" not in fields(meta) and fields(meta)["orgType"] == "other"
