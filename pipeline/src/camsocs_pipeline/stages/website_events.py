"""Stage `website_events` (source-research §14 "Events pages"): society
websites' events, calendar and term card pages → events (structured data
first, then the bulk model with dated-quote checks).

The logic lives in `camsocs_pipeline.sources.websites.events`; see its docstring. It
lives beside the enrichment code, not in `camsocs_pipeline.events`, because it
asks the LLM (the events package never does; `test_events_common`).
"""

from camsocs_pipeline.sources.websites.events import run

__all__ = ["run"]
