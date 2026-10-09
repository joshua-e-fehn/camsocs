"""Playwaze college leagues → match events (source-research §9; stage `playwaze`).

Re-verified 2026-10-07:

- ``cambridgeuniversityleagues.playwaze.com`` robots.txt: ``user-agent: *`` /
  ``allow: /``. Its ``/Home`` redirects to an invitation / sign-in page, so it
  is **not** fetched (no sign-in walls) and cannot be used for discovery.
- ``public-cambridgeuniversityleagues.playwaze.com`` (the embed host Sport
  Cambridge links to): robots.txt ``disallow: /``. Never fetched; a league link
  on it is read on the main host, whose robots.txt allows it (robots.txt is
  per host).
- Discovery is therefore Sport Cambridge's college leagues A–Z page
  (`DISCOVERY_URL`, robots allows it), which links each league as
  ``…/<community slug>/<community id>/league-display/Leagues/<league id>``.
  On 2026-10-07 every link still pointed to a **2025-26** community.

**Season roll-over.** Community slugs end in their season ("…-netball-25-26",
or cut short as "…-union-25-"). A community whose season is known and is not
the current academic year (1 July turnover; 2026-27 → ``26``) is skipped with
a note, not fetched: last season's fixtures are not this term's calendar. When the
A–Z page links 2026-27 communities, they are read with no code change.

**Fixtures.** The league page (GET, main host) names the league, its divisions
(``data-value2="LeagueDivisions/…"``) and the community's ``BaseCommunityId``.
The fixture list itself is loaded by the page's own script with a form POST to
``fixture-fixturelist`` (``page``, ``pageSize``, ``request[BaseCommunityId]``,
``request[CompetitionIds]``, ``isDashboard``); the stage sends the same POST
once per division (`PoliteClient.post_form`: robots, pacing and cache as for
any fetch). The answer groups fixtures under a date header ("19 October 2025")
and gives each fixture's id (``data-id``), teams, venue and kick-off time.

**Events.** One ``match`` per fixture: "<home> v <away>", the league and
division as the description, kick-off in London time (all-day when the time is
not set), venue text, the fixture page as `sourceUrl`. Both teams are organiser
hints (team names such as "Pembroke Mixed 1st" — college teams, phase 2 of the
scope); unresolved ones stay in ``unresolved_organisers``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from urllib.parse import urljoin, urlsplit

from selectolax.lexbor import LexborHTMLParser

from camsocs_pipeline.events.common import (
    LONDON,
    EventDraft,
    EventWindow,
    Sourced,
    Tally,
    default_window,
    describe_failure,
    london_midnight,
    london_today,
    observations_from,
    polite_client,
    write_staging,
)
from camsocs_pipeline.models.observation import IdentityHints, OrganiserObs
from camsocs_pipeline.pipeline.context import StageContext
from camsocs_pipeline.resolve.lookup import OrgLookup

HOST = "cambridgeuniversityleagues.playwaze.com"
BASE = f"https://{HOST}"
DISCOVERY_URL = "https://www.sport.cam.ac.uk/college-sport/college-leagues-z"
SOURCE_TYPE = "playwaze"
EVENT_SOURCE = "playwaze"
EVIDENCE = "secondary"
COVERS = frozenset({"venueText"})

_LEAGUE_LINK = re.compile(
    r"https?://(?:public-)?cambridgeuniversityleagues\.playwaze\.com/"
    r"(?P<slug>[A-Za-z0-9-]+)/(?P<community>[A-Za-z0-9]+)/league-display/Leagues/"
    r"(?P<league>[A-Za-z0-9]+)"
)
_SEASON = re.compile(r"-(?P<start>\d{2})-(?P<end>\d{2})?$")
_BASE_COMMUNITY = re.compile(r'"BaseCommunityId"\s*:\s*"(?P<id>[^"]+)"')
_FIXTURE_URL = re.compile(r'FixturePageURL\s*=\s*"(?P<url>/[^"]+)"')
_DIVISION = re.compile(r'data-value2="(?P<id>LeagueDivisions/[^"]+)"')
_DATE = re.compile(r"(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]+)\s+(?P<year>\d{4})")
_CLOCK = re.compile(r"^(?P<h>\d{1,2}):(?P<m>\d{2})$")
_MONTHS = {
    m: n
    for n, m in enumerate(
        (
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ),
        start=1,
    )
}


@dataclass(frozen=True)
class LeagueRef:
    slug: str
    community_id: str
    league_id: str

    @property
    def url(self) -> str:
        """The league page on the main host (robots allows it there)."""
        return f"{BASE}/{self.slug}/{self.community_id}/league-display/Leagues/{self.league_id}"

    @property
    def season(self) -> str | None:
        """The season's first two digits ("25" for 2025-26), if the slug says."""
        match = _SEASON.search(self.slug)
        return match["start"] if match else None


@dataclass
class LeaguePage:
    title: str | None
    base_community_id: str | None
    fixture_path: str | None
    divisions: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Fixture:
    id: str
    day: date
    kick_off: time | None
    home: str
    away: str
    venue: str | None
    url: str | None


def current_season(today: date) -> str:
    """Two-digit start year of the academic year (1 July turnover)."""
    start = today.year if today.month >= 7 else today.year - 1
    return f"{start % 100:02d}"


def parse_league_links(html: str) -> list[LeagueRef]:
    found = dict.fromkeys(
        LeagueRef(m["slug"], m["community"], m["league"]) for m in _LEAGUE_LINK.finditer(html)
    )
    return list(found)


def parse_league_page(html: str) -> LeaguePage:
    tree = LexborHTMLParser(html)
    title_node = tree.css_first("title")
    title = " ".join(title_node.text().split()) if title_node is not None else None
    if title:
        title = re.sub(r"^Playwaze\s*-\s*", "", title)
        title = re.sub(r"\s+Tables$", "", title)
    divisions: list[tuple[str, str]] = []
    for node in tree.css("[data-value2]"):
        division_id = node.attributes.get("data-value2") or ""
        if division_id.startswith("LeagueDivisions/") and all(
            d != division_id for d, _ in divisions
        ):
            divisions.append((division_id, " ".join(node.text().split()) or division_id))
    base = _BASE_COMMUNITY.search(html)
    fixtures = _FIXTURE_URL.search(html)
    return LeaguePage(
        title=title,
        base_community_id=base["id"] if base else None,
        fixture_path=fixtures["url"] if fixtures else None,
        divisions=divisions,
    )


def _day(text: str) -> date | None:
    match = _DATE.search(text)
    if not match:
        return None
    month = _MONTHS.get(match["month"].lower())
    if month is None:
        return None
    try:
        return date(int(match["year"]), month, int(match["day"]))
    except ValueError:
        return None


def _text(node: object) -> str | None:
    if node is None:
        return None
    value = " ".join(node.text(separator=" ").split())  # type: ignore[attr-defined]
    return value or None


def parse_fixtures(html: str, base: str = BASE) -> list[Fixture]:
    tree = LexborHTMLParser(f"<body>{html}</body>")
    fixtures: list[Fixture] = []
    for group in tree.css(".fixture-list-group"):
        day = _day(_text(group.css_first(".fixture-list-header-date")) or "")
        if day is None:
            continue
        kick_offs: dict[str, time] = {}
        for mobile in group.css("a.fixtureListItemMobile"):
            clock = _CLOCK.match(_text(mobile.css_first(".fixture-list-time")) or "")
            if clock and int(clock["h"]) < 24 and int(clock["m"]) < 60:
                kick_offs[mobile.attributes.get("data-id") or ""] = time(
                    int(clock["h"]), int(clock["m"])
                )
        for item in group.css("a.fixtureListItem"):
            fixture_id = item.attributes.get("data-id") or ""
            teams = [t for t in (_text(n) for n in item.css(".fixtureListItem-teamName")) if t]
            if not fixture_id or len(teams) != 2:
                continue
            venue = _text(item.css_first(".fixtureListItem-venue"))
            href = item.attributes.get("href")
            fixtures.append(
                Fixture(
                    id=fixture_id,
                    day=day,
                    kick_off=kick_offs.get(fixture_id),
                    home=teams[0],
                    away=teams[1],
                    venue=venue if venue and venue not in ("—", "-") else None,
                    url=urljoin(base, href) if href else None,
                )
            )
    return fixtures


def fixture_form(base_community_id: str, division_id: str) -> dict[str, str]:
    return {
        "page": "1",
        "pageSize": "1024",
        "request[BaseCommunityId]": base_community_id,
        "request[CompetitionIds]": division_id,
        "isDashboard": "false",
    }


def fixture_draft(fixture: Fixture, *, league: str | None, division: str | None) -> EventDraft:
    if fixture.kick_off is not None:
        start = datetime.combine(fixture.day, fixture.kick_off, tzinfo=LONDON)
        end, all_day = None, False
    else:
        start = london_midnight(fixture.day)
        end, all_day = london_midnight(fixture.day + timedelta(days=1)), True
    label = " – ".join(part for part in (league, division) if part)
    return EventDraft(
        event_source=EVENT_SOURCE,
        external_id=fixture.id,
        title=f"{fixture.home} v {fixture.away}",
        starts_at=start,
        ends_at=end,
        all_day=all_day,
        description=label or None,
        page_url=fixture.url,
        venue=IdentityHints(name=fixture.venue) if fixture.venue else None,
        event_type="match",
        organisers=[
            OrganiserObs(identity=IdentityHints(name=team, level="college"), role="organiser")
            for team in (fixture.home, fixture.away)
        ],
        covers=COVERS,
    )


def run(
    ctx: StageContext, *, window: EventWindow | None = None, now: datetime | None = None
) -> None:
    window = window or default_window(now)
    index = OrgLookup.for_stage(ctx)
    tally = Tally()
    season = current_season(london_today(now))
    pending: list[Sourced] = []
    with polite_client(ctx.settings) as client:
        discovery = client.fetch(DISCOVERY_URL)
        if not discovery.ok:
            raise RuntimeError(f"league list not fetched: {describe_failure(discovery)}")
        leagues = parse_league_links(discovery.text)
        current = [league for league in leagues if league.season in (season, None)]
        stale = sorted({league.slug for league in leagues if league.season not in (season, None)})
        if stale:
            ctx.report.notes.append(
                f"{len(stale)} linked communities are not 20{season}-{int(season) + 1:02d} "
                f"(roll-over pending; skipped): {', '.join(stale)}"
            )
        if ctx.limit is not None:
            current = current[: ctx.limit]
        for league in current:
            page_result = client.fetch(league.url)
            if not page_result.ok:
                ctx.report.notes.append(f"league page: {describe_failure(page_result)}")
                continue
            page = parse_league_page(page_result.text)
            if not page.base_community_id or not page.fixture_path:
                ctx.report.notes.append(f"league page without a fixture list: {league.url}")
                continue
            fixture_url = urljoin(BASE, page.fixture_path)
            if urlsplit(fixture_url).netloc != HOST:
                continue
            for division_id, division in page.divisions:
                result = client.post_form(
                    fixture_url, fixture_form(page.base_community_id, division_id)
                )
                if not result.ok:
                    ctx.report.notes.append(f"fixtures: {describe_failure(result)}")
                    continue
                for fixture in parse_fixtures(result.text):
                    draft = fixture_draft(fixture, league=page.title, division=division)
                    pending.append(Sourced(draft, league.url, result))
    records = observations_from(
        pending, window, tally, source_type=SOURCE_TYPE, evidence=EVIDENCE, index=index, now=now
    )
    write_staging(ctx, records, tally)


__all__ = [
    "Fixture",
    "LeagueRef",
    "current_season",
    "fixture_draft",
    "fixture_form",
    "parse_fixtures",
    "parse_league_links",
    "parse_league_page",
    "run",
]
