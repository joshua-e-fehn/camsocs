"""A disk cache of validated LLM replies, keyed by what was asked.

The `instagram` and `termcards` stages re-read the same posts and cards every
run (each run's staging file must hold the full current set, and the load
stage posts only the latest file). Asking the model again for an unchanged
caption or termcard would cost quota and could reword titles, which would mint
new event ids. So a reply is stored under
``var/cache/llm/<prompt_version>/<sha256(inputs)>.json`` and reused while the
inputs (and the prompt version) are unchanged.

The cache lives under `var/` (gitignored): replies may quote list mail.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)


def memo_key(*parts: str | bytes) -> str:
    """sha256 over the parts, length-prefixed so ("ab", "c") ≠ ("a", "bc")."""
    digest = hashlib.sha256()
    for part in parts:
        data = part.encode("utf-8") if isinstance(part, str) else part
        digest.update(f"{len(data)}:".encode())
        digest.update(data)
    return digest.hexdigest()


class LLMMemo:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, prompt_version: str, key: str) -> Path:
        return self.root / prompt_version / f"{key}.json"

    def get[T: BaseModel](
        self, prompt_version: str, key: str, schema: type[T]
    ) -> tuple[T, str] | None:
        """`(value, model)` of a cached reply, or None."""
        path = self._path(prompt_version, key)
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            return schema.model_validate(stored["value"]), str(stored["model"])
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, ValidationError) as error:
            logger.warning("Ignoring unreadable LLM cache entry %s (%s)", path, error)
            return None

    def put(self, prompt_version: str, key: str, value: BaseModel, model: str) -> None:
        path = self._path(prompt_version, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(
                {"model": model, "value": value.model_dump(mode="json")}, ensure_ascii=False
            ),
            encoding="utf-8",
        )
        temporary.replace(path)


__all__ = ["LLMMemo", "memo_key"]
