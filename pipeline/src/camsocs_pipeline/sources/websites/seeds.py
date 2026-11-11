"""Society websites no register states, each verified by hand as the
society's own, with the date checked.

Enrichment reads the website a register states (`enrich.targets_from`), and
`website_events` reads the events pages of the sites enrichment read. A
society whose SU profile has no website slot filled is therefore never
visited, though it publishes its programme on a site of its own. A seed
gives such an organisation its website:

- `enrich` reads it as if a register stated it (after any website a register
  does state, so a seed never replaces one), with every check a stated
  website gets (`enrich.own_site`, robots.txt, AI opt-outs);
- `website_events` reads its events pages from the first daily run, without
  waiting for the weekly enrichment.

Add one only after reading the site and tying it to the organisation by
something a register states (`found_on` says what), and name the owner by
identifiers a register carries (SU id, Instagram handle), never by name
alone. The seeds are Cambridge's: another campus reads none of them.
"""

from __future__ import annotations

from dataclasses import dataclass

from camsocs_pipeline.models.observation import IdentityHints
from camsocs_pipeline.resolve.lookup import OrgLookup


@dataclass(frozen=True)
class WebsiteSeed:
    """A society's own website (its home page) that no register states."""

    url: str
    owner: IdentityHints
    found_on: str
    checked: str


WEBSITE_SEEDS: tuple[WebsiteSeed, ...] = (
    WebsiteSeed(
        # "Cambridge Women in Law Society": the site's footer links
        # instagram.com/camwomeninlaw, the handle the society's SU profile
        # (cambridgesu.co.uk/organisation/26499/) gives; the profile has no
        # website. Its /events page lists the term's events as text (a
        # Squarespace page, no feed, no structured data).
        url="https://www.cambridgewomeninlaw.org/",
        owner=IdentityHints(
            name="Women in Law Society (Cambridge)",
            aliases=["Cambridge Women in Law Society", "CWLS"],
            su_id="26499",
            instagram_handle="camwomeninlaw",
        ),
        found_on="https://www.cambridgewomeninlaw.org/events",
        checked="2026-11-11",
    ),
)


def seeded_websites(
    index: OrgLookup, *, campus: str, seeds: tuple[WebsiteSeed, ...] | None = None
) -> dict[str, str]:
    """Organisation key → its seeded website, for the seeds whose owner
    `index` knows (an owner it cannot place is left out: the site is nobody's
    until a register lists the society). Cambridge's only."""
    if campus != "cam":
        return {}
    found: dict[str, str] = {}
    for seed in WEBSITE_SEEDS if seeds is None else seeds:
        key = index.reference_key(seed.owner)
        if key is not None:
            found.setdefault(key, seed.url)
    return found


__all__ = ["WEBSITE_SEEDS", "WebsiteSeed", "seeded_websites"]
