"""The index of known organisations built from keyed staged observations."""

from __future__ import annotations

from camsocs_pipeline.known_orgs import (
    KnownOrgs,
    domain_of,
    instagram_handle,
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
    assert instagram_handle("https://www.instagram.com/cuqas_example/?hl=en") == "cuqas_example"
    assert instagram_handle("@CUQAS.example") == "cuqas.example"
    assert instagram_handle("https://www.instagram.com/p/AbC123/") is None
    assert instagram_handle("https://example.org/cuqas") is None
    assert domain_of("Someone@Sub.Example.org") == "sub.example.org"
    assert domain_of("https://www.cuqas.example.org/about") == "cuqas.example.org"
    assert is_shared_domain("gmail.com") and is_shared_domain("jesus.cam.ac.uk")
    assert not is_shared_domain("cuqas.example.org")
    assert "german" not in name_keys("CU German Society")  # one short word is never a key
    assert "german-society" in name_keys("CU German Society")
    assert "german-society" in name_keys("Cambridge University German Society")
    assert "quidditch" in name_keys("Cambridge University Quidditch Club")


def test_lookups_by_list_address_domain_and_name() -> None:
    known = KnownOrgs.from_records(known_orgs_records())
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
    known = KnownOrgs.from_records(
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
    known = KnownOrgs.from_records(known_orgs_records())
    assert known.instagram_targets() == [(QUOKKA_KEY, "cuqas_example")]
    assert known.termcards() == [(ORRERY_KEY, "https://orrery.example.org/termcard")]
    assert known.get(QUOKKA_KEY).display_name == "Cambridge University Quokka Appreciation Society"


def test_from_staging_reads_every_latest_file(tmp_path) -> None:
    store = StagingStore(tmp_path)
    store.write("_resolved", "20261007T000000Z-aaaaaa", known_orgs_records()[:1])
    store.write("society_website", "20261007T000000Z-aaaaaa", known_orgs_records()[1:])
    known = KnownOrgs.from_staging(store)
    assert set(known.orgs) == {QUOKKA_KEY, ORRERY_KEY}


def test_unkeyed_observations_are_ignored() -> None:
    record = org_observation("org-x", "X Society")
    record.entity_key = None
    assert len(KnownOrgs.from_records([record])) == 0
