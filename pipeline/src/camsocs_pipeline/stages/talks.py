"""Stage `talks` (docs/talks-redesign-spec.md §2–§4, decision D7 — parser
only, never the LLM; talks.cam at Crawl-delay 10).

The logic lives in `camsocs_pipeline.talks.stage`; see its docstring.
"""

from camsocs_pipeline.talks.stage import run

__all__ = ["run"]
