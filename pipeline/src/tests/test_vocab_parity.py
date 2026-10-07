"""webapp/lib/vocab.ts is the source of truth; models/vocab.py mirrors it.

Parses every `export const NAME = [ "…", … ] as const` tuple in the TypeScript
file and asserts the Python module has the same tuple, values and order — and
no extra ones. Run in `pixi run test`, so drift fails CI on the Python side.
"""

from __future__ import annotations

import re

import pytest

from camsocs_pipeline.config import REPO_ROOT
from camsocs_pipeline.models import vocab
from camsocs_pipeline.pipeline.report import RUN_STATUSES, STAGE_STATUSES

VOCAB_TS = REPO_ROOT / "webapp" / "lib" / "vocab.ts"
TUPLE = re.compile(r"^export const ([A-Z_]+) = \[(.*?)\] as const", re.MULTILINE | re.DOTALL)
STRING = re.compile(r'"([^"]*)"')


def typescript_tuples() -> dict[str, tuple[str, ...]]:
    source = VOCAB_TS.read_text(encoding="utf-8")
    return {name: tuple(STRING.findall(body)) for name, body in TUPLE.findall(source)}


def python_tuples() -> dict[str, tuple[str, ...]]:
    return {
        name: value
        for name, value in vars(vocab).items()
        if name.isupper() and isinstance(value, tuple)
    }


def test_the_typescript_file_parses_into_many_tuples() -> None:
    tuples = typescript_tuples()
    assert len(tuples) > 40, "the parser no longer understands webapp/lib/vocab.ts"
    assert all(values for values in tuples.values())


@pytest.mark.parametrize("name", sorted(typescript_tuples()))
def test_each_typescript_tuple_is_mirrored_exactly(name: str) -> None:
    assert name in python_tuples(), f"models/vocab.py lacks {name}"
    assert python_tuples()[name] == typescript_tuples()[name]


def test_python_has_no_tuples_typescript_lacks() -> None:
    assert sorted(set(python_tuples()) - set(typescript_tuples())) == []


def test_run_log_vocabularies_match_too() -> None:
    assert RUN_STATUSES == vocab.HARVEST_RUN_STATUSES
    assert STAGE_STATUSES == vocab.HARVEST_STAGE_STATUSES


def test_fields_by_entity_type_covers_every_entity_type() -> None:
    assert set(vocab.FIELDS_BY_ENTITY_TYPE) == set(vocab.ENTITY_TYPES)
