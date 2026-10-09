"""Colleges and their JCR / MCR bodies (source-research §8)."""

from __future__ import annotations

import pytest

from camsocs_pipeline.sources import colleges
from camsocs_pipeline.sources.colleges import Body, harvest_body, names_body, read_body_page
from tests.seedkit import FakeClient, failed, fixture, ok

JCR = Body(
    "Trinity Hall", "Trinity Hall JCR", "jcr", "jcr", ("JCR", "Junior Combination Room"),
    home="https://jcr.th.example/", evidence="https://www.trinhall.cam.ac.uk/jcr",
    dedicated=True,
)  # fmt: skip
MCR = Body("Trinity Hall", "Trinity Hall MCR", "mcr", "mcr", ("MCR",))
COLLEGE_HOST = "trinhall.cam.ac.uk"


def page(body: str, title: str = "Page") -> str:
    return f"<html><head><title>{title}</title></head><body>{body}</body></html>"


class TestCollegeList:
    def test_parse_college_az(self) -> None:
        entries = colleges.parse_college_az(fixture("college_az.html"))
        assert [(e.name, e.website) for e in entries] == [
            ("Christ's College", "https://www.christs.cam.ac.uk/"),
            ("Gonville & Caius College", "https://www.cai.cam.ac.uk/"),
            ("Trinity Hall", "https://www.trinhall.cam.ac.uk/"),
        ]

    def test_colleges_are_counterparts_and_a_changed_list_is_reported(self) -> None:
        url = colleges.COLLEGE_AZ_URL
        observations, notes = colleges.college_observations(
            ok(url, fixture("college_az.html")), FakeClient()
        )
        values = {f.field: f.value for f in observations[0].fields}
        assert values == {
            "name": "Christ's College",
            "orgType": "college",
            "level": "college",
            "isCounterpart": True,
            "website": "https://www.christs.cam.ac.uk/",
        }
        assert observations[0].source_type == "college_list"
        assert any("differs from COLLEGES" in note for note in notes)

    @pytest.mark.parametrize(
        ("hint", "college"),
        [
            ("Caius", "Gonville & Caius College"),
            ("Gonville & Caius", "Gonville & Caius College"),
            ("St. Catharine's", "St Catharine's College"),
            ("Queens'", "Queens' College"),
            ("Trinity Hall", "Trinity Hall"),
            ("Anglia Ruskin", None),
        ],
    )
    def test_canonical_college(self, hint: str, college: str | None) -> None:
        assert colleges.canonical_college(hint) == college

    def test_college_in_name_prefers_the_longest(self) -> None:
        assert colleges.college_in_name("Trinity Hall Boat Club") == "Trinity Hall"
        assert colleges.college_in_name("First and Third Trinity Boat Club") == "Trinity College"
        assert colleges.college_in_name("Clare Hall Boat Club") == "Clare Hall"
        assert colleges.college_in_name("Lady Margaret Boat Club") is None

    def test_the_seed_names_31_colleges_and_every_body_one_of_them(self) -> None:
        assert len(colleges.COLLEGES) == 31
        assert {body.college for body in colleges.BODIES} <= set(colleges.COLLEGES)
        assert len({(body.college, body.name) for body in colleges.BODIES}) == len(colleges.BODIES)


class TestBodyPages:
    def test_names_body(self) -> None:
        assert names_body("Welcome to the Trinity Hall JCR", JCR) == "full"
        assert names_body("The JCR represents undergraduates", JCR) == "short"
        assert names_body("Welcome to the college", JCR) is None

    def test_own_site_gives_links_and_role_addresses_not_another_domains(self) -> None:
        html = page(
            '<a href="https://www.instagram.com/th_jcr/">IG</a>'
            '<a href="mailto:president@jcr.th.example">President</a>'
            '<a href="mailto:it.support@trinhall.cam.ac.uk">IT</a>'
            "<p>Trinity Hall JCR. Write to welfare@jcr.th.example or ab123@cam.ac.uk</p>"
        )
        reading = read_body_page(html, "https://jcr.th.example/", JCR, scope="all")
        assert reading.named == "full"
        assert reading.socials[0]["handle"] == "th_jcr"
        assert reading.contacts.email is None
        assert reading.contacts.role_emails == [
            {"role": "president", "email": "president@jcr.th.example"},
            {"role": "welfare", "email": "welfare@jcr.th.example"},
        ]

    def test_a_shared_page_yields_only_links_labelled_for_the_body(self) -> None:
        html = page(
            "<p>The JCR and the MCR.</p>"
            '<a href="https://www.instagram.com/th_jcr/">JCR Instagram</a>'
            '<a href="https://www.instagram.com/th_mcr/">MCR Instagram</a>'
            '<a href="https://www.instagram.com/trinhall/">Instagram</a>'
        )
        reading = read_body_page(html, "https://www.trinhall.cam.ac.uk/x", MCR, scope="labelled")
        assert [s["handle"] for s in reading.socials] == ["th_mcr"]
        assert reading.named == "short"

    def test_on_the_college_site_only_the_bodys_marks_count(self) -> None:
        html = page(
            "<header><a href='https://www.instagram.com/trinhall/'>Instagram</a></header>"
            "<main><h1>Trinity Hall JCR</h1>"
            "<a href='https://www.instagram.com/trinhall/'>Follow the college</a>"
            "<a href='https://www.instagram.com/trinhalljcr/'>Instagram</a>"
            "<a href='mailto:enquiries@trinhall.cam.ac.uk'>Enquiries</a>"
            "<a href='mailto:jcr.president@trinhall.cam.ac.uk'>President</a></main>"
        )
        reading = read_body_page(
            html, "https://www.trinhall.cam.ac.uk/jcr", JCR, scope="main", college_host=COLLEGE_HOST
        )
        assert [s["handle"] for s in reading.socials] == ["trinhalljcr"]
        assert reading.contacts.email is None
        assert reading.contacts.role_emails == [
            {"role": "president", "email": "jcr.president@trinhall.cam.ac.uk"}
        ]

    def test_hidden_addresses_are_recorded_not_decoded(self) -> None:
        url = "https://jcr.th.example/"
        html = page(
            '<p>Trinity Hall JCR</p><a href="/cdn-cgi/l/email-protection#a1b2c3">[email]</a>'
        )
        client = FakeClient({url: ok(url, html)})
        body = Body("Trinity Hall", "Trinity Hall JCR", "jcr", "jcr", ("JCR",), home=url)
        [observation], _ = harvest_body(client, body)
        missing = {f.field: f.missing_reason for f in observation.fields if f.status == "missing"}
        assert missing == {"email": "access_restricted", "roleEmails": "access_restricted"}


class TestHarvestBody:
    def test_evidence_and_home_pages_both_become_observations(self) -> None:
        client = FakeClient(
            {
                JCR.evidence: ok(JCR.evidence, page("<main>Trinity Hall JCR</main>")),
                JCR.home: ok(JCR.home, page("<p>Welcome to the JCR</p>", "Trinity Hall JCR")),
            }
        )
        evidence, home = harvest_body(client, JCR, COLLEGE_HOST)[0]
        assert {f.field for f in evidence.fields} >= {"name", "orgType", "collegeBody"}
        assert "website" not in {f.field for f in evidence.fields}
        website = next(f for f in home.fields if f.field == "website")
        assert (website.value, website.evidence) == ("https://jcr.th.example/", "primary")
        assert home.parent.name == "Trinity Hall"
        assert {r.type for r in home.relationships} == {"member_college", "parent_of"}

    def test_a_failed_home_is_missing_with_its_reason_and_carries_no_edges(self) -> None:
        unreachable = failed(
            JCR.home, "disallowed_by_robots", detail="robots.txt unreachable: HTTP 500"
        )
        client = FakeClient({JCR.evidence: ok(JCR.evidence, page("<main>Trinity Hall JCR</main>")),
                             JCR.home: unreachable})  # fmt: skip
        observations, notes = harvest_body(client, JCR)
        home = observations[-1]
        [website] = home.fields
        assert (website.field, website.status, website.missing_reason) == (
            "website",
            "missing",
            "unreachable",
        )
        assert home.parent is None and home.relationships == []
        assert any("website missing (unreachable)" in note for note in notes)

    def test_a_home_that_does_not_name_the_body_is_not_its_website(self) -> None:
        client = FakeClient(
            {
                JCR.evidence: ok(JCR.evidence, page("<main>Trinity Hall JCR</main>")),
                JCR.home: ok(JCR.home, page("<p>" + "History of a famous college. " * 20 + "</p>")),
            }
        )
        observations, notes = harvest_body(client, JCR)
        assert len(observations) == 1
        assert any("does not name the body" in note for note in notes)

    def test_a_script_rendered_home_is_vouched_for_by_the_college_link(self) -> None:
        client = FakeClient(
            {
                JCR.evidence: ok(JCR.evidence, page("<main>Trinity Hall JCR</main>")),
                JCR.home: ok(JCR.home, page("<div id='root'></div>", "Vite + React + TS")),
            }
        )
        observations, _ = harvest_body(client, JCR)
        website = next(f for f in observations[-1].fields if f.field == "website")
        assert website.evidence == "secondary"


def test_a_jcr_site_is_read_under_the_society_override_but_a_college_page_is_not(
    tmp_path, net
) -> None:
    # D3: the Caius JCR case. The body's own site disallows every crawler and
    # is read anyway (recorded); the college's page keeps its robots.txt.
    from camsocs_pipeline.sources.base import HostGates, PoliteClient

    net.get("https://jcr.th.example/robots.txt").respond(200, text="User-agent: *\nDisallow: /\n")
    net.get(JCR.home).respond(
        200,
        text=page("<p>Welcome to the Trinity Hall JCR</p>", "Trinity Hall JCR"),
        headers={"content-type": "text/html"},
    )
    net.get("https://www.trinhall.cam.ac.uk/robots.txt").respond(
        200, text="User-agent: *\nDisallow: /jcr\n"
    )
    evidence = net.get(JCR.evidence)
    client = PoliteClient(
        user_agent="camsocs-test/0.1 (+https://example.org/camsocs)",
        cache_dir=tmp_path / "cache",
        gates=HostGates(),
        min_interval=0.0,
        sleep=lambda _s: None,
    )

    observations, _notes = harvest_body(client, JCR, COLLEGE_HOST)

    assert evidence.call_count == 0
    (home,) = observations
    website = next(f for f in home.fields if f.field == "website")
    assert website.value == "https://jcr.th.example/"
    assert home.fetch.robots_verdict == "disallowed"
    assert home.fetch.access_note == "robots_override:society"
