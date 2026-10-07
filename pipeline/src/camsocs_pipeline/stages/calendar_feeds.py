"""Stage `calendar_feeds` (source-research §11 society ICS / Luma / Google feeds).

The harvest logic lives in `camsocs_pipeline.events.calendar_feeds`; see its docstring.
"""

from camsocs_pipeline.events.calendar_feeds import run

__all__ = ["run"]
