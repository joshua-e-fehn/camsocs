"""University of Cambridge Full Term dates (source-research §19).

Verified 2026-10-07 against the University's official page, which lists them
verbatim ("Full Term starts: Tuesday 6 October 2026" …). Do not extend this by
inference: add a year only after reading it on the official page, and update
§19 with the date checked.
"""

from __future__ import annotations

from camsocs_pipeline.models.wire import TermDate

SOURCE_URL = "https://www.cam.ac.uk/about-the-university/term-dates-and-calendars"

TERM_DATES: tuple[TermDate, ...] = (
    TermDate(
        academic_year="2026-27",
        term="michaelmas",
        full_term_start="2026-10-06",
        full_term_end="2026-12-04",
        source_url=SOURCE_URL,
    ),
    TermDate(
        academic_year="2026-27",
        term="lent",
        full_term_start="2027-01-19",
        full_term_end="2027-03-19",
        source_url=SOURCE_URL,
    ),
    TermDate(
        academic_year="2026-27",
        term="easter",
        full_term_start="2027-04-27",
        full_term_end="2027-06-18",
        source_url=SOURCE_URL,
    ),
    TermDate(
        academic_year="2027-28",
        term="michaelmas",
        full_term_start="2027-10-05",
        full_term_end="2027-12-03",
        source_url=SOURCE_URL,
    ),
    TermDate(
        academic_year="2027-28",
        term="lent",
        full_term_start="2028-01-18",
        full_term_end="2028-03-17",
        source_url=SOURCE_URL,
    ),
    TermDate(
        academic_year="2027-28",
        term="easter",
        full_term_start="2028-04-25",
        full_term_end="2028-06-16",
        source_url=SOURCE_URL,
    ),
)
