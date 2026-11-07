"""A dry-run `ConvexLoader` that records every payload it would post.

`RecordingLoader` is the loader in a dry run (nothing is sent, the suppression
list is empty, no image is uploaded) plus a log of each ingestion request:
its route and its payload as `keys.canonical_json` prints it (keys sorted at
every level, numbers as JavaScript prints them, None members skipped). The
loader golden master (`test_loader_golden`) compares that log to a committed
file, so any change to what the `load` stage posts for the same staging shows
up as a diff.
"""

from __future__ import annotations

from typing import Any

from camsocs_pipeline.keys import canonical_json
from camsocs_pipeline.pipeline.load import ConvexLoader


class RecordingLoader(ConvexLoader):
    """`ConvexLoader("", "", dry_run=True)` that keeps ``(path, canonical JSON)``
    of every `post`, in call order."""

    def __init__(self) -> None:
        super().__init__("", "", dry_run=True)
        self.posts: list[tuple[str, str]] = []

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, canonical_json(payload)))
        return super().post(path, payload)


__all__ = ["RecordingLoader"]
