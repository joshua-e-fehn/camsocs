"""Stage `talks_cam` (source-research §6 talks.cam lists — parser only, never the LLM).

The harvest logic lives in `camsocs_pipeline.events.talks_cam`; see its docstring.
"""

from camsocs_pipeline.events.talks_cam import run

__all__ = ["run"]
