"""`resolve.lookup.OrgLookup`: the one "which organisation is this?" every
stage after resolve uses — keyed staged observations plus the crosswalk."""

from __future__ import annotations

import respx

from camsocs_pipeline.models.observation import IdentityHints
from camsocs_pipeline.models.wire import CrosswalkRow
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.pipeline.load import ConvexLoader
from camsocs_pipeline.pipeline.report import RunReport, StageReport
from camsocs_pipeline.pipeline.state import SyncState
from camsocs_pipeline.resolve.crosswalk import Crosswalk
from camsocs_pipeline.resolve.lookup import (
    OrgLookup,
    domain_of,
    instagram_key,
    is_shared_domain,
    name_keys,
    sympa_list_name,
)
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import ORRERY_KEY, QUOKKA_KEY, known_orgs_records, org_observation


def test_small_normalisers() -> None:
    assert sympa_list_name("soc-cugs@lists.cam.ac.uk") == "soc-cugs"
    assert sympa_list_name("SOC-CUGS.lists.cam.ac.uk") == "soc-cugs"
    assert sympa_list_name("https://lists.cam.ac.uk/sympa/info/soc-cugs-news") == "soc-cugs-news"
    assert sympa_list_name("https://example.org/sympa/info/soc-x") is None
    assert instagram_key("https://www.instagram.com/cuqas_example/?hl=en") == "cuqas_example"
    assert instagram_key("@CUQAS.example") == "cuqas.example"
    assert instagram_key("https://www.instagram.com/p/AbC123/") is None
    assert instagram_key("https://example.org/cuqas") is None
    assert domain_of("Someone@Sub.Example.org") == "sub.example.org"
    assert domain_of("https://www.cuqas.example.org/about") == "cuqas.example.org"
    assert is_shared_domain("gmail.com") and is_shared_domain("jesus.cam.ac.uk")
    assert not is_shared_domain("cuqas.example.org")
    assert "german" not in name_keys("CU German Society")  # one short word is never a key
    assert "german-society" in name_keys("CU German Society")
    assert "german-society" in name_keys("Cambridge University German Society")
    assert "quidditch" in name_keys("Cambridge University Quidditch Club")


def test_lookups_by_list_address_domain_and_name() -> None:
    known = OrgLookup.from_records(known_orgs_records())
    assert len(known) == 2
    assert known.by_list("soc-cuqas.lists.cam.ac.uk") == QUOKKA_KEY
    # A sub-list resolves through its society component.
    assert known.by_list("soc-orrery-announce") == ORRERY_KEY
    assert known.by_list("soc-unknown") is None
    assert known.by_address("Committee@cuqas.example.org") == QUOKKA_KEY
    assert known.by_domain("events@cuqas.example.org") == QUOKKA_KEY
    assert known.by_domain("someone@gmail.com") is None
    assert known.by_name("Cambridge University Quokka Appreciation Society") == QUOKKA_KEY
    assert known.by_name("CUQAS") == QUOKKA_KEY
    assert known.by_name("CU Orrery Club") == ORRERY_KEY
    assert known.by_name("Some Other Club") is None


def test_ambiguity_matches_nobody() -> None:
    known = OrgLookup.from_records(
        [
            org_observation("org-a", "Alpha Chess Society", sympa_list="soc-chess"),
            org_observation("org-b", "Beta Chess Club", sympa_list="soc-chess"),
            org_observation("org-c", "Gamma Club", instagram="shared_handle"),
            org_observation("org-d", "Delta Club", instagram="shared_handle"),
        ]
    )
    assert known.by_list("soc-chess") is None
    assert known.instagram_targets() == []


def test_targets_and_termcards_come_from_claimed_values() -> None:
    known = OrgLookup.from_records(known_orgs_records())
    assert known.instagram_targets() == [(QUOKKA_KEY, "cuqas_example")]
    assert known.termcards() == [(ORRERY_KEY, "https://orrery.example.org/termcard")]
    assert known.get(QUOKKA_KEY).display_name == "Cambridge University Quokka Appreciation Society"


def test_from_staging_reads_every_latest_file(tmp_path) -> None:
    store = StagingStore(tmp_path)
    store.write("_resolved", "20261007T000000Z-aaaaaa", known_orgs_records()[:1])
    store.write("society_website", "20261007T000000Z-aaaaaa", known_orgs_records()[1:])
    known = OrgLookup.from_staging(store)
    assert set(known.orgs) == {QUOKKA_KEY, ORRERY_KEY}


def test_unkeyed_observations_are_ignored() -> None:
    record = org_observation("org-x", "X Society")
    record.entity_key = None
    assert len(OrgLookup.from_records([record])) == 0


# --- one reference lookup: staging and the crosswalk ------------------------------------------


def _convex_rows() -> list[CrosswalkRow]:
    return [
        CrosswalkRow.model_validate(
            {
                "orgKey": "org-german-society",
                "name": "CU German Society",
                "aliases": ["CUGS"],
                "collegeKeys": [],
                "isCounterpart": False,
                "suOrgId": "6789",
                "instagramHandle": "cugermansoc",
            }
        ),
        CrosswalkRow.model_validate(
            {
                "orgKey": "org-jesus-college",
                "name": "Jesus College",
                "aliases": [],
                "orgType": "college",
                "level": "college",
                "collegeKeys": [],
                "isCounterpart": True,
            }
        ),
    ]


def test_a_fresh_machine_finds_keys_the_server_holds() -> None:
    """No staging at all: the Convex crosswalk alone answers by SU id, by
    Instagram and by the name's signature."""
    crosswalk = Crosswalk()
    crosswalk.merge_remote(_convex_rows())
    lookup = OrgLookup(crosswalk)
    assert lookup.reference_key(IdentityHints(name="?", su_id="6789")) == "org-german-society"
    assert lookup.reference_key(IdentityHints(name="?", instagram_handle="@CUGermanSoc")) == (
        "org-german-society"
    )
    assert lookup.by_name("Cambridge University German Society") == "org-german-society"
    assert lookup.by_name("The German Society (CU)") == "org-german-society"
    # A college is found only when it is a known organisation.
    assert lookup.reference_key(IdentityHints(name="Jesus College")) == "org-jesus-college"
    assert OrgLookup().reference_key(IdentityHints(name="Jesus College")) is None


def test_names_two_known_organisations_share_resolve_to_nobody() -> None:
    lookup = OrgLookup.from_records(
        [
            org_observation("org-chess-club", "Cambridge University Chess Club"),
            org_observation("org-chess-society", "Chess Society"),
        ]
    )
    assert lookup.by_name("Chess") is None
    assert lookup.reference_key(IdentityHints(name="CU Chess")) is None


def test_a_dry_run_stage_reads_no_crosswalk_and_a_real_one_merges_it(
    make_settings, net: respx.MockRouter
) -> None:
    site = "https://happy-otter-123.convex.site"
    settings = make_settings(convex_http_url=site, pipeline_api_key="k")
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261007T000000Z-aaaaaa", known_orgs_records()
    )

    def ctx(dry_run: bool) -> StageContext:
        return StageContext(
            settings=settings,
            report=StageReport("events"),
            run=RunReport(run_key="20261008T000000Z-bbbbbb", command="sync", dry_run=dry_run),
            loader=ConvexLoader(site, "k", dry_run=dry_run, max_retries=0),
            state=SyncState(),
            staging=StagingStore(settings.staging_dir),
            dry_run=dry_run,
            limit=None,
        )

    dry = OrgLookup.for_stage(ctx(True))
    assert dry.by_name("CU German Society") is None
    assert dry.by_name("CUQAS") == QUOKKA_KEY

    net.post(f"{site}/api/pipeline/crosswalk").respond(
        200, json={"rows": [row.to_wire() for row in _convex_rows()], "isDone": True}
    )
    real = OrgLookup.for_stage(ctx(False))
    assert real.by_name("CU German Society") == "org-german-society"
    assert real.by_name("CUQAS") == QUOKKA_KEY

    net.post(f"{site}/api/pipeline/crosswalk").respond(404, json={"error": "not found"})
    stage = ctx(False)
    assert OrgLookup.for_stage(stage).by_name("CUQAS") == QUOKKA_KEY
    assert any("crosswalk from Convex unavailable" in note for note in stage.report.notes)
