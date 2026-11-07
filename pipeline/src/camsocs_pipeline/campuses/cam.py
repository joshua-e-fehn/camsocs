"""The live campus: the University of Cambridge (`CAMBRIDGE`, decision D8).

Every value is today's constant, imported from the module that uses it, so
this profile cannot drift from what the pipeline does: Cambridge output stays
byte-identical (keys, URLs, staging paths, prompts…). The literals here are
the ones with no importable home (the prompt's wording inside an f-string in
`extract/when.py`, the alert script's link, the monitor's site checks, which
moved here so `monitor` can re-export them without an import cycle); each is
asserted against its source by tests/test_campuses.py.

Cambridge's own sources are the registry stages with ``campus="cam"``
(`stages/__init__.py`); its groups are `stages.GROUPS`.
"""

from __future__ import annotations

from types import MappingProxyType

from camsocs_pipeline.campuses.profile import (
    Branding,
    CampusProfile,
    MemberIdRule,
    NameRules,
    Paths,
    TermCalendar,
)
from camsocs_pipeline.config import (
    ABOUT_URL,
    DEFAULT_REPORTS_DIR,
    DEFAULT_STAGING_DIR,
    DOCUMENTED_USER_AGENT,
)
from camsocs_pipeline.events.common import LONDON
from camsocs_pipeline.events.ics import _CAMBRIDGE as _LOCATION
from camsocs_pipeline.extract import when
from camsocs_pipeline.resolve.crosswalk import DECISIONS_PATH
from camsocs_pipeline.resolve.names import _UNIVERSITY_SEQUENCES
from camsocs_pipeline.seeds.term_dates import SOURCE_URL, TERM_DATES
from camsocs_pipeline.sources import links
from camsocs_pipeline.stages import GROUPS, STAGES

#: The monitor's site checks (`monitor.SITE_CHECKS` re-exports this): a name
#: and a public page that must answer 200 (ENG-33).
SITE_CHECKS: tuple[tuple[str, str], ...] = (
    ("site_home", "https://camsocs.uk/"),
    ("site_societies", "https://camsocs.uk/societies"),
)

#: `ops/vps/camsocs-alert.py` `REQUESTS_INBOX` (a standalone root-owned
#: script, not importable from here; tests/test_campuses.py asserts equality).
REQUESTS_INBOX = "https://camsocs.uk/dashboard/requests"

CAMBRIDGE = CampusProfile(
    id="cam",
    name="University of Cambridge",
    short_name="Cambridge",
    timezone=LONDON.key,
    branding=Branding(
        product="CAMsocs",
        site_url="https://camsocs.uk",
        about_url=ABOUT_URL,
        user_agent=DOCUMENTED_USER_AGENT,
        monitor_urls=SITE_CHECKS,
        requests_inbox=REQUESTS_INBOX,
    ),
    terms=TermCalendar(
        names=tuple(when._TERM_PREFIX),
        codes=MappingProxyType(when._TERM_PREFIX),
        week_start_weekday=when._THURSDAY,
        min_week=when.MIN_TERM_WEEK,
        max_week=when.MAX_TERM_WEEK,
        dates=TERM_DATES,
        source_url=SOURCE_URL,
        prompt_place="Cambridge",
        prompt_hint="A student week runs Thursday to Wednesday.",
    ),
    member_ids=MemberIdRule(
        pattern=links.CRSID_PATTERN,
        domains=("cam.ac.uk",),
        excluded=("lists.cam.ac.uk",),
        forwarding_domains=links._CRSID_MAIL_DOMAINS,
        alumni_domains=links._ALUMNI_DOMAINS,
        strict_foreign_academic=False,
    ),
    names=NameRules(
        university_sequences=_UNIVERSITY_SEQUENCES,
        location_pattern=_LOCATION.pattern,
        self_tokens=frozenset(),
    ),
    university_domains=("cam.ac.uk",),
    has_colleges=True,
    stages=tuple(stage for stage in STAGES if stage.campus == "cam"),
    groups=GROUPS,
    paths=Paths(staging=DEFAULT_STAGING_DIR, reports=DEFAULT_REPORTS_DIR, decisions=DECISIONS_PATH),
)

__all__ = ["CAMBRIDGE", "REQUESTS_INBOX", "SITE_CHECKS"]
