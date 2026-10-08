"""Sport Cambridge A–Z and club pages (source-research §3)."""

from __future__ import annotations

from camsocs_pipeline.claims import stored_status
from camsocs_pipeline.sources import sport
from tests.seedkit import FakeClient, failed, fixture, ok

AZ = sport.AZ_URL
FINAL_AZ = "https://www.sport.cam.ac.uk/university-sports-clubs-0"


def fields_of(observation) -> dict:
    return {f.field: f for f in observation.fields}


class TestAz:
    def test_lists_each_club_once_in_page_order(self) -> None:
        entries = sport.parse_az(fixture("sport_az.html"), FINAL_AZ)
        assert [e.name for e in entries] == [
            "Aikido Club",
            "Athletic Club",
            "Bowmen (Archery)",
            "Kabaddi Club",
            "Lacrosse Club (Women)",
        ]
        assert entries[0].url == "https://www.sport.cam.ac.uk/university-sports-clubs-0/aikido-club"
        assert entries[0].slug == "aikido-club"

    def test_platform_host_links_go_to_the_canonical_host(self) -> None:
        kabaddi = sport.parse_az(fixture("sport_az.html"), FINAL_AZ)[3]
        assert kabaddi.url == (
            "https://www.sport.cam.ac.uk/student-sport/university-sports-clubs/kabaddi-club"
        )
        assert sport.guide_url(fixture("sport_az.html"), FINAL_AZ) == (
            "https://www.sport.cam.ac.uk/sites/default/files/"
            "UoC%20Sports%20Club%20Guide%2026-27_web.pdf"
        )

    def test_the_register_claims_registration_type_and_category(self) -> None:
        entry = sport.parse_az(fixture("sport_az.html"), FINAL_AZ)[4]
        observation = sport.az_observation(
            entry, ok(AZ, fixture("sport_az.html"), final_url=FINAL_AZ), FakeClient()
        )
        fields = fields_of(observation)
        assert fields["registrations.sportsService"].value == {
            "registered": True,
            "sourceUrl": FINAL_AZ,
        }
        assert fields["registrations.sportsService"].evidence == "primary"
        assert fields["categories"].value == ["sport"]
        assert fields["sport.genderCategories"].value == ["women"]
        assert "name" not in fields  # the A–Z's short label is an alias
        assert observation.identity.sport_slug == "lacrosse-club-womens"


class TestClubPage:
    def test_reads_name_acronym_description_and_instagram(self) -> None:
        url = "https://www.sport.cam.ac.uk/university-sports-clubs-0/athletic-club"
        page = sport.parse_club_page(fixture("sport_club.html"), url)
        assert (page.name, page.short_name) == ("Cambridge University Athletic Club", "CUAC")
        assert page.description.startswith("Cambridge University Athletic Club (CUAC) is one")
        assert "Follow us" not in page.description and "support@" not in page.description
        assert page.short_description == (
            "Cambridge University Athletic Club (CUAC) is one of Cambridge's largest sports "
            "clubs, open to athletes at every level."
        )
        assert page.socials == [
            {
                "platform": "instagram",
                "url": "https://www.instagram.com/cuac_example/",
                "handle": "cuac_example",
            }
        ]

    def test_a_link_whose_text_names_another_account_is_dropped(self) -> None:
        # The fencing page's pasted link: text @c_u_f_c, target the Dance
        # Competition Team's account. Neither is the page's own social.
        html = fixture("sport_club.html").replace(
            'href="https://www.instagram.com/cuac_example/?hl=en">@cuac_example',
            'href="https://www.instagram.com/cudct/?hl=en">@c_u_f_c',
        )
        page = sport.parse_club_page(html, "https://x.example/")
        assert page.socials == []
        assert sport.instagram_handle(page.socials) is None
        # Text written as a URL that agrees with the target is fine.
        agreeing = fixture("sport_club.html").replace(
            ">@cuac_example<", ">instagram.com/cuac_example<"
        )
        assert sport.parse_club_page(agreeing, "https://x.example/").socials[0]["handle"] == (
            "cuac_example"
        )

    def test_finds_the_name_in_the_lead_when_it_is_not_bold(self) -> None:
        page = sport.parse_club_page(fixture("sport_club_lead.html"), "https://x.example/")
        assert (page.name, page.short_name) == (
            "Cambridge University Amateur Boxing Club",
            "CUABC",
        )

    def test_the_sports_service_address_is_never_the_clubs(self) -> None:
        entry = sport.AzEntry("Athletic Club", "https://www.sport.cam.ac.uk/x/athletic-club", "a")
        observation = sport.club_observation(
            entry, ok(entry.url, fixture("sport_club.html")), FakeClient()
        )
        fields = fields_of(observation)
        assert "email" not in fields and "roleEmails" not in fields
        assert fields["name"].value == "Cambridge University Athletic Club"
        assert stored_status(fields["sport.sport"]) == "inferred"
        assert observation.identity.instagram_handle == "cuac_example"

    def test_a_failed_page_is_recorded_as_missing_never_found(self) -> None:
        entry = sport.AzEntry("Aikido Club", "https://www.sport.cam.ac.uk/x/aikido-club", "aikido")
        observation = sport.club_observation(
            entry, failed(entry.url, "not_found", 404), FakeClient()
        )
        fields = fields_of(observation)
        assert {name: (f.status, f.missing_reason) for name, f in fields.items()} == {
            "description": ("missing", "not_found"),
            "socials": ("missing", "not_found"),
        }
        assert observation.fetch.http_status == 404


def test_sport_and_gender_from_names() -> None:
    assert sport.sport_from_name("Bowmen (Archery)") == "Archery"
    assert sport.sport_from_name("Amateur Boxing Club") == "Boxing"
    assert sport.sport_from_name("Lacrosse Club (Men)") == "Lacrosse"
    assert sport.gender_from_name("Lacrosse Club (Mixed)") == ["mixed"]
    assert sport.gender_from_name("Mixed Martial Arts") == []


def test_harvest_never_touches_the_platform_host() -> None:
    club = "https://www.sport.cam.ac.uk/university-sports-clubs-0/aikido-club"
    client = FakeClient(
        {
            AZ: ok(AZ, fixture("sport_az.html"), final_url=FINAL_AZ),
            club: ok(club, fixture("sport_club.html")),
        }
    )
    harvest = sport.harvest(client)
    assert not [url for url in client.asked if "pantheonsite.io" in url]
    assert len(harvest.observations) == 10  # 5 register entries + 5 pages (4 of them 404)
    assert harvest.failed == 4


def test_a_link_pasted_into_other_clubs_pages_stays_only_where_named() -> None:
    """2026-10-08: the Dance Competition Team's link (@cudct) also sits on the
    cricket ("@") and karate (empty text) pages."""
    base = "https://www.sport.cam.ac.uk/university-sports-clubs-0"
    page = fixture("sport_club.html")

    def club(text: str) -> str:
        return page.replace(
            'href="https://www.instagram.com/cuac_example/?hl=en">@cuac_example',
            f'href="https://www.instagram.com/cudct/?hl=en">{text}',
        )

    client = FakeClient(
        {
            AZ: ok(AZ, fixture("sport_az.html"), final_url=FINAL_AZ),
            f"{base}/aikido-club": ok(f"{base}/aikido-club", club(" ")),
            f"{base}/athletic-club": ok(f"{base}/athletic-club", club("@cudct")),
            f"{base}/bowmen-archery-club": ok(f"{base}/bowmen-archery-club", club("@")),
        }
    )
    harvest = sport.harvest(client)
    handles = {
        o.source_key: o.identity.instagram_handle
        for o in harvest.observations
        if o.source_type == "sport_club_page"
    }
    assert handles["athletic-club"] == "cudct"
    assert handles["aikido-club"] is None and handles["bowmen-archery-club"] is None
