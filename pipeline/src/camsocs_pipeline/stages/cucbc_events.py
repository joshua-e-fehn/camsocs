"""Stage `cucbc_events` (source-research §7 CUCBC calendar, Bumps and timetable).

The harvest logic lives in `camsocs_pipeline.events.cucbc`; see its docstring.
"""

from camsocs_pipeline.events.cucbc import run

__all__ = ["run"]
