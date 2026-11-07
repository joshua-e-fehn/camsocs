"""A synthetic staging tree for the loader golden master (`test_loader_golden`).

Built only from the synthetic fixtures under ``fixtures/su``, ``fixtures/seed``
and ``fixtures/websites`` (plus a few events written out below), never from
talks fixtures: the parsers and harvest functions of today's stages read them
through a canned client (`tests.seedkit.FakeClient`, a fixed fetch time, no
network), and the observations are staged as the stages would stage them:

1. the harvest stages' source types, each under its stage's part
   (`su_directory`, `sport_clubs`, `camdram_societies`, `cucbc_clubs`,
   `colleges`);
2. ``_resolved``: the resolver over those, with an empty crosswalk and no
   operator decisions — so neither ``pipeline/resolve-decisions.json`` nor a
   local crosswalk can move the golden;
3. the enrichment's keyed ``society_website`` / ``linktree`` readings of the
   website fixtures, deterministic only (no model);
4. a few keyed website events organised by resolved organisations.

Everything is a pure function of the fixtures and the code under test, so the
same tree is built on every run and every machine.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from camsocs_pipeline.events.common import EventDraft, build_event_observation
from camsocs_pipeline.events.common import fetch_info as event_fetch_info
from camsocs_pipeline.models.observation import IdentityHints, Observation, OrganiserObs
from camsocs_pipeline.resolve.crosswalk import Crosswalk, Decisions
from camsocs_pipeline.resolve.resolver import resolve_records
from camsocs_pipeline.sources import camdram, colleges, cucbc, sport
from camsocs_pipeline.sources.observe import Harvest
from camsocs_pipeline.sources.policy import ROBOTS_OVERRIDE_NOTE
from camsocs_pipeline.sources.su import (
    DIRECTORY_URL,
    directory_observation,
    parse_directory,
    parse_profile,
    profile_observation,
    unavailable_profile_observation,
)
from camsocs_pipeline.sources.websites.enrich import Enricher
from camsocs_pipeline.sources.websites.site import Target
from camsocs_pipeline.staging.store import RESOLVED, StagingStore, is_events_directory
from tests.seedkit import FETCHED_AT, FakeClient, failed, ok

FIXTURES = Path(__file__).parent / "fixtures"
#: Every staged file carries this run key.
RUN_KEY = "20261007T120000Z-abcdef"
RETRIEVED_AT = datetime.fromisoformat(FETCHED_AT)

#: SU profile fixtures, by the society id in their names.
SU_PROFILES = {
    "10021": "profile_10021_stale_termcard.html",
    "11551": "profile_11551_cusu_no_description.html",
    "15759": "profile_15759_full.html",
    "20303": "profile_20303_role_emails.html",
    "6961": "profile_6961_linktree_mailchimp_chat.html",
    "9791": "profile_9791_cusu_termcard.html",
}
#: A listed profile that answers 404 (a `sources` row without claims).
SU_GONE = "cu3d"


def _text(*parts: str) -> str:
    return FIXTURES.joinpath(*parts).read_text(encoding="utf-8")


# --- harvest ----------------------------------------------------------------------------------


def su_observations() -> list[Observation]:
    """`su_directory` and `su_profile`, as the `su_directory` stage stages them.
    A listed society without a profile fixture of its own reads the fixtures
    in turn, in page order."""
    directory = ok(DIRECTORY_URL, _text("su", "directory.html"))
    entries = parse_directory(directory.text, directory.final_url)
    spare = sorted(SU_PROFILES.values())
    records: list[Observation] = [
        directory_observation(
            entry,
            directory,
            logo_allowed=entry.logo_url is not None or None,
            logo_note=ROBOTS_OVERRIDE_NOTE if entry.logo_url else None,
        )
        for entry in entries
    ]
    for index, entry in enumerate(entries):
        if entry.profile_url.rstrip("/").endswith(f"/{SU_GONE}"):
            page = failed(entry.profile_url, "not_found", 404)
            records.append(unavailable_profile_observation(entry, page))
            continue
        name = SU_PROFILES.get(entry.su_id) or spare[index % len(spare)]
        page = ok(entry.profile_url, _text("su", name))
        records.append(profile_observation(entry, parse_profile(page.text, page.final_url), page))
    return records


def seed_harvests() -> dict[str, Harvest]:
    """The seed harvest stages' harvest functions over their fixtures, by stage."""
    seed = FIXTURES / "seed"
    az = sport.AZ_URL
    final_az = "https://www.sport.cam.ac.uk/university-sports-clubs-0"
    sport_client = FakeClient(
        {
            az: ok(az, (seed / "sport_az.html").read_text(encoding="utf-8"), final_url=final_az),
            f"{final_az}/athletic-club": ok(
                f"{final_az}/athletic-club", (seed / "sport_club.html").read_text(encoding="utf-8")
            ),
            f"{final_az}/aikido-club": ok(
                f"{final_az}/aikido-club",
                (seed / "sport_club_lead.html").read_text(encoding="utf-8"),
            ),
        }
    )
    camdram_client = FakeClient(
        {
            camdram.SOCIETIES_URL: ok(
                camdram.SOCIETIES_URL,
                (seed / "camdram_societies.json").read_text(encoding="utf-8"),
                ctype="application/json",
            )
        }
    )
    details = "https://www.cucbc.org/node/86"
    lmbc = "https://www.ladymargaretboatclub.org/"
    cucbc_client = FakeClient(
        {
            cucbc.CLUBS_URL: ok(
                cucbc.CLUBS_URL, (seed / "cucbc_clubs.html").read_text(encoding="utf-8")
            ),
            details: ok(details, (seed / "cucbc_details.html").read_text(encoding="utf-8")),
            lmbc: ok(
                lmbc,
                "<html><body><p>The Lady Margaret Boat Club is the rowing club of "
                "St John’s College</p></body></html>",
            ),
        }
    )
    colleges_client = FakeClient(
        {
            colleges.COLLEGE_AZ_URL: ok(
                colleges.COLLEGE_AZ_URL, (seed / "college_az.html").read_text(encoding="utf-8")
            )
        }
    )
    return {
        "sport_clubs": sport.harvest(sport_client),
        "camdram_societies": camdram.harvest(camdram_client),
        "cucbc_clubs": cucbc.harvest(cucbc_client),
        # The first few JCR / MCR bodies: their pages are not in the client,
        # so each is read as the 404 it would be.
        "colleges": colleges.harvest(colleges_client, limit=3),
    }


def _stage_by_type(store: StagingStore, records: list[Observation], part: str) -> None:
    by_type: dict[str, list[Observation]] = {}
    for record in records:
        by_type.setdefault(record.source_type, []).append(record)
    for directory, rows in sorted(by_type.items()):
        store.write(directory, RUN_KEY, rows, part=part)


# --- enrichment -------------------------------------------------------------------------------

#: The website fixtures as enrichment targets (the keys a resolve would mint).
WEBSITES = (
    (
        Target(
            key="org-cambridge-university-algorithmic-trading-society",
            name="Cambridge University Algorithmic Trading Society",
            aliases=["CUATS"],
            level="university",
            website="https://www.cuats.co.uk/",
        ),
        "cuats_wordpress.html",
    ),
    (
        Target(
            key="org-st-catharine-s-college-jcr",
            name="St Catharine's College JCR",
            aliases=["Catz JCR"],
            org_type="jcr",
            level="college",
            college="St Catharine's College",
            website="https://www.catzjcr.com/",
        ),
        "catzjcr_squarespace.html",
    ),
    (
        Target(
            key="org-cambridge-university-athletic-club",
            name="Cambridge University Athletic Club",
            aliases=["CUAC"],
            level="university",
            sport_registered=True,
            website="https://www.cuac.org.uk/",
        ),
        "cuac_wix.html",
    ),
)
LINKTREE = Target(
    key="org-cambridge-university-example-society",
    name="Cambridge University Example Society",
    linktree="https://linktr.ee/cuexamplesoc",
)


def enrichment() -> tuple[list[Observation], list[Observation]]:
    """`society_website` and `linktree` readings, deterministic only (no model):
    links, structured data, role emails, platform and health."""
    pages = {
        target.website: ok(target.website, _text("websites", name))
        for target, name in WEBSITES
        if target.website
    }
    pages[LINKTREE.linktree or ""] = ok(
        LINKTREE.linktree or "", _text("websites", "linktree_synthetic.html")
    )
    enricher = Enricher(FakeClient(pages), None)  # type: ignore[arg-type]
    website: list[Observation] = []
    linktree: list[Observation] = []
    for target in [*(target for target, _name in WEBSITES), LINKTREE]:
        result = enricher.enrich(target)
        website += result.website
        linktree += result.linktree
    return website, linktree


# --- events -----------------------------------------------------------------------------------


def events(resolved: list[Observation]) -> list:
    """Three synthetic website events: one by a resolved organisation, one
    naming a visiting society of another university (the calendar-noise rules
    read it), and one whose description names a private person (the load's
    redaction replaces the name)."""
    names: dict[str, str] = {}
    for record in resolved:
        if record.entity_type == "organisation" and record.entity_key and record.identity.name:
            names.setdefault(record.entity_key, record.identity.name)
    keyed = sorted(names)
    host = keyed[0] if keyed else None
    guest = keyed[1] if len(keyed) > 1 else host

    def organisers(*keys: str | None) -> list[OrganiserObs]:
        return [
            OrganiserObs(identity=IdentityHints(name=names[key], known_key=key))
            for key in keys
            if key is not None
        ]

    page = "https://www.cuac.org.uk/events"
    drafts = [
        EventDraft(
            event_source="website",
            external_id=f"{page}#open-training",
            title="Open Training Evening",
            starts_at=datetime(2026, 10, 14, 17, 30, tzinfo=UTC),
            ends_at=datetime(2026, 10, 14, 19, 0, tzinfo=UTC),
            description="Everyone is welcome at our open training evening on the track.",
            page_url=page,
            venue=IdentityHints(name="Wilberforce Road Athletics Track"),
            event_type="sport",
            organisers=organisers(host),
        ),
        EventDraft(
            event_source="website",
            external_id=f"{page}#varsity-friendly",
            title="Friendly against Oxford University Athletic Club",
            starts_at=datetime(2026, 11, 7, 12, 0, tzinfo=UTC),
            description="A friendly fixture against Oxford University Athletic Club.",
            page_url=page,
            event_type="sport",
            organisers=organisers(host, guest),
        ),
        EventDraft(
            event_source="website",
            external_id=f"{page}#welcome-drinks",
            title="Welcome Drinks",
            starts_at=datetime(2026, 10, 9, 19, 0, tzinfo=UTC),
            description="Join us for welcome drinks. Questions to our president Jane Doe.",
            page_url=page,
            event_type="social",
            organisers=organisers(guest),
        ),
    ]
    fetched = ok(page, "<html><body>events</body></html>")
    return [
        build_event_observation(
            draft,
            source_type="society_website",
            source_url=page,
            retrieved_at=RETRIEVED_AT,
            evidence="primary",
            fetch=event_fetch_info(fetched),
        )
        for draft in drafts
    ]


# --- the tree ---------------------------------------------------------------------------------


def build(staging_dir: Path) -> StagingStore:
    """Stage the whole synthetic tree under `staging_dir` and return its store."""
    store = StagingStore(staging_dir)
    _stage_by_type(store, su_observations(), "su_directory")
    for stage, harvest in seed_harvests().items():
        _stage_by_type(store, harvest.observations, stage)

    # As the resolve stage reads them: every source directory, round-tripped
    # through staging, but no operator decision and no crosswalk.
    directories = [
        name for name in store.directories() if name != RESOLVED and not is_events_directory(name)
    ]
    records = [record for name in directories for record in store.read_latest(name)]
    resolution = resolve_records(
        records, crosswalk=Crosswalk(), decisions=Decisions(), run_key=RUN_KEY
    )
    store.write(RESOLVED, RUN_KEY, resolution.records)

    website, linktree = enrichment()
    store.write("society_website", RUN_KEY, website, part="enrich")
    store.write("linktree", RUN_KEY, linktree, part="enrich")

    resolved = [r for r in store.read_latest(RESOLVED) if isinstance(r, Observation)]
    store.write("society_website.events", RUN_KEY, events(resolved), part="website_events")
    return store


__all__ = ["RUN_KEY", "build"]
