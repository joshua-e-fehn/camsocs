"""The LLM reply cache (`extract.memo`): entries written from several threads."""

from __future__ import annotations

import threading
from pathlib import Path

from pydantic import BaseModel

from camsocs_pipeline.extract.memo import LLMMemo, memo_key


class Reply(BaseModel):
    text: str


def test_one_key_stored_from_many_threads_at_once(tmp_path: Path) -> None:
    # The redaction pass asks the same text in parallel; every put of one key
    # must land, none may rename another's temporary file away.
    memo = LLMMemo(tmp_path)
    key = memo_key("the same text")
    errors: list[BaseException] = []
    start = threading.Barrier(16)

    def put(n: int) -> None:
        start.wait()
        try:
            for _ in range(20):
                memo.put("redact_names_v1", key, Reply(text=f"reply {n}"), "bulk-model-1")
        except BaseException as error:
            errors.append(error)

    threads = [threading.Thread(target=put, args=(n,)) for n in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    stored = memo.get("redact_names_v1", key, Reply)
    assert stored is not None and stored[0].text.startswith("reply ")
    assert list((tmp_path / "redact_names_v1").glob("*.tmp")) == []
