"""A new venue's name without the institution or city suffix OpenStreetMap
gives it ("Trinity Hall (University of Cambridge)" → "Trinity Hall",
"Corn Exchange, Cambridge" → "Corn Exchange"); docs/locations-and-map.md §1a.

The mirror of webapp/lib/venue-name.ts: both are held to
webapp/lib/venue-name.fixtures.json. A name that is only the suffix
("University of Cambridge", "Cambridge") is left whole. Keys are never
minted from the result.
"""

from __future__ import annotations

import re

# Whitespace, spelled out: Python's \s / str.strip() and JS's \s / trim()
# Whitespace, spelled out: Python's \\s / str.strip() and JS's \\s / trim()
# disagree on a few characters (U+FEFF, U+001C-U+001F, U+0085), so both
# helpers use this set (JS's own) and nothing else.
_WS = r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
_TRIM = re.compile(rf"^{_WS}+|{_WS}+$")
_PLACE = rf"(?:the{_WS}+)?(?:university{_WS}+of{_WS}+cambridge|cambridge{_WS}+university|cambridge)"
_SUFFIX = re.compile(
    rf"(?:{_WS}*\({_WS}*{_PLACE}{_WS}*\)|{_WS}*,{_WS}*{_PLACE}|{_WS}+[-–—]{_WS}*{_PLACE}){_WS}*$",
    re.IGNORECASE,
)
_WORDY = re.compile(r"[^\W_]")


def _trim(text: str) -> str:
    return _TRIM.sub("", text)


def venue_display_name(name: str) -> str:
    """`name` without trailing "(University of Cambridge)", ", Cambridge",
    " - University of Cambridge" and the like."""
    shown = _trim(name)
    while True:
        match = _SUFFIX.search(shown)
        if match is None:
            return shown
        rest = _trim(shown[: match.start()])
        if not rest or not _WORDY.search(rest):
            return shown
        shown = rest
