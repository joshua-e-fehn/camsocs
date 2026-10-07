"""Identity resolution (T4): which staged observations are one organisation,
and under which stable key. See `resolver.py`."""

from camsocs_pipeline.resolve.crosswalk import Crosswalk, CrosswalkEntry, Decisions, Match
from camsocs_pipeline.resolve.identity import Identity, identity_of
from camsocs_pipeline.resolve.resolver import (
    QuarantineItem,
    QuarantineReport,
    Resolution,
    Resolver,
    resolve_records,
)

__all__ = [
    "Crosswalk",
    "CrosswalkEntry",
    "Decisions",
    "Identity",
    "Match",
    "QuarantineItem",
    "QuarantineReport",
    "Resolution",
    "Resolver",
    "identity_of",
    "resolve_records",
]
