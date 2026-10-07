"""The 31 Cambridge colleges, their official names and the names students use.

A college is an organisation like any other (``orgType: college``, a
counterpart), but the resolver needs to recognise one in three places:

- a harvester's ``IdentityHints.college_hint`` ("Jesus", "Catz", "Gonville &
  Caius College") → the college's key, for ``collegeKeys`` claims;
- a college named inside a group's name ("Jesus College Boat Club", "Fitz
  Barbershop") → part of that group's identity, so the Jesus boat club never
  matches the Caius one or CUBC;
- a college anchor itself → one canonical key whatever a source calls it.

Official names are the University's college A–Z
(https://www.cam.ac.uk/colleges-and-departments/college-a-z, source-research
§8). The canonical key is ``keys.org_key(official name)``, e.g.
``org-gonville-and-caius-college``, so every stage that recognises a college
agrees on its key without having seen the colleges harvester's output.

Aliases are deliberately conservative: a nickname that is also an ordinary
word or surname used by other groups (``Robbo``, ``Pem``) is left out.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache

from camsocs_pipeline.keys import org_key


@dataclass(frozen=True)
class College:
    #: Stable short id used inside name signatures, e.g. ``caius``.
    id: str
    #: The University's official name.
    name: str
    #: Other names, as already-folded token strings (see `names.fold`).
    aliases: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return org_key(self.name)


COLLEGES: tuple[College, ...] = (
    College("christs", "Christ's College", ("christs",)),
    College("churchill", "Churchill College", ("churchill",)),
    College("clare", "Clare College", ("clare",)),
    College("clarehall", "Clare Hall", ("clare hall",)),
    College("corpus", "Corpus Christi College", ("corpus christi", "corpus")),
    College("darwin", "Darwin College", ("darwin",)),
    College("downing", "Downing College", ("downing",)),
    College("emmanuel", "Emmanuel College", ("emmanuel", "emma")),
    College("fitzwilliam", "Fitzwilliam College", ("fitzwilliam", "fitz")),
    College("girton", "Girton College", ("girton",)),
    College(
        "caius",
        "Gonville & Caius College",
        ("gonville and caius", "gonville caius", "caius"),
    ),
    College("homerton", "Homerton College", ("homerton",)),
    College("hughes", "Hughes Hall", ("hughes hall", "hughes")),
    College("jesus", "Jesus College", ("jesus",)),
    College("kings", "King's College", ("kings",)),
    College("lucy", "Lucy Cavendish College", ("lucy cavendish", "lucy cav")),
    College("magdalene", "Magdalene College", ("magdalene",)),
    College("murrayedwards", "Murray Edwards College", ("murray edwards", "new hall")),
    College("newnham", "Newnham College", ("newnham",)),
    College("pembroke", "Pembroke College", ("pembroke",)),
    College("peterhouse", "Peterhouse", ("peterhouse",)),
    College("queens", "Queens' College", ("queens",)),
    College("robinson", "Robinson College", ("robinson",)),
    College(
        "catharines",
        "St Catharine's College",
        ("st catharines", "saint catharines", "st catherines", "catz", "catharines"),
    ),
    College("edmunds", "St Edmund's College", ("st edmunds", "saint edmunds", "eddies")),
    College("johns", "St John's College", ("st johns", "saint johns", "johns")),
    College("selwyn", "Selwyn College", ("selwyn",)),
    College("sidney", "Sidney Sussex College", ("sidney sussex", "sidney")),
    College("trinity", "Trinity College", ("trinity",)),
    College("trinityhall", "Trinity Hall", ("trinity hall", "tit hall")),
    College("wolfson", "Wolfson College", ("wolfson",)),
)

BY_ID: dict[str, College] = {college.id: college for college in COLLEGES}
BY_KEY: dict[str, College] = {college.key: college for college in COLLEGES}


@cache
def alias_table() -> tuple[tuple[tuple[str, ...], str], ...]:
    """Every alias as a token tuple → college id, longest first, so "trinity
    hall" is matched before "trinity" and "clare hall" before "clare"."""
    rows: list[tuple[tuple[str, ...], str]] = []
    for college in COLLEGES:
        for alias in college.aliases:
            rows.append((tuple(alias.split()), college.id))
    rows.sort(key=lambda row: (-len(row[0]), row[0]))
    return tuple(rows)


__all__ = ["BY_ID", "BY_KEY", "COLLEGES", "College", "alias_table"]
