"""Identity resolution (T4): the tricky cases the Cambridge lists actually
contain (LB §1.4–1.5), key stability across runs, the quarantine, references
and the derived claims."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from camsocs_pipeline.claims import parser_field
from camsocs_pipeline.models.observation import (
    EventObservation,
    FieldObs,
    IdentityHints,
    Observation,
    OrganiserObs,
    RelObs,
)
from camsocs_pipeline.models.wire import CrosswalkRow
from camsocs_pipeline.resolve import Crosswalk, Decisions, resolve_records
from camsocs_pipeline.resolve.crosswalk import CrosswalkEntry
from camsocs_pipeline.resolve.names import name_parts, site_identity, split_parenthetical
from camsocs_pipeline.resolve.resolver import Resolution, Resolver, ref_of

AT = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


def org(
    source_type: str,
    source_key: str,
    name: str,
    *,
    fields: list[FieldObs] | None = None,
    relationships: list[RelObs] | None = None,
    **hints: Any,
) -> Observation:
    return Observation(
        source_type=source_type,
        source_key=source_key,
        source_url=f"https://{source_type.replace('_', '-')}.example/{source_key}",
        retrieved_at=AT,
        entity_type="organisation",
        identity=IdentityHints(name=name, **hints),
        fields=[
            parser_field("name", name, extractor="test", evidence="secondary"),
            *(fields or []),
        ],
        relationships=relationships or [],
    )


def keys(resolution: Resolution) -> dict[str, str]:
    """ref → key for every resolved observation."""
    return {
        ref_of(record): record.entity_key
        for record in resolution.records
        if isinstance(record, Observation) and record.entity_key
    }


def field_values(resolution: Resolution, ref: str, field: str) -> list[Any]:
    record = next(r for r in resolution.records if ref_of(r) == ref)
    return [obs.value for obs in record.fields if obs.field == field]


# --- names -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("Cambridge University Hockey Club", "Hockey Club (CU)"),
        ("CU Hockey", "Hockey Society"),
        ("Lacrosse (Women's)", "Cambridge University Women's Lacrosse Club"),
        ("Cambridge Inter-Collegiate Christian Union", "Intercollegiate Christian Union"),
        ("Society for Women in Physics", "Women in Physics"),
        ("Jesus College Boat Club", "Jesus Boat Club"),
    ],
)
def test_names_that_are_one_group_share_a_signature(a: str, b: str) -> None:
    sig_a = name_parts(split_parenthetical(a)[0]).signature()
    sig_b = name_parts(split_parenthetical(b)[0]).signature()
    assert sig_a == sig_b


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("Lacrosse (Men's)", "Lacrosse (Women's)"),
        ("Cambridge University Boat Club", "Jesus College Boat Club"),
        ("Trinity Hall Boat Club", "Trinity College Boat Club"),
        ("Clare Hall Football", "Clare College Football"),
        ("Jesus College JCR", "Jesus College MCR"),
    ],
)
def test_names_of_different_groups_differ(a: str, b: str) -> None:
    assert name_parts(a).signature() != name_parts(b).signature()


def test_bracketed_acronyms_are_aliases_but_qualifiers_stay() -> None:
    assert split_parenthetical("Cambridge University Entrepreneurs (CUE)") == (
        "Cambridge University Entrepreneurs",
        ["CUE"],
    )
    assert split_parenthetical("Lacrosse (Men's)") == ("Lacrosse Men's", [])


def test_site_identity_keeps_paths_only_on_shared_hosts() -> None:
    assert site_identity("https://www.cue.org.uk/about/") == "cue.org.uk"
    assert site_identity("http://linktr.ee/cuwes") == "linktr.ee/cuwes"
    assert (
        site_identity("https://sites.google.com/view/cusoc/home") == "sites.google.com/view/cusoc"
    )
    assert site_identity("https://www.jesus.cam.ac.uk/boat-club") == "jesus.cam.ac.uk/boat-club"
    assert site_identity("https://www.instagram.com/cue") is None
    assert site_identity("https://www.cambridgesu.co.uk/organisation/8391/") is None


# --- the tricky fixtures ------------------------------------------------------------------


def test_cue_and_the_su_entrepreneurs_society_are_one_organisation() -> None:
    """LB §1.4: CUE is listed by the SU as "Entrepreneurs Society"."""
    su = org("su_directory", "8391", "Entrepreneurs Society", su_id="8391")
    proctors = org(
        "proctors_register",
        "cue",
        "Cambridge University Entrepreneurs (CUE)",
        proctors_name="Cambridge University Entrepreneurs (CUE)",
        level="university",
    )
    acronym_only = org("manual", "cue-short", "CUE", level="university")
    kings = org(
        "college_list",
        "kings/entrepreneurship-lab",
        "The King's Entrepreneurship Lab Society",
        college_hint="King's",
        level="college",
    )
    resolution = resolve_records([su, proctors, acronym_only, kings])
    by_ref = keys(resolution)
    assert by_ref["su_directory:8391"] == by_ref["proctors_register:cue"]
    assert by_ref["manual:cue-short"] == by_ref["su_directory:8391"]
    assert by_ref["college_list:kings/entrepreneurship-lab"] != by_ref["su_directory:8391"]
    assert not resolution.report.held


def test_a_college_boat_club_never_merges_with_cubc() -> None:
    cubc = org(
        "sport_az",
        "boat-club",
        "Cambridge University Boat Club",
        sport_slug="boat-club",
        level="university",
        website_domain="https://www.cubc.org.uk/",
    )
    jesus_cucbc = org(
        "cucbc",
        "jesus",
        "Jesus College Boat Club",
        cucbc_club="Jesus",
        level="college",
        org_type="college_boat_club",
        college_hint="Jesus",
    )
    jesus_list = org(
        "college_list",
        "jesus/boat-club",
        "Boat Club",
        level="college",
        college_hint="Jesus College",
    )
    caius_list = org(
        "college_list", "caius/boat-club", "Boat Club", level="college", college_hint="Caius"
    )
    resolution = resolve_records([cubc, jesus_cucbc, jesus_list, caius_list])
    by_ref = keys(resolution)
    assert by_ref["sport_az:boat-club"] == "org-cambridge-university-boat-club"
    assert by_ref["cucbc:jesus"] == by_ref["college_list:jesus/boat-club"]
    assert by_ref["cucbc:jesus"] == "org-jesus-college-boat-club"
    assert by_ref["college_list:caius/boat-club"] == "org-gonville-and-caius-college-boat-club"
    assert len(set(by_ref.values())) == 3


def test_cubc_listed_at_another_level_is_held_not_duplicated() -> None:
    sport = org(
        "sport_az",
        "boat-club",
        "Cambridge University Boat Club",
        level="university",
        website_domain="cubc.org.uk",
    )
    cucbc = org(
        "cucbc",
        "cubc",
        "Cambridge University Boat Club",
        level="intercollegiate",
        website_domain="https://cubc.org.uk/",
    )
    resolution = resolve_records([sport, cucbc])
    assert set(keys(resolution)) == {"sport_az:boat-club"}
    (held,) = resolution.report.held
    assert held.refs == ["cucbc:cubc"]
    assert "levels differ" in held.reason
    assert held.keys == []  # the kept side had no crosswalk key yet; see detail
    assert "sport_az:boat-club" in (held.detail or "")


def test_a_club_on_two_college_lists_stays_two_until_decided() -> None:
    """LB §1.5: Pirton RFC is on Pembroke's and Girton's lists."""
    pembroke = org(
        "college_list", "pem/pirton", "Pirton RFC", level="college", college_hint="Pembroke"
    )
    girton = org("college_list", "gir/pirton", "Pirton RFC", level="college", college_hint="Girton")
    resolution = resolve_records([pembroke, girton])
    by_ref = keys(resolution)
    assert by_ref["college_list:pem/pirton"] == "org-pembroke-college-pirton-rfc"
    assert by_ref["college_list:gir/pirton"] == "org-girton-college-pirton-rfc"
    (shared,) = [item for item in resolution.report.review if "several colleges" in item.reason]
    assert shared.refs == ["college_list:gir/pirton", "college_list:pem/pirton"]

    decided = resolve_records(
        [pembroke, girton],
        decisions=Decisions(same=[["college_list:pem/pirton", "college_list:gir/pirton"]]),
    )
    merged = keys(decided)
    assert merged["college_list:pem/pirton"] == merged["college_list:gir/pirton"]
    assert merged["college_list:pem/pirton"] == "org-pirton-rfc"


def test_one_instagram_on_two_college_lists_holds_one_side() -> None:
    pembroke = org(
        "college_list",
        "pem/pirton",
        "Pirton RFC",
        level="college",
        college_hint="Pembroke",
        instagram_handle="pirtonrfc",
    )
    girton = org(
        "college_list",
        "gir/pirton",
        "Pirton Rugby",
        level="college",
        college_hint="Girton",
        instagram_handle="@PirtonRFC",
    )
    resolution = resolve_records([pembroke, girton])
    assert len(keys(resolution)) == 1
    (held,) = resolution.report.held
    assert "different colleges" in held.reason


def test_the_three_lacrosse_clubs_stay_three() -> None:
    """Sport A–Z lists Lacrosse three times (LB §1.1), sharing one Instagram."""
    entries = [
        org(
            "sport_az",
            f"lacrosse-{suffix}",
            f"Lacrosse ({label})",
            sport_slug=f"lacrosse-{suffix}",
            level="university",
            instagram_handle="cambridgelacrosse",
        )
        for suffix, label in (("mens", "Men's"), ("womens", "Women's"), ("mixed", "Mixed"))
    ]
    su_women = org(
        "su_directory",
        "4410",
        "Cambridge University Women's Lacrosse Club",
        su_id="4410",
    )
    resolution = resolve_records([*entries, su_women])
    by_ref = keys(resolution)
    assert len({by_ref[f"sport_az:lacrosse-{s}"] for s in ("mens", "womens", "mixed")}) == 3
    assert by_ref["su_directory:4410"] == by_ref["sport_az:lacrosse-womens"]
    assert not resolution.report.held
    assert any("separate entries" in item.reason for item in resolution.report.review)


def test_su_directory_and_profile_are_one_by_su_id() -> None:
    directory = org("su_directory", "6789", "German Society", su_id="6789")
    profile = org("su_profile", "6789", "CU German Society", su_id="6789")
    resolution = resolve_records([directory, profile])
    assert set(keys(resolution).values()) == {"org-cu-german-society"}


def test_two_su_entries_with_one_name_stay_two() -> None:
    a = org("su_directory", "1", "Chess Society", su_id="1")
    b = org("su_directory", "2", "Chess Club", su_id="2")
    resolution = resolve_records([a, b])
    assert len(set(keys(resolution).values())) == 2


def test_operator_distinct_decision_keeps_a_name_match_apart() -> None:
    a = org("proctors_register", "a", "Hindu Society", level="university")
    b = org("su_directory", "77", "CU Hindu Society", su_id="77")
    decided = resolve_records(
        [a, b], decisions=Decisions(distinct=[["proctors_register:a", "su_directory:77"]])
    )
    assert len(set(keys(decided).values())) == 2


# --- keys across runs ---------------------------------------------------------------------


def test_keys_survive_renames_and_new_sources(tmp_path) -> None:
    crosswalk = Crosswalk()
    first = resolve_records(
        [org("su_directory", "6789", "German Society", su_id="6789")], crosswalk=crosswalk
    )
    (key,) = set(keys(first).values())
    path = tmp_path / "crosswalk.json"
    crosswalk.save(path)

    reloaded = Crosswalk.load(path)
    second = resolve_records(
        [
            org(
                "su_directory",
                "6789",
                "Cambridge University German Society",
                su_id="6789",
                instagram_handle="cugermansoc",
            ),
            org("camdram", "german-soc", "Deutsche Gesellschaft", instagram_handle="cugermansoc"),
        ],
        crosswalk=reloaded,
    )
    assert set(keys(second).values()) == {key}


def test_a_new_group_does_not_take_a_known_groups_key() -> None:
    crosswalk = Crosswalk()
    resolve_records([org("su_directory", "1", "Chess Society", su_id="1")], crosswalk=crosswalk)
    later = resolve_records(
        [org("su_directory", "2", "Chess Society", su_id="2")], crosswalk=crosswalk
    )
    (key,) = set(keys(later).values())
    assert key != "org-chess-society"
    assert key.startswith("org-chess-society-")


def test_the_convex_crosswalk_keeps_keys_on_a_fresh_machine() -> None:
    crosswalk = Crosswalk()
    added = crosswalk.merge_remote(
        [
            CrosswalkRow(
                org_key="org-entrepreneurs-society",
                name="Entrepreneurs Society",
                level="university",
                su_org_id="8391",
                instagram_handle="cue_cambridge",
            )
        ]
    )
    assert added == 1
    resolution = resolve_records(
        [
            org("su_directory", "8391", "Entrepreneurs Society", su_id="8391"),
            org(
                "manual",
                "cue",
                "Cambridge University Entrepreneurs",
                instagram_handle="cue_cambridge",
            ),
        ],
        crosswalk=crosswalk,
    )
    assert set(keys(resolution).values()) == {"org-entrepreneurs-society"}


# --- references and derived claims ------------------------------------------------------


def test_references_are_keyed_counterparts_created_unknowns_dropped() -> None:
    college = org("college_list", "jesus", "Jesus College", org_type="college", level="college")
    jcr = org(
        "college_list",
        "jesus/jcr",
        "Jesus College Students' Union",
        org_type="jcr",
        level="college",
        college_hint="Jesus",
        relationships=[
            RelObs(
                type="member_college",
                to_identity=IdentityHints(name="Jesus College", org_type="college"),
                evidence_url="https://college-list.example/jesus/jcr",
            ),
            RelObs(
                type="sponsors",
                direction="incoming",
                to_identity=IdentityHints(name="Jane Street", org_type="company"),
                evidence_url="https://college-list.example/jesus/jcr",
            ),
            RelObs(
                type="sister_of",
                to_identity=IdentityHints(name="Nobody We Know Society"),
                evidence_url="https://college-list.example/jesus/jcr",
            ),
        ],
    )
    team = Observation(
        source_type="college_list",
        source_key="jesus/jcr/football",
        source_url="https://college-list.example/jesus",
        retrieved_at=AT,
        entity_type="team",
        identity=IdentityHints(name="Firsts"),
        parent=IdentityHints(name="Jesus College Students' Union", college_hint="Jesus"),
        fields=[parser_field("name", "Firsts", extractor="test", evidence="secondary")],
    )
    event = EventObservation(
        source_type="ics_feed",
        source_key="uid-1",
        source_url="https://feeds.example/jcsu.ics",
        retrieved_at=AT,
        event_source="ics",
        external_id="uid-1",
        visibility="public",
        organisers=[
            OrganiserObs(identity=IdentityHints(name="Jesus College Students Union")),
            OrganiserObs(identity=IdentityHints(name="Someone Else Entirely")),
        ],
        fields=[parser_field("title", "Bop", extractor="test", evidence="primary")],
    )
    resolution = resolve_records([college, jcr, team, event])
    by_ref = keys(resolution)
    assert by_ref["college_list:jesus"] == "org-jesus-college"
    jcr_key = by_ref["college_list:jesus/jcr"]

    jcr_out = next(r for r in resolution.records if ref_of(r) == "college_list:jesus/jcr")
    targets = {rel.type: rel.to_identity.known_key for rel in jcr_out.relationships}
    assert targets == {"member_college": "org-jesus-college", "sponsors": "org-jane-street"}

    jane = next(r for r in resolution.records if r.entity_key == "org-jane-street")
    assert {obs.field: obs.value for obs in jane.fields} == {
        "name": "Jane Street",
        "isCounterpart": True,
        "orgType": "company",
        "level": "external",
    }
    assert jane.fields[0].evidence == "secondary"
    # Counterparts come first, so the page's own organisation owns its sources row.
    assert resolution.records[0] is jane

    team_out = next(r for r in resolution.records if ref_of(r) == "college_list:jesus/jcr/football")
    assert team_out.parent.known_key == jcr_key
    assert team_out.entity_key == f"team-{jcr_key[4:]}--firsts"

    event_out = next(r for r in resolution.records if isinstance(r, EventObservation))
    assert [o.identity.known_key for o in event_out.organisers] == [jcr_key]
    dropped = {item.names[0] for item in resolution.report.dropped_references}
    assert dropped == {"Nobody We Know Society", "Someone Else Entirely"}


def test_a_counterpart_an_earlier_run_created_is_restated_each_run() -> None:
    """The crosswalk outlives the deployment's rows (a dev purge, a new
    production deployment): a counterpart staged only on the run that first
    met it would be missing from the next full load (2026-10-09: 120 sponsor
    counterparts lost after a purge). Each run that references it restates it."""

    def page(run: str) -> Observation:
        return org(
            "society_website",
            f"robots/{run}",
            "Example Robotics Society",
            relationships=[
                RelObs(
                    type="sponsors",
                    direction="incoming",
                    to_identity=IdentityHints(name="Jane Street", org_type="company"),
                    evidence_url="https://society-website.example/robots",
                )
            ],
        )

    crosswalk = Crosswalk()
    first = resolve_records([page("1")], crosswalk=crosswalk, run_key="20261008T000000Z-aaaaaa")
    assert any(r.entity_key == "org-jane-street" for r in first.records)

    second = Resolver(crosswalk, run_key="20261009T000000Z-bbbbbb")
    resolution = second.run([page("2")])
    (jane,) = [r for r in resolution.records if r.entity_key == "org-jane-street"]
    assert {obs.field: obs.value for obs in jane.fields} == {
        "name": "Jane Street",
        "isCounterpart": True,
        "orgType": "company",
        "level": "external",
    }
    assert jane.source_url == "https://society-website.example/robots/2"
    assert second.counts["counterparts_restated"] == 1
    assert second.counts["counterparts_created"] == 0
    # Once per run, however many pages name it.
    assert second.reference_key(IdentityHints(name="Jane Street"), page("3")) == "org-jane-street"
    assert second.take_counterparts() == []

    # A counterpart a record of this run stages itself is not restated from a reference.
    own = org("su_directory", "9999", "Jane Street", org_type="company")
    third = resolve_records(
        [own, page("4")], crosswalk=crosswalk, run_key="20261010T000000Z-cccccc"
    )
    janes = [r for r in third.records if r.entity_key == "org-jane-street"]
    assert [ref_of(r) for r in janes] == ["su_directory:9999"]


def test_a_college_that_is_not_a_cambridge_college_is_an_outside_body() -> None:
    """2026-10-09: a society's site named the Royal Veterinary College as a
    partner, typed `college` by the model, and it showed up in the public
    college filter beside the 31 Cambridge colleges."""
    page = org(
        "society_website",
        "vets",
        "Example Veterinary Society",
        relationships=[
            RelObs(
                type="partner_of",
                to_identity=IdentityHints(name="Royal Veterinary College", org_type="college"),
                evidence_url="https://society-website.example/vets",
            ),
            RelObs(
                type="partner_of",
                to_identity=IdentityHints(name="Girton College", org_type="college"),
                evidence_url="https://society-website.example/vets",
            ),
        ],
    )
    resolution = resolve_records([page], run_key="20261009T000000Z-aaaaaa")
    created = {
        r.entity_key: {obs.field: obs.value for obs in r.fields}
        for r in resolution.records
        if r.entity_key in ("org-royal-veterinary-college", "org-girton-college")
    }
    assert created["org-royal-veterinary-college"] == {
        "name": "Royal Veterinary College",
        "isCounterpart": True,
        "orgType": "other",
        "level": "external",
    }
    assert created["org-girton-college"]["orgType"] == "college"


def test_an_organisations_parent_is_keyed_or_dropped() -> None:
    college = org("college_list", "christs", "Christ's College", org_type="college")
    mcr = org("society_website", "christs/mcr", "Christ's College MCR", org_type="mcr")
    mcr.parent = IdentityHints(name="Christ's College", org_type="college", level="college")
    orphan = org("society_website", "nowhere/mcr", "Nowhere MCR", org_type="mcr")
    orphan.parent = IdentityHints(name="Nobody We Know Society")

    resolution = resolve_records([college, mcr, orphan])
    by_ref = {ref_of(r): r for r in resolution.records if isinstance(r, Observation)}

    keyed = by_ref["society_website:christs/mcr"]
    assert keyed.parent.known_key == "org-christs-college"
    assert keyed.is_keyed
    dropped = by_ref["society_website:nowhere/mcr"]
    assert dropped.parent is None and dropped.is_keyed
    assert {item.names[0] for item in resolution.report.dropped_references} == {
        "Nobody We Know Society"
    }


def test_a_new_organisation_no_source_names_is_held() -> None:
    guide = org("sport_guide_pdf", "dancesport", "Dancesport & Rock n Roll")
    guide.fields = [f for f in guide.fields if f.field != "name"]
    named = org("sport_az", "chess", "Chess Club")

    resolution = resolve_records([guide, named])

    assert set(keys(resolution)) == {"sport_az:chess"}
    [held] = resolution.report.held
    assert held.refs == ["sport_guide_pdf:dancesport"]
    assert "names it" in held.reason


def test_college_keys_and_the_sport_category_are_derived() -> None:
    college = org("college_list", "jesus", "Jesus College", org_type="college")
    boat = org(
        "cucbc", "jesus", "Jesus College Boat Club", college_hint="Jesus", cucbc_club="Jesus"
    )
    hockey = org(
        "sport_az",
        "hockey",
        "Cambridge University Hockey Club",
        sport_slug="hockey",
        fields=[
            parser_field(
                "registrations.sportsService",
                {"registered": True, "year": "2026-27"},
                extractor="test",
                evidence="primary",
            )
        ],
    )
    resolution = resolve_records([college, boat, hockey])
    assert field_values(resolution, "cucbc:jesus", "collegeKeys") == [["org-jesus-college"]]
    assert field_values(resolution, "sport_az:hockey", "categories") == [["sport"]]

    without_college = resolve_records([boat])
    assert field_values(without_college, "cucbc:jesus", "collegeKeys") == []
    assert without_college.report.counts["college_keys_waiting"] == 1


def test_already_keyed_records_are_left_to_load() -> None:
    keyed = org("society_website", "https://a.example/", "A Society")
    keyed.entity_key = "org-a-society"
    resolution = resolve_records([keyed, org("su_directory", "1", "B Society", su_id="1")])
    assert [ref_of(r) for r in resolution.records] == ["su_directory:1"]
    assert resolution.report.counts["already_keyed"] == 1


def test_unrelated_groups_with_one_shared_word_are_only_flagged() -> None:
    a = org("su_directory", "1", "Cambridge University Hindu Society", su_id="1")
    b = org("proctors_register", "b", "Hindu Cultural Society", level="university")
    resolution = resolve_records([a, b])
    assert len(set(keys(resolution).values())) == 2
    assert any(item.reason == "similar names, not merged" for item in resolution.report.review)


# --- shared handles, unlinked guide rows, directory pages ------------------------------------


def test_a_handle_two_sport_clubs_share_fuses_nobody() -> None:
    """CURA's and CUSBC's Sport pages both link ig:cambridgeuniversityrifle;
    the SU's "Smallbore Club" links it too. Whichever pair came first used to
    be fused and the real match split off."""
    site = parser_field(
        "website", "https://cusmallbore.weebly.com/", extractor="test", evidence="secondary"
    )
    smallbore_su = org(
        "su_directory", "13182", "Smallbore Club", su_id="13182",
        instagram_handle="cambridgeuniversityrifle", fields=[site],
    )  # fmt: skip
    rifle = org(
        "sport_club_page", "rifle-association", "Cambridge University Rifle Association",
        sport_slug="rifle-association", level="university",
        instagram_handle="cambridgeuniversityrifle",
    )  # fmt: skip
    small_bore = org(
        "sport_club_page", "small-bore", "Small Bore Club",
        sport_slug="small-bore", level="university",
        instagram_handle="cambridgeuniversityrifle", fields=[site],
    )  # fmt: skip
    resolution = resolve_records([smallbore_su, rifle, small_bore])
    by_ref = keys(resolution)
    assert by_ref["su_directory:13182"] != by_ref["sport_club_page:rifle-association"]
    assert by_ref["su_directory:13182"] == by_ref["sport_club_page:small-bore"]
    assert any("separate entries" in item.reason for item in resolution.report.review)


def test_a_handle_two_proctors_entries_share_does_not_split_the_true_match() -> None:
    """ClinSoc (SU) and the Proctors' "Clinsoc Volleyball Society" share
    ig:medicsofcambridge; the Proctors' Clinical Students Society is ClinSoc."""
    clinsoc = org(
        "su_directory", "8131", "Cambridge University Clinical Students Society",
        su_id="8131", instagram_handle="medicsofcambridge",
    )  # fmt: skip
    volleyball = org(
        "proctors_register", "clinsoc-volleyball", "Clinsoc Volleyball Society",
        proctors_name="Clinsoc Volleyball Society", instagram_handle="medicsofcambridge",
    )  # fmt: skip
    clinical = org(
        "proctors_register", "clinical", "Cambridge University Clinical Students Society",
        proctors_name="Clinical Students Society (CU)",
    )  # fmt: skip
    by_ref = keys(resolve_records([clinsoc, volleyball, clinical]))
    assert by_ref["su_directory:8131"] == by_ref["proctors_register:clinical"]
    assert by_ref["proctors_register:clinsoc-volleyball"] != by_ref["su_directory:8131"]


def test_an_unlinked_guide_row_never_joins_a_club_by_its_sport_word() -> None:
    """§4: "Rowing (College)" is college rowing, not a club; only the guide's
    "Rowing (Boat Club)" row, which the A–Z links, is CUBC's."""
    cubc = org(
        "sport_az", "boat-club-rowing", "Boat Club (Rowing)",
        sport_slug="boat-club-rowing", level="university",
    )  # fmt: skip
    linked = org("sport_guide_pdf", "rowing-boat-club", "Rowing (Boat Club)",
                 sport_slug="boat-club-rowing")  # fmt: skip
    college_rowing = org("sport_guide_pdf", "rowing-college", "Rowing (College)")
    for row in (linked, college_rowing):
        row.fields = [f for f in row.fields if f.field != "name"]  # the guide claims no names
    resolution = resolve_records([cubc, linked, college_rowing])
    by_ref = keys(resolution)
    assert by_ref["sport_guide_pdf:rowing-boat-club"] == by_ref["sport_az:boat-club-rowing"]
    assert "sport_guide_pdf:rowing-college" not in by_ref
    assert "sport_guide_pdf:rowing-college" in resolution.held_refs

    # Not even when an earlier run's crosswalk keyed the row by name.
    crosswalk = Crosswalk()
    crosswalk.upsert(
        CrosswalkEntry(
            key=by_ref["sport_az:boat-club-rowing"],
            name="Boat Club (Rowing)",
            ids=["ref:sport_guide_pdf:rowing-college", "sport:boat-club-rowing"],
        )
    )
    again = resolve_records([cubc, linked, college_rowing], crosswalk=crosswalk)
    assert "sport_guide_pdf:rowing-college" in again.held_refs


def test_a_cucbc_directory_page_identifies_no_club() -> None:
    assert site_identity("https://www.cucbc.org/node/122") is None
    assert site_identity("http://www.cucbc.org") is None


# --- pages shared by bodies, decisions and operator claims (R2) -------------------------------


def _body(name: str, org_type: str, page: str, **hints: Any) -> Observation:
    record = org(
        "society_website", page, name, org_type=org_type, level="college",
        college_hint="Churchill College", **hints,
    )  # fmt: skip
    record.source_url = page
    return record


def _keys_by_name(resolution: Resolution) -> dict[str, str]:
    return {
        record.identity.name: record.entity_key
        for record in resolution.records
        if isinstance(record, Observation) and record.entity_key
    }


def test_a_page_naming_a_jcr_and_an_mcr_identifies_neither() -> None:
    """The college's "JCR and MCR" page is observed once per body (one ref
    for two observations). A crosswalk that recorded that page under both
    keys (as runs before this rule did) must not hold either: each keeps its
    own key by name."""
    page = "https://www.chu.cam.ac.uk/about/governance/jcr-and-mcr/"
    jcr = _body("Churchill College JCR", "jcr", page)
    mcr = _body("Churchill College MCR", "mcr", page)
    crosswalk = Crosswalk()
    first = resolve_records([jcr, mcr], crosswalk=crosswalk)
    assert _keys_by_name(first) == {
        "Churchill College JCR": "org-churchill-college-jcr",
        "Churchill College MCR": "org-churchill-college-mcr",
    }
    assert not first.report.held
    assert all(
        f"ref:society_website:{page}" not in entry.ids for entry in crosswalk.entries.values()
    )

    # The old crosswalk: the shared ref under both keys.
    for key in ("org-churchill-college-jcr", "org-churchill-college-mcr"):
        crosswalk.upsert(CrosswalkEntry(key=key, name=key, ids=[f"ref:society_website:{page}"]))
    again = resolve_records([jcr, mcr], crosswalk=crosswalk)
    assert not again.report.held
    assert _keys_by_name(again) == _keys_by_name(first)


def test_a_jcr_and_an_mcr_are_never_one_body() -> None:
    jcr = _body("Churchill Students", "jcr", "https://a.example/", website_domain="chu.example")
    mcr = _body("Churchill Students", "mcr", "https://b.example/", website_domain="chu.example")
    resolution = resolve_records([jcr, mcr])
    assert len(set(keys(resolution).values())) == 2
    assert not resolution.report.review  # different kinds of thing: nothing to review


def test_a_college_and_its_boat_club_sharing_a_site_need_no_review() -> None:
    college = org(
        "college_list", "Selwyn College", "Selwyn College", org_type="college", level="college",
        website_domain="https://www.sel.cam.ac.uk/",
    )  # fmt: skip
    boat = org(
        "cucbc", "selwyn", "Selwyn College Boat Club", org_type="college_boat_club",
        cucbc_club="Selwyn", college_hint="Selwyn", website_domain="https://www.sel.cam.ac.uk/",
    )  # fmt: skip
    crosswalk = Crosswalk()
    resolve_records([college, boat], crosswalk=crosswalk)
    again = resolve_records([college, boat], crosswalk=crosswalk)
    assert len(set(keys(again).values())) == 2
    assert not again.report.review


def test_jcrs_named_student_union_are_not_a_shared_club() -> None:
    caius = org(
        "society_website", "caius", "Gonville & Caius Student Union", org_type="jcr",
        level="college", college_hint="Caius",
    )  # fmt: skip
    jesus = org(
        "society_website", "jesus", "Jesus College Student Union", org_type="jcr",
        level="college", college_hint="Jesus",
    )  # fmt: skip
    resolution = resolve_records([caius, jesus])
    assert not [item for item in resolution.report.review if "several colleges" in item.reason]


def test_a_same_decision_merges_loaded_keys_and_retires_the_others() -> None:
    """Footlights: the SU's entry and Camdram's were loaded under two keys.
    Decided one: the first key is kept, the other is retired from the
    crosswalk, and while Convex still returns it nothing is held."""
    su = org("su_directory", "6661", "Footlights Dramatic Club (Cambridge)", su_id="6661")
    camdram = org(
        "camdram", "the-cambridge-footlights", "The Cambridge Footlights",
        camdram_slug="the-cambridge-footlights", org_type="theatre_company",
    )  # fmt: skip
    crosswalk = Crosswalk()
    before = keys(resolve_records([su, camdram], crosswalk=crosswalk))
    assert len(set(before.values())) == 2

    decisions = Decisions.model_validate(
        {
            "same": [
                {
                    "refs": ["camdram:the-cambridge-footlights", "su_directory:6661"],
                    "why": "the same club",
                }
            ]
        }
    )
    merged = resolve_records([su, camdram], crosswalk=crosswalk, decisions=decisions)
    kept = sorted(set(before.values()))[0]
    assert set(keys(merged).values()) == {kept}
    (review,) = [item for item in merged.report.review if "merged by decision" in item.reason]
    assert "removeEntity" in (review.detail or "")
    retired = (set(before.values()) - {kept}).pop()
    assert retired not in crosswalk

    # Convex still lists the retired row (its slug included) until it is removed.
    crosswalk.merge_remote(
        [CrosswalkRow(org_key=retired, name="The Cambridge Footlights",
                      camdram_slug="the-cambridge-footlights")]
    )  # fmt: skip
    again = resolve_records([su, camdram], crosswalk=crosswalk, decisions=decisions)
    assert set(keys(again).values()) == {kept}
    assert not again.report.held


def test_operator_claims_become_manual_claims_on_their_organisation() -> None:
    test_soc = org("su_directory", "16109", "Test Soc", su_id="16109")
    decisions = Decisions.model_validate(
        {
            "claims": [
                {
                    "ref": "su_directory:16109",
                    "field": "defunct",
                    "value": True,
                    "why": "The SU's own test entry.",
                    "decided": "2026-10-09",
                },
                {
                    "ref": "su_directory:99999",
                    "field": "defunct",
                    "value": True,
                    "why": "Gone.",
                    "decided": "2026-10-09",
                },
            ]
        }
    )
    resolution = resolve_records([test_soc], decisions=decisions)
    (manual,) = [r for r in resolution.records if r.source_type == "manual"]
    assert manual.entity_key == keys(resolution)["su_directory:16109"]
    (claim,) = manual.fields
    assert (claim.field, claim.value, claim.method) == ("defunct", True, "manual")
    assert claim.value_raw == "The SU's own test entry."
    assert manual.source_url.startswith("manual:")
    assert manual.retrieved_at == datetime(2026, 10, 9, tzinfo=UTC)
    assert any(
        "matches no keyed observation" in item.reason and item.refs == ["su_directory:99999"]
        for item in resolution.report.review
    )
    with pytest.raises(ValueError):
        Decisions.model_validate(
            {"claims": [{"ref": "x:1", "field": "nope", "value": 1, "why": "-",
                         "decided": "2026-10-09"}]}
        )  # fmt: skip


def test_a_decided_distinct_pair_is_not_flagged_as_similar() -> None:
    a = org("proctors_register", "vet", "Cambridge University Veterinary Society")
    b = org("su_directory", "27398", "International Veterinary Students Association", su_id="27398")
    flagged = resolve_records([a, b])
    assert any(item.reason == "similar names, not merged" for item in flagged.report.review)
    decided = resolve_records(
        [a, b],
        decisions=Decisions.model_validate(
            {"distinct": [{"refs": ["proctors_register:vet", "su_directory:27398"], "why": "-"}]}
        ),
    )
    assert not [item for item in decided.report.review if item.reason.startswith("similar")]


def test_one_company_is_one_counterpart_whatever_its_legal_form() -> None:
    from camsocs_pipeline.resolve.names import company_name

    assert company_name("McKinsey & Company, Inc. Prague") == (
        "McKinsey",
        ["McKinsey & Company, Inc. Prague"],
    )
    assert company_name("The Boston Consulting Group s.r.o. Prague Office") == (
        "Boston Consulting Group",
        ["The Boston Consulting Group s.r.o. Prague Office", "BCG"],
    )
    assert company_name("A.T. Kearney GmbH Prague office")[0] == "Kearney"
    assert company_name("Deloitte LLP") == ("Deloitte", ["Deloitte LLP"])
    # Names that merely contain such words stay whole.
    assert company_name("Ernst & Young") == ("Ernst & Young", [])
    assert company_name("AG Barr") == ("AG Barr", [])
