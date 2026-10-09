"""Feeds no harvested record lists yet, each verified by hand on the
organisation's own page (or the feed's own metadata), with the date checked.

The events stages read feeds from `orgInternal` identifiers in staging
(`resolve.lookup.OrgLookup.feeds`), which website enrichment fills.
These seeds cover the gap until it has run; a seed whose list or feed is also
discovered is fetched once. Add one only after reading it where `found_on`
says, and never guess a list id: talks.cam list ids change (source-research §6).
"""

from __future__ import annotations

from dataclasses import dataclass

from camsocs_pipeline.models.observation import IdentityHints


@dataclass(frozen=True)
class TalksSeed:
    """A talks.cam list a society runs (its organiser is the society)."""

    list_id: str
    owner: IdentityHints
    found_on: str
    checked: str


@dataclass(frozen=True)
class FeedSeed:
    """A calendar feed a society publishes: ``kind`` is ics / luma / google."""

    kind: str
    value: str
    owner: IdentityHints
    found_on: str
    checked: str


TALKS_SEEDS: tuple[TalksSeed, ...] = (
    TalksSeed(
        # "You can find all our talks on our Cambridge Talks page … or subscribe
        # to our ICS feed directly" → talks.cam.ac.uk/show/index/201664.
        list_id="201664",
        owner=IdentityHints(
            name="Cambridge University Astronomical Society",
            aliases=["CUAS", "CU Astronomical Society", "Astronomical Society"],
            website_domain="cuastronomy.co.uk",
        ),
        found_on="https://cuastronomy.co.uk/talks/",
        checked="2026-10-07",
    ),
)

FEED_SEEDS: tuple[FeedSeed, ...] = (
    FeedSeed(
        # The calendar of the society's Luma events (event page luma.com/es51jfvb
        # names it, `calendar_api_id`); the feed's PRODID names the society.
        # Re-checked 2026-10-09: luma.com/caish shows the calendar "Cambridge AI
        # Safety Hub" (slug caish) with this api_id, and the society's own site
        # (www.cambridgeaisafety.org) links lu.ma/caish — so the website domain
        # identifies the owner the resolver keyed from that site.
        kind="luma",
        value="cal-4TNl4yi3sVEcAO5",
        owner=IdentityHints(
            name="Cambridge AI Safety Hub",
            aliases=["CAISH"],
            website_domain="cambridgeaisafety.org",
        ),
        found_on="https://luma.com/caish",
        checked="2026-10-09",
    ),
)


__all__ = ["FEED_SEEDS", "TALKS_SEEDS", "FeedSeed", "TalksSeed"]
